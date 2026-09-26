// The platform registry, and the proof that the composition root uses it: one delivery
// request becoming one real platform toast, and one real failure becoming something
// `doctor` can read (NT-FR-01, NT-FR-02, NT-FR-09, APX-CON-06, APX-FR-02, APX-CON-12,
// HC-FR-07, HC-FR-09).
//
//   npm test -- tests/notify/registry-selection.test.ts
//
// THE ACCEPTANCE CRITERIA THIS FILE CARRIES
//
//   - "A test asserts the main entry point constructs the platform notifier and the
//     delivery pipeline uses it."
//     The second half of this file, over a real socket against a hub started by the real
//     entry point: a posted block is stored, becomes exactly one delivery attempt, and
//     that attempt reaches a real process on this machine - a stub `notify-send` placed
//     at the front of PATH that prints the argv a real process received. No notifier is
//     injected, no delivery is faked, and the assertion is on the argument list the
//     operating system was handed rather than on what this repository believes it passed.
//     The wiring is also asserted from both ends: `delivery.wired` would be false without
//     the composition root constructing a notifier, and a second hub over the same log
//     proves the restart replay reaches the same notifier a fresh block does.
//
//   - "A test asserts a non-zero exit from the notifier is recorded as a failure with a
//     reason rather than swallowed."
//     A real stub exiting 1, a real delivery over a real socket, and the failure visible
//     in all three places an operator could look: the policy's own ledger, the health
//     payload `doctor` reads, and the toast counter - which does *not* move, because a
//     failure is not a delivery (APX-FR-02, ADR-010, PRD 11).
//
//   - the registry answers for every platform rather than throwing: one notifier for
//     Linux, an explicit "not implemented yet" for macOS and Windows, and an explicit
//     "unsupported" for anything else (APX-CON-06). The two not-implemented answers are
//     different tokens because they mean different things to an operator.
//
// WHAT IS NOT PROVEN HERE
// That a real desktop shows the toast, and that a real desktop honours the resident hint.
// The stubs and the tool's own parser are as far as an automated suite can go without a
// notification service to talk to; PRD 16 Open Question 2 stays a question until NT-4's
// human gate watches one (APX-CON-06). The macOS and Windows notifiers are not in this
// build and are NOT live-verified on the authoring machine: they are NT-2, with a
// runbook and a human gate that has to run on those platforms (NT-FR-03, NT-FR-04, NT-5).

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DeliveryStatus, Notifier as HubNotifier } from '@/hub/delivery'
import type { HealthPayload } from '@/hub/routes/read'
import type { MetricsPayload } from '@/hub/routes/metrics'
import { startHub, type RunningHub, type StartHubOptions } from '@/main/index'
import { openEventStore, type EventStore } from '@/storage/eventStore'
import { planNotification } from '@/notify/policy'
import {
  IMPLEMENTED_NOTIFY_PLATFORMS,
  NOTIFY_PLATFORMS,
  createPlatformNotifier,
  resolveNotifyPlatform,
  toNotifierPort,
  type ComposedNotifier,
} from '@/notify/registry'
import { NOTIFY_SEND } from '@/notify/linux'
import { NotificationFailedError, type NotificationCommand, type NotificationRequest } from '@/notify/types'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * The product's platform names beside Node's.
 *
 * The registry speaks `process.platform`, so it takes `darwin` where the rest of this
 * product says `macos` (APX-CON-06). The correspondence is pinned here in both directions
 * because it is the kind of thing NT-2 gets wrong by assumption: a notifier written for
 * the string `macos` would never be selected by a machine that reports `darwin`.
 */
const NODE_PLATFORM_NAMES: Readonly<Record<(typeof NOTIFY_PLATFORMS)[number], string>> = {
  linux: 'linux',
  macos: 'darwin',
  windows: 'win32',
}

/**
 * A port band of this suite's own.
 *
 * The real-process suites in tests/hub each own a band, and they run in parallel: two
 * suites sharing a band is a flake that looks like a bug in whichever assertion lost the
 * race (HC-5 recorded the same lesson).
 */
const NOTIFY_PORT_BASE = 43_717

const SESSION = 'ses_notify_01'
const REPO = 'agent-ping'
const REPO_PATH = '/home/dev/Projects/agent-ping'
const OCCURRED_AT = '2026-09-26T09:00:00.000Z'

const temporaryDirectories: string[] = []
const openHubs: RunningHub[] = []
const openStores: EventStore[] = []

function temporaryDirectory(prefix = 'agent-ping-notify-state-'): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  for (const hub of openHubs.splice(0)) {
    await hub.close().catch(() => undefined)
  }
  for (const store of openStores.splice(0)) store.close()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/** A stub `notify-send` that records its argv and exits with a code a test chooses. */
function stubNotifySend(exit: number): string {
  const directory = temporaryDirectory('agent-ping-notify-bin-')
  const recordFile = path.join(directory, 'argv.txt')
  writeFileSync(
    path.join(directory, NOTIFY_SEND),
    [
      '#!/bin/sh',
      `for arg in "$@"; do printf '%s\\0' "$arg" >> '${recordFile}'; done`,
      "printf '%s\\n' 'stub: the notification server refused this' >&2",
      `exit ${String(exit)}`,
      '',
    ].join('\n'),
  )
  chmodSync(path.join(directory, NOTIFY_SEND), 0o755)
  return directory
}

/**
 * Put a directory at the front of PATH for one block, and put PATH back afterwards.
 *
 * Prepended rather than replaced, because a stub has to win against the installed tool and
 * the test may still want the machine's own `sleep` or `sh` - and restored in a `finally`
 * whether the block resolved or threw, because a suite that leaves a stub first on PATH
 * would change what every test after it executes. `withOnlyPath` is the other direction,
 * for the one claim that needs nothing on PATH at all.
 */
async function withPath<T>(directory: string, body: () => Promise<T>): Promise<T> {
  const original = process.env['PATH']
  if (original === undefined) throw new Error('this suite needs a PATH to prepend to')
  process.env['PATH'] = `${directory}:${original}`
  try {
    return await body()
  } finally {
    process.env['PATH'] = original
  }
}

/** Replace PATH outright, for the "the tool is not installed" case. */
async function withOnlyPath<T>(value: string, body: () => Promise<T>): Promise<T> {
  const original = process.env['PATH']
  process.env['PATH'] = value
  try {
    return await body()
  } finally {
    if (original === undefined) delete process.env['PATH']
    else process.env['PATH'] = original
  }
}

/** Every argument a real stub was handed, in order, across every invocation. */
function stubArgv(directory: string): string[] {
  const recordFile = path.join(directory, 'argv.txt')
  if (!existsSync(recordFile)) return []
  return readFileSync(recordFile, 'utf8').split('\0').slice(0, -1)
}

/** One block: the only class that leaves the app (EL-FR-07). */
function blockBody(transitionId = 'block-1'): Record<string, unknown> {
  return {
    harness: 'opencode',
    eventName: 'permission.asked',
    sessionId: SESSION,
    repoFullPath: REPO_PATH,
    transitionId,
    occurredAt: OCCURRED_AT,
  }
}

/** An idle transition that worked: the finished class. */
function finishedBody(transitionId = 'idle-1'): Record<string, unknown> {
  return {
    harness: 'opencode',
    eventName: 'session.status',
    variant: 'idle',
    sessionId: SESSION,
    repoFullPath: REPO_PATH,
    transitionId,
    occurredAt: OCCURRED_AT,
    turnWork: { toolCall: true, fileEdit: false, todoUpdate: false },
  }
}

interface Fetched {
  readonly status: number
  readonly text: string
  json<T = unknown>(): T
}

function call(origin: string, method: string, pathname: string, body?: unknown): Promise<Fetched> {
  const { hostname, port } = new URL(origin)
  const payload = body === undefined ? undefined : JSON.stringify(body)
  return new Promise<Fetched>((resolve, reject) => {
    const outgoing = request(
      {
        host: hostname,
        port,
        path: pathname,
        method,
        headers: {
          'content-type': 'application/json',
          ...(payload === undefined ? {} : { 'content-length': String(Buffer.byteLength(payload)) }),
        },
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve({ status: response.statusCode ?? 0, text, json: <T,>(): T => JSON.parse(text) as T })
        })
      },
    )
    outgoing.on('error', reject)
    if (payload === undefined) outgoing.end()
    else outgoing.end(payload)
  })
}

/** A hub started by the real entry point, with no notifier injected. */
async function startFixtureHub(stateDir: string, overrides: Partial<StartHubOptions> = {}): Promise<RunningHub> {
  const hub = await startHub({
    stateDir,
    dashboardRoot: null,
    preferredPort: NOTIFY_PORT_BASE,
    // A test hub is not a process that should react to this runner's signals.
    lifecycle: { installSignals: false },
    ...overrides,
  })
  openHubs.push(hub)
  return hub
}

function deliveryOf(health: HealthPayload): DeliveryStatus {
  return health.delivery
}

// ---------------------------------------------------------------------------
// Which notifier
// ---------------------------------------------------------------------------

describe('the registry answers for every platform, and never throws', () => {
  it('normalises the three supported platforms and treats anything else as other', () => {
    // `process.platform` is a small closed set on the three platforms agent-ping supports,
    // so this is a three-way match with one honest fallback. Guessing - treating Cygwin as
    // Windows, say - would mean delivering a notification with a tool nobody has run.
    expect(resolveNotifyPlatform('linux')).toBe('linux')
    expect(resolveNotifyPlatform('darwin')).toBe('macos')
    expect(resolveNotifyPlatform('win32')).toBe('windows')
    for (const other of ['freebsd', 'aix', 'sunos', 'android', 'cygwin', 'msys', '', '  ', undefined]) {
      expect(resolveNotifyPlatform(other), other).toBe('other')
    }
  })

  it('is tolerant of how a platform string was spelled', () => {
    expect(resolveNotifyPlatform('Linux')).toBe('linux')
    expect(resolveNotifyPlatform('  DARWIN ')).toBe('macos')
    expect(resolveNotifyPlatform('WIN32')).toBe('windows')
  })

  it('gives Linux a notifier and names which one', () => {
    const resolution = createPlatformNotifier({ platform: 'linux' })
    expect(resolution).toMatchObject({
      supported: true,
      platform: 'linux',
      reason: 'linux-notifier',
    })
    if (!resolution.supported) throw new Error('expected a supported platform')
    expect(typeof resolution.notifier).toBe('function')
  })

  it('says macOS and Windows are not implemented yet, rather than throwing or lying', () => {
    // Two tokens rather than one, because the two cases mean different things to an
    // operator: agent-ping intends to run on those platforms, and their notifiers arrive
    // in NT-2. Reporting them as unsupported would tell a macOS developer the product
    // does not support their machine (APX-CON-06).
    for (const platform of ['darwin', 'win32']) {
      const resolution = createPlatformNotifier({ platform })
      expect(resolution, platform).toMatchObject({
        supported: false,
        reason: 'not-implemented-for-this-platform',
        notifier: null,
      })
      expect(resolveNotifyPlatform(platform), platform).not.toBe('other')
    }
  })

  it('says a platform nobody supports is unsupported, with a third reason', () => {
    const resolution = createPlatformNotifier({ platform: 'freebsd' })
    expect(resolution).toMatchObject({
      supported: false,
      platform: 'other',
      reason: 'unsupported-platform',
      notifier: null,
    })
  })

  it('resolves exactly one notifier per implemented platform, and an answer for the rest', () => {
    // Enumerated from the two arrays rather than restated, so NT-2's addition of macOS and
    // Windows shows up as a change these assertions already cover. Two relations, both of
    // which have to hold: an implemented platform is one agent-ping supports, and the
    // resolution says `supported` exactly for the implemented ones - so there is never a
    // platform with a notifier nobody claims, or a claim with no notifier behind it.
    for (const platform of IMPLEMENTED_NOTIFY_PLATFORMS) {
      expect((NOTIFY_PLATFORMS as readonly string[]).includes(platform), platform).toBe(true)
    }
    for (const platform of NOTIFY_PLATFORMS) {
      // Asked for in Node's vocabulary, which is what the registry reads.
      const resolution = createPlatformNotifier({ platform: NODE_PLATFORM_NAMES[platform] })
      const implemented = (IMPLEMENTED_NOTIFY_PLATFORMS as readonly string[]).includes(platform)
      // ...and answered in the product's, which is what the rest of this product uses.
      expect(resolution.platform, platform).toBe(platform)
      expect(resolveNotifyPlatform(NODE_PLATFORM_NAMES[platform]), platform).toBe(platform)
      expect(resolution.supported, platform).toBe(implemented)
      expect(typeof resolution.notifier, platform).toBe(implemented ? 'function' : 'object')
      if (resolution.supported) expect(resolution.reason, platform).toBe(`${platform}-notifier`)
    }
  })

  it('does not throw for any string at all, including the empty one', () => {
    for (const platform of ['', ' ', 'Linux ', 'gnu/kfreebsd', 'aix', 'haiku', 'not-a-platform']) {
      expect(() => createPlatformNotifier({ platform }), platform).not.toThrow()
    }
  })

  it('defaults to the platform this process is running on', () => {
    // The composition root passes no platform, so the default is what production gets.
    const expected = resolveNotifyPlatform(process.platform)
    const resolution = createPlatformNotifier()
    expect(resolution.platform).toBe(expected)
    const implemented = (IMPLEMENTED_NOTIFY_PLATFORMS as readonly string[]).includes(expected)
    expect(resolution.supported).toBe(implemented)
  })

  it('probes without delivering, and says the same reason the resolution did', async () => {
    // A probe is for `install` and `doctor`: does this machine have a way to deliver? On a
    // platform with no notifier the answer is the resolution's own reason, and no process
    // is started at all.
    const implemented = createPlatformNotifier({ platform: 'linux' })
    expect((await implemented.probe()).platform).toBe('linux')
    const missing = createPlatformNotifier({ platform: 'darwin' })
    expect(await missing.probe()).toEqual({
      available: false,
      platform: 'macos',
      reason: 'not-implemented-for-this-platform',
    })
  })
})

// ---------------------------------------------------------------------------
// The boundary
// ---------------------------------------------------------------------------

describe('the port adapter is the only place a failure becomes a throw', () => {
  const request: NotificationRequest = {
    class: 'needs-you',
    title: REPO,
    body: 'A session is blocked and needs a decision from you.',
    urgency: 'critical',
    deepLink: `http://127.0.0.1:${NOTIFY_PORT_BASE}/?session=${SESSION}`,
    persistence: 'resident',
  }

  /** A composed notifier whose platform notifier answers with a fixed outcome. */
  function composedAnswering(status: 'delivered' | 'refused' | 'failed'): {
    readonly port: HubNotifier
    readonly diagnostics: string[]
  } {
    const diagnostics: string[] = []
    const run = (): Promise<{ code: number | null; signal: null; spawnError: null; stderr: string }> =>
      Promise.resolve(
        status === 'failed'
          ? { code: 1, signal: null, spawnError: null, stderr: 'the server refused it' }
          : { code: 0, signal: null, spawnError: null, stderr: '' },
      )
    const commands: NotificationCommand[] = []
    const resolution = createPlatformNotifier({
      platform: 'linux',
      run: (command) => {
        commands.push(command)
        return run()
      },
    })
    if (!resolution.supported) throw new Error('expected a supported platform')
    return {
      port: toNotifierPort(resolution.notifier, { onDiagnostic: (m) => diagnostics.push(m) }),
      diagnostics,
    }
  }

  const hubRequestFor = (eventClass: 'needs-you' | 'fyi'): Parameters<ComposedNotifier>[0] => ({
    event: {
      eventId: `evt_${eventClass}`,
      sessionId: SESSION,
      class: eventClass,
      subtype: null,
      rawEventType: 'permission.asked',
      occurredAt: OCCURRED_AT,
      receivedAt: OCCURRED_AT,
      dedupeKey: `opencode:${SESSION}:${eventClass}`,
      ackState: 'unacknowledged',
      resolutionState: 'unresolved',
    },
    class: eventClass,
    pendingCount: 1,
    repoShortName: REPO,
    origin: `http://127.0.0.1:${String(NOTIFY_PORT_BASE)}`,
    source: 'event',
  })

  it('resolves for a delivered outcome', async () => {
    const { port } = composedAnswering('delivered')
    await expect(Promise.resolve(port(hubRequestFor('needs-you')))).resolves.toBeUndefined()
  })

  it('resolves for a refusal, because a correct refusal is not a failure', async () => {
    // The hub's port has two answers, so a refusal resolves - and the cost of that, one
    // inflated `toast_deliveries`, is named in src/notify/registry.ts as a contract gap for
    // the hub owner rather than worked around here. What must not happen is a hub that
    // reports `degraded` for a routine fyi.
    const { port, diagnostics } = composedAnswering('refused')
    await expect(Promise.resolve(port(hubRequestFor('fyi')))).resolves.toBeUndefined()
    expect(diagnostics).toEqual([])
  })

  it('throws for a failure, carrying the reason and the exit code', async () => {
    // NT-FR-09: a failure is recorded with its reason, and the reason has to survive the
    // boundary - so the error carries the whole outcome rather than a flattened message
    // (APX-FR-02).
    const { port, diagnostics } = composedAnswering('failed')
    const thrown = await Promise.resolve(port(hubRequestFor('needs-you'))).then(
      () => null,
      (cause: unknown) => cause,
    )
    expect(thrown).toBeInstanceOf(NotificationFailedError)
    const error = thrown as NotificationFailedError
    expect(error.outcome).toMatchObject({
      status: 'failed',
      reason: 'command-failed',
      platform: 'linux',
      exitCode: 1,
      detail: 'the server refused it',
    })
    expect(error.message).toMatch(/command-failed, exit 1/)
    // Nothing from the notification is quoted into the message.
    expect(error.message).not.toContain('A session is blocked')
    expect(diagnostics.join('\n')).toMatch(/a delivery failed \(command-failed, exit 1\)/)
  })

  it('passes the same plan to the platform as the policy made', () => {
    // One class table, one plan: the hub's request becomes the four facts rendering needs
    // - class, repository short name, live origin, session identifier - and nothing else,
    // so no event field, pending count or source can reach a command line (APX-FR-01).
    const plan = planNotification({
      class: 'needs-you',
      repoShortName: REPO,
      origin: `http://127.0.0.1:${String(NOTIFY_PORT_BASE)}`,
      sessionId: SESSION,
    })
    expect(plan.kind).toBe('deliver')
    if (plan.kind !== 'deliver') throw new Error('expected a delivered plan')
    expect(plan.request).toEqual(request)
  })
})

// ---------------------------------------------------------------------------
// The composition root
// ---------------------------------------------------------------------------

describe('the main entry point constructs the platform notifier and delivers with it', () => {
  it('wires the registry, so a hub on a platform with a notifier is never unwired', async () => {
    // Portable half of the wiring claim: what the composition root built is whatever the
    // registry said, and the hub's `wired` is that answer and not something else.
    const hub = await startFixtureHub(temporaryDirectory())
    const expected = resolveNotifyPlatform(process.platform)
    expect(hub.notifier.platform).toBe(expected)
    const implemented = (IMPLEMENTED_NOTIFY_PLATFORMS as readonly string[]).includes(expected)
    expect(hub.delivery.wired).toBe(implemented)
    expect(hub.notifier.supported).toBe(implemented)
  })

  it('turns one posted block into one real notify-send invocation, with the exact arguments', async () => {
    // NT-1's acceptance criterion, over a real socket and a real process. Nothing is
    // injected: the hub builds the notifier, the policy calls it, and a stub `notify-send`
    // at the front of PATH is what the operating system actually ran.
    expect(resolveNotifyPlatform(process.platform)).toBe('linux')
    const stubDirectory = stubNotifySend(0)
    const stateDir = temporaryDirectory()

    const hub = await withPath(stubDirectory, async () => {
      const started = await startFixtureHub(stateDir)
      expect(started.delivery.wired).toBe(true)
      const posted = await call(started.origin, 'POST', '/api/ingest', blockBody())
      expect(posted.status).toBe(202)
      await started.ingest.idle()
      return started
    })

    // One block, one command, and the argument list a real process received - asserted as
    // the array it is, not as a rendering of it.
    expect(stubArgv(stubDirectory)).toEqual([
      '--app-name=agent-ping',
      '--urgency=critical',
      '--expire-time=0',
      '--hint=boolean:resident:true',
      '--',
      REPO,
      'A session is blocked and needs a decision from you.',
    ])

    // The policy recorded a delivery, and the counter PRD 11 measures moved - through the
    // real metrics route, not by reading the object the test just used.
    const status = hub.delivery.status()
    expect(status).toMatchObject({ status: 'ok', wired: true, attempted: 1, delivered: 1, failed: 0 })
    expect(hub.ingest.stats().deliveries).toMatchObject({ attempted: 1, delivered: 1, failed: 0, notWired: 0 })
    expect(hub.ingest.droppedEvents()).toEqual([])
    const metrics = await call(hub.origin, 'GET', '/api/metrics')
    expect(counterValue(metrics.json<MetricsPayload>(), 'toast_deliveries')).toBe(1)
  })

  it('does not fire a second toast for the same block', async () => {
    // NT-FR-08 through the real path: one block, one toast, however many times the
    // envelope is posted. The duplicate is refused by the store's own dedupe key before the
    // policy is asked, so the policy records one attempt and no suppression - and the
    // process that ran is still one, which is the claim.
    expect(resolveNotifyPlatform(process.platform)).toBe('linux')
    const stubDirectory = stubNotifySend(0)

    const hub = await withPath(stubDirectory, async () => {
      const started = await startFixtureHub(temporaryDirectory())
      const first = await call(started.origin, 'POST', '/api/ingest', blockBody())
      const second = await call(started.origin, 'POST', '/api/ingest', blockBody())
      expect([first.status, second.status]).toEqual([202, 202])
      expect(first.json<{ outcome: string }>().outcome).toBe('pending-created')
      expect(second.json<{ outcome: string }>().outcome).toBe('duplicate')
      await started.ingest.idle()
      return started
    })

    expect(stubArgv(stubDirectory)).toHaveLength(7)
    expect(hub.delivery.status()).toMatchObject({ attempted: 1, delivered: 1, suppressed: 0 })
    expect(hub.ingest.stats().deliveries).toMatchObject({ attempted: 1, delivered: 1 })
  })

  it('replays an unacknowledged block into the same notifier after a restart', async () => {
    // HC-FR-07's replay, proven at the boundary that matters for NT-1: the replayed
    // delivery goes to the same platform notifier a fresh one does, exactly once, and the
    // hub that replays is a second hub over the same log rather than the same object.
    expect(resolveNotifyPlatform(process.platform)).toBe('linux')
    const stubDirectory = stubNotifySend(0)
    const stateDir = temporaryDirectory()

    const first = await withPath(stubDirectory, async () => {
      const hub = await startFixtureHub(stateDir)
      await call(hub.origin, 'POST', '/api/ingest', blockBody())
      await hub.ingest.idle()
      return hub
    })
    expect(stubArgv(stubDirectory)).toHaveLength(7)
    await first.close()

    const second = await withPath(stubDirectory, async () => {
      const hub = await startFixtureHub(stateDir)
      return hub
    })
    // Seven more arguments, and the same command: one replay, not two.
    expect(stubArgv(stubDirectory)).toHaveLength(14)
    expect(second.delivery.status()).toMatchObject({ replayed: 1, delivered: 1, failed: 0 })
    expect(second.ingest.stats().deliveries.attempted).toBe(0)
  })

  it('records a non-zero exit as a failure, in the ledger and in what doctor reads', async () => {
    // NT-FR-09 and APX-FR-02 at their sharpest: a real process exiting 1 while a real hub
    // serves a real request. Nobody was told, the block is still there to be asked about,
    // and the fact is visible in three places - the policy's ledger, the health payload
    // `doctor` reads over a socket, and the diagnostic line - while the toast counter stays
    // where it was, because a failure is not a delivery (PRD 11, ADR-010).
    expect(resolveNotifyPlatform(process.platform)).toBe('linux')
    const stubDirectory = stubNotifySend(1)
    const diagnostics: string[] = []

    const hub = await withPath(stubDirectory, async () => {
      const started = await startFixtureHub(temporaryDirectory(), {
        onDiagnostic: (message) => diagnostics.push(message),
      })
      // A finished turn, so the failure is about a class that is allowed to expire and the
      // block from the same session is untouched: a failed toast is a missing notification,
      // never a lost block.
      const posted = await call(started.origin, 'POST', '/api/ingest', finishedBody())
      expect(posted.status).toBe(202)
      await started.ingest.idle()
      return started
    })

    const status = hub.delivery.status()
    expect(status).toMatchObject({
      status: 'degraded',
      wired: true,
      attempted: 1,
      delivered: 0,
      failed: 1,
    })
    expect(status.lastFailure?.reason).toBe('notifier-failed')
    expect(hub.delivery.outcomes()[0]).toMatchObject({
      outcome: 'failed',
      reason: 'notifier-failed',
      class: 'finished',
    })

    // What `doctor` reads, over a real socket.
    const health = await call(hub.origin, 'GET', '/api/health')
    expect(health.status).toBe(200)
    const reported = deliveryOf(health.json<HealthPayload>())
    expect(reported).toMatchObject({ status: 'degraded', wired: true, attempted: 1, failed: 1 })
    expect(reported.lastFailure?.reason).toBe('notifier-failed')
    // The health payload's delivery section carries counts, a timestamp and a row key -
    // and no message, no title and no body.
    expect(Object.keys(reported.lastFailure ?? {}).sort()).toEqual(['at', 'eventId', 'reason'])

    // The ingest pipeline saw the same failure as a drop, and nothing was retried.
    expect(hub.ingest.stats().deliveries).toMatchObject({ attempted: 1, delivered: 0, failed: 1 })
    expect(hub.ingest.droppedEvents()[0]).toMatchObject({ stage: 'delivery', reason: 'delivery-failed' })
    // The tool's own complaint reached the operator, and no delivery was counted.
    expect(diagnostics.join('\n')).toMatch(/command-failed, exit 1/)
    expect(diagnostics.join('\n')).toContain('the notification server refused this')
    const metrics = await call(hub.origin, 'GET', '/api/metrics')
    expect(counterValue(metrics.json<MetricsPayload>(), 'toast_deliveries')).toBe(0)
  })

  it('leaves nothing behind when the notifier could not run at all', async () => {
    // The other shape of "not delivered": the tool is not installed, so there is no exit
    // code at all - and the hub must still be serving, still report the failure, and still
    // hold the block. A hub that refused to start because a desktop tool was missing would
    // be a worse product than one that says so (APX-FR-02, APX-CON-06).
    expect(resolveNotifyPlatform(process.platform)).toBe('linux')
    const empty = temporaryDirectory('agent-ping-notify-no-tool-')

    const hub = await withOnlyPath(empty, async () => {
      const started = await startFixtureHub(temporaryDirectory())
      await call(started.origin, 'POST', '/api/ingest', blockBody())
      await started.ingest.idle()
      // The probe runs here rather than after, because "is notify-send installed" is a
      // question about the PATH this hub was delivering through. The delivery and the
      // probe agreeing about why is the whole claim: an operator is told the tool is
      // missing, not merely that a delivery failed (NT-FR-09, IO-2).
      const availability = await started.notifier.probe()
      expect(availability).toMatchObject({ available: false, reason: 'command-not-found' })
      return started
    })

    expect(hub.delivery.status()).toMatchObject({ attempted: 1, delivered: 0, failed: 1 })
    const health = await call(hub.origin, 'GET', '/api/health')
    expect(deliveryOf(health.json<HealthPayload>()).status).toBe('degraded')
    // And the block is still there: nobody was told, and nothing was lost. Read through a
    // second connection to the same log rather than through the hub's own accessor, so the
    // assertion is about what is on disk.
    const log = openEventStore({ filePath: hub.databaseFilePath })
    openStores.push(log)
    expect(log.readPending()).toHaveLength(1)
    expect(log.readEventHistory({ limit: 10 })).toHaveLength(1)
  })
})

/** One counter's value from a metrics payload, by its closed name. */
function counterValue(payload: MetricsPayload, name: string): number {
  const reading = payload.counters.find((entry) => entry.counter === name)
  expect(reading, name).toBeDefined()
  return reading?.value ?? -1
}
