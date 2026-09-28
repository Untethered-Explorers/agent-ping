// The shutdown path: what a termination signal does to a real hub process, in what
// order, and what is left behind (HC-5, HC-FR-10, HC-FR-07, PRD 10, APX-CON-03).
//
//   npm test -- tests/hub/lifecycle.test.ts
//
// THE ACCEPTANCE CRITERION, AND WHERE IT IS PROVEN
//
//   "A test asserts a termination signal closes the listener, flushes counters, closes
//    the database and removes the runtime file."
//
//   Proven by a real SIGTERM sent to a real hub in a real operating-system process.
//   After the process exits, the test - a different process, with its own view of the
//   file system - asserts each of the four things from the outside:
//
//     - the listener is gone: a connection to the port that was published is refused
//     - the counters were flushed and the log closed: the write-ahead log that a
//       committed-but-unfolded write leaves behind is not there any more. A hard kill
//       is asserted to leave exactly that file, in the same test, so the assertion is
//       about the clean shutdown rather than about SQLite's habits
//     - the database is closed: the file opens again from this process, the block that
//       was pending is still pending, and the event is still there
//     - the runtime file is removed: the file the adapters read is not there, and a
//       fresh hub over the same state directory starts without being refused
//
//   One of those four is proven by this test and the rest are not, and the difference is
//   worth stating. Exiting a process closes its sockets whatever the process did, so "a
//   connection to the published port is refused after the process exited" is a fact
//   about the process being gone - it holds for a hub that closed its listener in the
//   ordered close and for one that never closed it at all. Removing `server.close()`
//   from the ordered close leaves this test green, which is a fact established by
//   applying that mutation. The claim that the hub itself released the listener is
//   therefore proven in the other test below, in this process, where
//   `listening === false` and a refused port are both the hub's own doing before any
//   exit. What this test adds is the part nothing in-process can reach: that a real
//   signal, delivered by the operating system to a real hub, produced a clean exit code
//   and left that file system behind.
//
//   The one thing a signal test cannot see from outside is the *order* the steps ran
//   in, and the order is the requirement. So the state machine, the ordering, the
//   grace bound and the handler installation are driven directly, through the real
//   handlers with an injected signal source and an injected exit - never a call to a
//   lifecycle function in place of a signal - and the composition root's own close is
//   asserted from the source for the same reason it is in the delivery test.
//
// AROUND THE CRITERION:
//
//   - The handlers that get installed are exactly SIGTERM and SIGINT. SIGHUP is not
//     among them: a hub that exited when its parent shell closed would be a hub that
//     cannot be run from a terminal.
//   - A second signal while a shutdown is in flight does not start a second one, and
//     the grace bound means a wedged close still ends the process - with a failure
//     code, and after removing only *this* instance's runtime file.
//   - A shutdown drains a delivery that is in flight, bounded, and refuses new events
//     and new deliveries while it runs.
//   - `close()` is idempotent, reports the state a signal would report, and removes the
//     handlers it installed - so a test that closes a hub in-process leaves the test
//     runner with no signal handler of ours on it.

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { request } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startHub, type RunningHub } from '@/main/index'
import { openCounters, type Counters } from '@/storage/counters'
import { openEventStore, type EventStore } from '@/storage/eventStore'
import { databaseFilePath } from '@/storage/paths'
import {
  HUB_STATES,
  SHUTDOWN_CLEAN_EXIT_CODE,
  SHUTDOWN_FAILURE_EXIT_CODE,
  SHUTDOWN_GRACE_MS,
  SHUTDOWN_SIGNALS,
  createHubLifecycle,
  type HubLifecycle,
  type SignalSource,
} from '@/hub/lifecycle'
import { readRuntimeFile, runtimeFilePath, writeRuntimeFile } from '@/hub/runtime-file'
import { readHealth, type HubServices } from '@/hub/routes/read'
import { createCardDismissal } from '@/notify/surface/dismissal'
import type { HubDesktopState } from '@/hub/routes/read'

/** What the composition root reports for a run with no desktop bridge (IO-2). */
const HEADLESS_DESKTOP: HubDesktopState = {
  bridge: 'absent',
  tray: 'absent',
  surface: 'not-mounted',
}
import type { Notifier } from '@/hub/delivery'
import { SHUTDOWN_PORT_BASE, startRealHub, stopStrayHubs, type RealHub } from './fixtures/hub-process'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPO_PATH = '/home/dev/Projects/agent-ping'
const SESSION = 'ses_lifecycle_01'
const OCCURRED_AT = '2026-09-26T09:00:00.000Z'
const WRITE_TOKEN_FILE = 'hub-write-token'

const temporaryDirectories: string[] = []
const openHubs: RunningHub[] = []
const openStores: EventStore[] = []
const openCountersList: Counters[] = []

/**
 * The port band the in-process hub in this file is given, a hundred ports above the
 * real-process hubs' band and above the default every other suite binds.
 *
 * The claim this file's `portAnswer` assertions make is about a port nobody answers any
 * more, and a released loopback port is the next candidate for whichever hub starts
 * next - including one in a test file running in parallel. Disjoint bands turn that
 * race into a property of the repository rather than of the run's timing.
 */
const IN_PROCESS_PORT_BASE = SHUTDOWN_PORT_BASE + 100

function temporaryDirectory(prefix = 'agent-ping-lifecycle-'): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await stopStrayHubs()
  for (const hub of openHubs.splice(0)) {
    await hub.close().catch(() => undefined)
  }
  for (const store of openStores.splice(0)) store.close()
  for (const counters of openCountersList.splice(0)) counters.close()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/** A block in one session: the only class that leaves the app. */
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

/**
 * Post one signal to a hub in this process, over a real socket.
 *
 * `node:http` with no agent rather than `fetch`, for the reason every suite here makes
 * it: one request, one connection, so a pooled connection held against a hub that has
 * since closed cannot be handed to the next request.
 */
async function post(hub: RunningHub, body: unknown): Promise<number> {
  const { hostname, port } = new URL(hub.origin)
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: hostname,
        port,
        path: '/api/ingest',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) },
        agent: false,
      },
      (response) => {
        response.resume()
        response.once('end', () => resolve(response.statusCode ?? 0))
      },
    )
    outgoing.on('error', reject)
    outgoing.end(payload)
  })
}

/** A notifier that records each request and returns normally. */
function recordingNotifier(seen: { eventId: string }[]): Notifier {
  return (request) => {
    seen.push({ eventId: request.event.eventId })
  }
}

/** The write-ahead log's size in bytes, or null when the file is not there. */
function walSize(stateDir: string): number | null {
  const wal = `${databaseFilePath(stateDir)}-wal`
  return existsSync(wal) ? statSync(wal).size : null
}

/**
 * What answering a port told this test.
 *
 * Three answers rather than a boolean, because a boolean cannot tell a port nobody
 * answers from a port that never answered at all. `refused` is the answer a released
 * listener gives, `answered` is a live listener, and `silent` is a socket that neither
 * connected nor failed inside the bound - a hang, which as a `false` would be
 * indistinguishable from a live hub and would turn a wedged shutdown into a passing
 * assertion.
 */
type PortAnswer = 'refused' | 'answered' | 'silent'

/**
 * Ask a port what it is doing.
 *
 * `ECONNREFUSED` is the answer a stopped listener gives, and it is the only answer that
 * can distinguish "the hub released the port" from "the process is gone so nothing
 * answers": both look the same from outside, which is why the runtime file and the
 * database are checked too. The other error codes are reported as `silent` rather than
 * as a refusal, because a refused connection and a filtered one are different facts and
 * only the first of them is what a released listener looks like.
 *
 * The callers that assert `refused` give their suite a port band of its own
 * (SHUTDOWN_PORT_BASE, and the other suite's band in the delivery file), so a released
 * port cannot be taken by another hub in the repository between the process exiting and
 * this answer. A squatter would show up here as `answered`, not as a passing test.
 */
function portAnswer(port: number, host = '127.0.0.1', timeoutMs = 5_000): Promise<PortAnswer> {
  return new Promise((resolve) => {
    let settled = false
    const socket = connect({ port, host })
    const done = (answer: PortAnswer): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(answer)
    }
    socket.once('connect', () => done('answered'))
    socket.once('error', (cause: NodeJS.ErrnoException) => {
      done(cause.code === 'ECONNREFUSED' ? 'refused' : 'silent')
    })
    setTimeout(() => done('silent'), timeoutMs).unref()
  })
}

/** A signal source that records what was installed, and can fire a signal. */
function fakeSignals(): SignalSource & {
  readonly handlers: Map<string, Set<() => void>>
  installed(): readonly string[]
  fire(signal: string): void
} {
  const handlers = new Map<string, Set<() => void>>()
  return {
    handlers,
    on(signal, handler) {
      const forSignal = handlers.get(signal) ?? new Set<() => void>()
      forSignal.add(handler)
      handlers.set(signal, forSignal)
    },
    off(signal, handler) {
      handlers.get(signal)?.delete(handler)
    },
    installed: (): readonly string[] => [...handlers.entries()].filter(([, set]) => set.size > 0).map(([signal]) => signal),
    fire: (signal: string): void => {
      for (const handler of [...(handlers.get(signal) ?? [])]) handler()
    },
  }
}

interface Harness {
  readonly lifecycle: HubLifecycle
  readonly signals: ReturnType<typeof fakeSignals>
  readonly exits: number[]
  readonly diagnostics: string[]
  readonly closes: number[]
  readonly stateDir: string
}

/**
 * A lifecycle driven directly, with an injected signal source and an injected exit.
 *
 * The real `createHubLifecycle`, the real handlers and the real ordering; only the
 * process is a stand-in, so that firing a signal here does not end the test runner.
 * The production default for both is `process`, and the criterion above proves that
 * default against a real process.
 */
function harness(
  close: () => Promise<void> = async () => {
    // Replaced by the caller when it wants to observe the close.
  },
  options: { readonly graceMs?: number; readonly signals?: readonly string[] } = {},
): Harness {
  const signals = fakeSignals()
  const exits: number[] = []
  const diagnostics: string[] = []
  const closes: number[] = []
  const stateDir = temporaryDirectory()
  const lifecycle = createHubLifecycle({
    close: async () => {
      closes.push(Date.now())
      await close()
    },
    stateDir,
    instanceId: 'instance-under-test',
    pid: 424242,
    signalSource: signals,
    exit: (code) => {
      exits.push(code)
    },
    onDiagnostic: (message) => {
      diagnostics.push(message)
    },
    ...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }),
    ...(options.signals === undefined ? {} : { signals: options.signals }),
  })
  return { lifecycle, signals, exits, diagnostics, closes, stateDir }
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

// ---------------------------------------------------------------------------
// AC4: a termination signal, in a real process
// ---------------------------------------------------------------------------

describe('a termination signal to a real hub leaves nothing running', () => {
  it('closes the listener, flushes the counters, closes the log and removes the runtime file', async () => {
    const stateDir = temporaryDirectory('agent-ping-signal-')
    const attemptsFile = path.join(temporaryDirectory('agent-ping-attempts-'), 'attempts.jsonl')
    const hub = await startRealHub({ stateDir, attemptsFile, notifier: 'ok', preferredPort: SHUTDOWN_PORT_BASE })
    const publishedPort = hub.port

    // Something to lose: a stored event and a pending block, plus a committed write the
    // write-ahead log has not folded back yet.
    expect((await hub.post('/api/ingest', blockBody())).status).toBe(202)
    await hub.waitForAttempts(1)
    expect(walSize(stateDir), 'a committed write leaves a write-ahead log behind').toBeGreaterThan(0)

    // The hub is serving and says so, and the file the adapters read names it.
    const before = (await (await hub.get('/api/health')).json<{ server: { listening: boolean; state: string } }>())
    expect(before.server).toMatchObject({ listening: true, state: 'running' })
    expect(readRuntimeFile(stateDir)?.pid).toBe(hub.pid)
    expect(await portAnswer(publishedPort)).toBe('answered')

    // ---- the signal.
    hub.signal('SIGTERM')
    const exit = await hub.waitForExit()

    // A clean stop, not a death: the process exited on its own with the success code
    // the lifecycle passes (HC-FR-10).
    expect(exit.signal).toBeNull()
    expect(exit.code).toBe(SHUTDOWN_CLEAN_EXIT_CODE)
    expect(exit.code).toBe(0)

    // 1. No orphaned listener: nothing answers the port this hub published. Read
    //    `answered` above for what this does and does not prove on its own - the exit
    //    closes the socket whatever the hub did - so the listener the hub released is
    //    asserted in this process further down, before any exit can take credit for it.
    expect(await portAnswer(publishedPort)).toBe('refused')

    // 2. The runtime file is gone, which is the signal an adapter reads to find that
    //    the hub is not there (HC-FR-01).
    expect(existsSync(runtimeFilePath(stateDir))).toBe(false)
    expect(readRuntimeFile(stateDir)).toBeNull()

    // 3. The counters were flushed and the log closed: the write-ahead log that step 0
    //    observed is not there, so a copy of the single database file is complete
    //    rather than needing a restart to become so (PRD 10's "counters flushed").
    expect(walSize(stateDir)).toBeNull()

    // 4. The database is closed, not left open: this process opens it, and the block
    //    and its row are exactly as they were.
    const store = openEventStore({ filePath: databaseFilePath(stateDir) })
    openStores.push(store)
    expect(store.readPending().map((item) => item.sessionId)).toEqual([SESSION])
    expect(store.readEventHistory({ limit: 10 })).toHaveLength(1)
    expect(store.readEventHistory({ limit: 10 })[0]?.resolutionState).toBe('unresolved')
    // The token file the write route needs is untouched, because a shutdown is not a
    // reinstall (HC-FR-06, IO-2).
    expect(existsSync(path.join(stateDir, WRITE_TOKEN_FILE))).toBe(true)
    store.close()
    openStores.pop()

    // 5. And the state directory is usable: a fresh hub over it starts, is not refused,
    //    and finds the block still outstanding (APX-CON-03: killable and restartable at
    //    any moment without loss).
    const restarted = await startRealHub({ stateDir, attemptsFile, notifier: 'ok', preferredPort: SHUTDOWN_PORT_BASE })
    expect(restarted.port).toBeGreaterThan(0)
    expect((await (await restarted.get('/api/pending')).json<{ count: number }>()).count).toBe(1)
    restarted.signal('SIGTERM')
    expect((await restarted.waitForExit()).code).toBe(0)
  }, 90_000)

  it('leaves a write-ahead log behind when it is killed, which is the contrast', async () => {
    // The previous test asserts the write-ahead log is gone after a clean stop, and an
    // assertion is only worth something if the other case is different. SIGKILL runs no
    // shutdown at all, so the log stays and the runtime file stays - and the next start
    // recovers from both (PRD 10: a crashed hub is indistinguishable from a stopped
    // one). This is also why the clean-stop test asserts on the file rather than on a
    // return value: a hard kill is the only way to see the difference.
    const stateDir = temporaryDirectory('agent-ping-killed-')
    const attemptsFile = path.join(temporaryDirectory('agent-ping-attempts-'), 'attempts.jsonl')
    const hub = await startRealHub({ stateDir, attemptsFile, notifier: 'ok', preferredPort: SHUTDOWN_PORT_BASE })
    await hub.post('/api/ingest', blockBody())
    await hub.waitForAttempts(1)
    const walBefore = walSize(stateDir)
    expect(walBefore).toBeGreaterThan(0)

    hub.signal('SIGKILL')
    const exit = await hub.waitForExit()

    expect(exit.signal).toBe('SIGKILL')
    // The two things a clean stop would have done, and did not.
    expect(existsSync(runtimeFilePath(stateDir))).toBe(true)
    expect(walSize(stateDir)).toBeGreaterThan(0)

    // And the recovery: the next start reclaims the file, replays the block once, and
    // then a clean stop leaves neither artefact behind.
    const restarted = await startRealHub({ stateDir, attemptsFile, notifier: 'ok', preferredPort: SHUTDOWN_PORT_BASE })
    expect(readRuntimeFile(stateDir)?.pid).toBe(restarted.pid)
    expect((await restarted.get('/api/pending')).json<{ count: number }>()).toEqual({ count: 1, items: expect.any(Array) })
    await restarted.waitForAttempts(2)
    restarted.signal('SIGTERM')
    expect((await restarted.waitForExit()).code).toBe(0)
    expect(existsSync(runtimeFilePath(stateDir))).toBe(false)
    expect(walSize(stateDir)).toBeNull()
  }, 90_000)
})

// ---------------------------------------------------------------------------
// The handlers, the state machine and the order
// ---------------------------------------------------------------------------

describe('the shutdown path installs exactly the handlers it should', () => {
  it('reacts to SIGTERM and SIGINT, and to nothing else', () => {
    const state = harness()
    state.lifecycle.install()

    // SIGTERM is what a service manager sends; SIGINT is what a terminal sends on
    // Ctrl-C. SIGHUP is deliberately not handled: a hub that treated a hangup as a
    // shutdown would exit when its parent shell closed, and a hub that cannot be run
    // from a terminal is a hub a developer will not run.
    expect([...state.signals.installed()].sort()).toEqual([...SHUTDOWN_SIGNALS].sort())
    expect(state.signals.installed()).not.toContain('SIGHUP')
    expect(state.signals.installed()).not.toContain('SIGQUIT')
    expect(state.lifecycle.handledSignals()).toEqual([...SHUTDOWN_SIGNALS])

    // Installing twice does not double up: a second handler would run a second close.
    state.lifecycle.install()
    expect([...state.signals.installed()].sort()).toEqual([...SHUTDOWN_SIGNALS].sort())
    for (const signal of SHUTDOWN_SIGNALS) {
      expect(state.signals.handlers.get(signal)?.size, signal).toBe(1)
    }
  })

  it('runs the ordered close once per signal, and exits with the clean code', async () => {
    const order: string[] = []
    const state = harness(async () => {
      order.push('closed')
    })
    state.lifecycle.install()
    state.lifecycle.markRunning()

    state.signals.fire('SIGTERM')
    // The state is `stopping` before the close has finished, and the handlers are gone:
    // a second Ctrl-C is the operating system's answer, not a second ordered close.
    expect(state.lifecycle.state().state).toBe('stopping')
    expect(state.lifecycle.state().reason).toBe('signal:SIGTERM')
    expect(state.signals.installed()).toEqual([])

    await state.lifecycle.shutdown('awaited')
    await settle()

    expect(order).toEqual(['closed'])
    expect(state.closes).toHaveLength(1)
    expect(state.exits).toEqual([SHUTDOWN_CLEAN_EXIT_CODE])
    expect(state.lifecycle.state().state).toBe('stopped')
    expect(state.lifecycle.state().forced).toBe(false)
    expect(state.diagnostics.join(' ')).toContain('stopping on signal:SIGTERM')
  })

  it('names the signal that fired rather than the last one it saw', async () => {
    const state = harness(async () => undefined)
    state.lifecycle.install()

    state.signals.fire('SIGINT')
    await state.lifecycle.shutdown('awaited')

    expect(state.lifecycle.state().reason).toBe('signal:SIGINT')
    expect(state.exits).toEqual([SHUTDOWN_CLEAN_EXIT_CODE])
  })

  it('performs one shutdown for two triggers, because a quit can arrive twice', async () => {
    // Electron's `before-quit` and a SIGTERM can land together, and a second ordered
    // close would try to flush a closed database - which would turn a clean shutdown
    // into an error, the exact sort of "not silent" that is not a report.
    const state = harness(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    state.lifecycle.install()

    const fromSignal = state.lifecycle.shutdown('signal:SIGTERM')
    const fromQuit = state.lifecycle.shutdown('electron-quit')
    expect(fromQuit).toBe(fromSignal)

    await fromSignal
    await settle()

    expect(state.closes).toHaveLength(1)
    expect(state.exits).toEqual([SHUTDOWN_CLEAN_EXIT_CODE])
    // The first trigger is the one recorded, because the second never began anything.
    expect(state.lifecycle.state().reason).toBe('signal:SIGTERM')
  })

  it('removes its handlers on dispose, and leaves the state alone', () => {
    const state = harness()
    state.lifecycle.install()
    state.lifecycle.markRunning()

    state.lifecycle.dispose()

    expect(state.signals.installed()).toEqual([])
    expect(state.lifecycle.state().state).toBe('running')
    // Disposing twice is safe, because `close` disposes and a caller may dispose.
    state.lifecycle.dispose()
    expect(state.signals.installed()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

describe('the hub reports PRD 10\'s states, and never a lie', () => {
  it('goes starting, running, stopping, stopped', () => {
    const state = harness()
    state.lifecycle.install()

    // `starting` is real: the replay of a previous run's pending blocks happens in it,
    // and a doctor run that saw `running` before the port was published would be told
    // to connect to a hub that is not listening yet.
    expect(state.lifecycle.state().state).toBe('starting')
    state.lifecycle.markRunning()
    expect(state.lifecycle.state().state).toBe('running')
    state.lifecycle.begin('close')
    expect(state.lifecycle.state().state).toBe('stopping')
    state.lifecycle.finish()
    expect(state.lifecycle.state().state).toBe('stopped')

    // Only those four states exist, so a client cannot be handed a fifth.
    expect([...HUB_STATES]).toEqual(['starting', 'running', 'stopping', 'stopped'])
  })

  it('refuses to become running again once it has started stopping', () => {
    // `running` is the state a client trusts, so a late call must not be able to
    // reinstate it after the hub has begun refusing work.
    const state = harness()
    state.lifecycle.begin('signal:SIGTERM')
    state.lifecycle.markRunning()

    expect(state.lifecycle.state().state).toBe('stopping')
  })

  it('does nothing when the shutdown is already finished', async () => {
    const state = harness()
    state.lifecycle.finish()
    state.lifecycle.begin('close')
    state.lifecycle.markRunning()

    expect(state.lifecycle.state().state).toBe('stopped')
  })
})

// ---------------------------------------------------------------------------
// The grace bound
// ---------------------------------------------------------------------------

describe('a wedged shutdown still ends the process', () => {
  it('exits with a failure code when the ordered close never finishes', async () => {
    // A close that hangs must not be able to keep a daemon alive: a developer would
    // kill it more violently, and a process that leaves without closing the log or
    // removing the runtime file is worse than the wedge that caused it. The timer is
    // what makes the exit happen, and the exit code says the stop was unclean.
    let release: (() => void) | undefined
    const wedged = new Promise<void>((resolve) => {
      release = resolve
    })
    const state = harness(() => wedged, { graceMs: 40 })
    state.lifecycle.install()

    // A runtime file that is this instance's, so the forced path has one to remove.
    writeRuntimeFile(
      {
        version: 1,
        instanceId: 'instance-under-test',
        pid: 424242,
        host: '127.0.0.1',
        port: 43117,
        stateDir: state.stateDir,
        startedAt: '2026-09-26T09:00:00.000Z',
        schemaVersion: 1,
      },
      state.stateDir,
    )

    const began = Date.now()
    void state.lifecycle.shutdown('signal:SIGTERM')
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(Date.now() - began, 'the grace bound ended the wait').toBeLessThan(5_000)
    expect(state.exits).toEqual([SHUTDOWN_FAILURE_EXIT_CODE])
    expect(state.lifecycle.state().forced).toBe(true)
    // The runtime file went with it, so the next start is not refused by a file a
    // process that no longer exists left behind (HC-FR-01).
    expect(existsSync(runtimeFilePath(state.stateDir))).toBe(false)
    expect(state.diagnostics.join(' ')).toMatch(/did not finish within 40 ms/)
    release?.()
    await settle()
  })

  it('exits with a failure code when the ordered close throws', async () => {
    // A shutdown that failed must not report success: the exit status is what a service
    // manager, an autostart unit and a packaging check read.
    const state = harness(() => Promise.reject(new Error('the log could not be closed')))
    state.lifecycle.install()

    await state.lifecycle.shutdown('signal:SIGTERM')
    await settle()

    expect(state.exits).toEqual([SHUTDOWN_FAILURE_EXIT_CODE])
    expect(state.lifecycle.state().forced).toBe(true)
    expect(state.diagnostics.join(' ')).toContain('the ordered close failed')
  })

  it('never removes a runtime file this instance did not write', async () => {
    // The forced path deletes a file, and deleting a *live* instance's file would send
    // every adapter on this machine to a port nobody is listening on (HC-FR-01). Two
    // things identify our file - the instance id and the pid - and this asserts each of
    // them independently, because a check that only ever runs alongside the other one
    // is a check nothing has proved: with only the pid wrong, only the pid can save the
    // file, and with only the instance id wrong, only that one can.
    const others: readonly { readonly why: string; readonly record: Record<string, unknown> }[] = [
      {
        why: 'a live process with a different instance',
        record: { instanceId: 'a-newer-instance', pid: process.pid },
      },
      {
        why: 'our instance id on a pid this process does not own',
        record: { instanceId: 'instance-under-test', pid: 424241 },
      },
      {
        // The artificial one, and the reason the two checks are separate: a file that
        // names our own pid under another instance's id. No real hub writes that, which
        // is exactly why only a test can cover it - and if the instance-id check were
        // removed, this row would be the only thing that notices.
        why: 'our own pid under another instance id',
        record: { instanceId: 'a-newer-instance', pid: 424242 },
      },
    ]

    for (const other of others) {
      const state = harness(() => new Promise<void>(() => undefined), { graceMs: 30 })
      writeRuntimeFile(
        {
          version: 1,
          ...other.record,
          host: '127.0.0.1',
          port: 43119,
          stateDir: state.stateDir,
          startedAt: '2026-09-26T09:00:00.000Z',
          schemaVersion: 1,
        } as Parameters<typeof writeRuntimeFile>[0],
        state.stateDir,
      )

      void state.lifecycle.shutdown('signal:SIGTERM')
      await new Promise((resolve) => setTimeout(resolve, 150))

      expect(existsSync(runtimeFilePath(state.stateDir)), other.why).toBe(true)
      expect(readRuntimeFile(state.stateDir)?.port, other.why).toBe(43119)
      // Forced, because the close never finished, and that is exactly why the file had
      // to be left alone: a shutdown that gave up is not entitled to disown a hub that
      // is serving.
      expect(state.exits, other.why).toEqual([SHUTDOWN_FAILURE_EXIT_CODE])
    }
  })

  it('names the grace bound it used and the codes it exits with', () => {
    expect(SHUTDOWN_GRACE_MS).toBe(5_000)
    expect(SHUTDOWN_CLEAN_EXIT_CODE).toBe(0)
    expect(SHUTDOWN_FAILURE_EXIT_CODE).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// The composition root's own close
// ---------------------------------------------------------------------------

describe('closing a hub directly is the same shutdown, and reports the same state', () => {
  it('refuses events, drains deliveries, closes everything and reports stopped', async () => {
    const seen: { eventId: string }[] = []
    const stateDir = temporaryDirectory()
    const hub = await startHub({
      stateDir,
      dashboardRoot: null,
      // A port band of its own, for the reason `portAnswer` documents: this test closes
      // the hub and then asks its port whether anything answers, and a hub in another
      // test file taking the released port out of the default band would answer that
      // question for this one.
      preferredPort: IN_PROCESS_PORT_BASE,
      lifecycle: { installSignals: true },
      delivery: { notifier: recordingNotifier(seen) },
    })
    openHubs.push(hub)

    expect(await post(hub, blockBody())).toBe(202)
    await hub.ingest.idle()
    expect(seen).toHaveLength(1)
    expect(hub.lifecycle.state().state).toBe('running')
    const port = hub.port

    await hub.close()

    // The state a signal would have reported, and a listener the hub itself released:
    // the flag is the hub's own `Server`, still in this process, and the refused port is
    // the same fact from outside. Neither is an exit taking credit for it, which is why
    // the listener claim lives here and not only in the real-process test above.
    expect(hub.lifecycle.state().state).toBe('stopped')
    expect(hub.server.nodeServer.listening).toBe(false)
    expect(await portAnswer(port)).toBe('refused')
    // The runtime file is gone and the log is closed but intact.
    expect(existsSync(runtimeFilePath(stateDir))).toBe(false)
    const store = openEventStore({ filePath: databaseFilePath(stateDir) })
    openStores.push(store)
    expect(store.readPending()).toHaveLength(1)

    // A second close is a no-op rather than an error: a quit can be requested twice.
    await expect(hub.close()).resolves.toBeUndefined()
    expect(hub.lifecycle.state().state).toBe('stopped')
  })

  it('leaves the test runner with none of this product\'s signal handlers', async () => {
    // The reason `installSignals` exists as an option at all: a hub started in a test
    // process installs handlers on that process, and it has to take them away again. If
    // this ever regressed, a Ctrl-C in a terminal running the suite would take a test
    // runner down a shutdown path it never asked for.
    const before = process.listenerCount('SIGTERM')
    const hub = await startHub({
      stateDir: temporaryDirectory(),
      dashboardRoot: null,
      lifecycle: { installSignals: true },
    })

    expect(process.listenerCount('SIGTERM')).toBe(before + 1)

    await hub.close()
    expect(process.listenerCount('SIGTERM')).toBe(before)
  })

  it('leaves no handler behind when the start itself fails', async () => {
    const before = process.listenerCount('SIGTERM')
    const first = await startHub({
      stateDir: temporaryDirectory(),
      dashboardRoot: null,
      lifecycle: { installSignals: true },
    })

    // A second instance over the same state directory is refused, and the refusal must
    // not leave a handler installed in the process that made it.
    await expect(
      startHub({ stateDir: first.stateDir, dashboardRoot: null, lifecycle: { installSignals: true } }),
    ).rejects.toThrow(/already running/)

    expect(process.listenerCount('SIGTERM')).toBe(before + 1)
    await first.close()
    expect(process.listenerCount('SIGTERM')).toBe(before)
  })

  it('refuses a new event after the shutdown has begun', async () => {
    // HC-FR-10's first step, at the level a client can see it: the pipeline stops
    // accepting, and a signal that arrives now is refused and recorded rather than
    // half-stored by a closing hub.
    const hub = await startHub({
      stateDir: temporaryDirectory(),
      dashboardRoot: null,
      lifecycle: { installSignals: false },
      delivery: { notifier: (): void => undefined },
    })
    openHubs.push(hub)
    await hub.close()

    const refused = await hub.ingest.submit({
      harness: 'opencode',
      eventName: 'permission.asked',
      sessionId: SESSION,
      repoFullPath: REPO_PATH,
      transitionId: 'after-close',
      occurredAt: OCCURRED_AT,
      receivedAt: OCCURRED_AT,
    })

    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.code).toBe('store-failed')
    expect(hub.ingest.droppedEvents()[0]).toMatchObject({ stage: 'store', reason: 'store-failed' })
  })

  it('drains a delivery that is in flight before the log closes', async () => {
    // The ordering claim from the delivery side: a notifier that takes a moment is
    // finished rather than abandoned, because the log is still open while it runs and
    // the attempt is still recorded after the hub is gone.
    const finished: string[] = []
    const hub = await startHub({
      stateDir: temporaryDirectory(),
      dashboardRoot: null,
      lifecycle: { installSignals: false },
      delivery: {
        notifier: async (request) => {
          await new Promise((resolve) => setTimeout(resolve, 60))
          finished.push(request.event.eventId)
        },
      },
    })
    openHubs.push(hub)

    await post(hub, blockBody())
    expect(hub.delivery.status().inFlight).toBe(1)

    await hub.close()

    expect(finished).toHaveLength(1)
    expect(hub.delivery.status()).toMatchObject({ delivered: 1, inFlight: 0 })
  })

  it('does not wait past the bound for a notifier that never settles', async () => {
    // The other half: bounded, not unbounded. A wedged notifier cannot decide whether
    // the hub stops (APX-CON-10), and the block is left pending and visible rather than
    // lost (ADR-010).
    const hub = await startHub({
      stateDir: temporaryDirectory(),
      dashboardRoot: null,
      lifecycle: { installSignals: false },
      delivery: {
        attemptTimeoutMs: 40,
        notifier: () => new Promise<void>(() => undefined),
      },
    })
    openHubs.push(hub)

    await post(hub, blockBody())
    const beganAt = Date.now()
    await hub.close()
    const elapsed = Date.now() - beganAt

    expect(elapsed, `the close took ${elapsed} ms`).toBeLessThan(5_000)
    expect(hub.delivery.status()).toMatchObject({ timedOut: 1, delivered: 0 })
    expect(hub.delivery.status().status).toBe('degraded')
  })
})

// ---------------------------------------------------------------------------
// What health says while it happens
// ---------------------------------------------------------------------------

describe('health reports the state the shutdown is in', () => {
  it('says stopping while the ordered close runs, and stopped after it', async () => {
    // The read that a doctor run does mid-shutdown, driven through the health function
    // with an injected service set rather than over a socket, because the window in
    // which a hub answers *and* is stopping is one turn of the event loop wide.
    const stateDir = temporaryDirectory()
    const hub = await startHub({
      stateDir,
      dashboardRoot: null,
      lifecycle: { installSignals: false },
    })
    openHubs.push(hub)
    const store = openEventStore({ filePath: hub.databaseFilePath })
    openStores.push(store)
    const counters = openCounters({ filePath: hub.databaseFilePath })
    openCountersList.push(counters)
    const services = {
      store,
      counters,
      stream: hub.stream,
      ingest: hub.ingest,
      pending: hub.pending,
      delivery: hub.delivery,
      security: hub.security,
      // The card dismissal this hub was built with (NS-3), built the way a headless run
      // gets it: no card renderer, so no card can be showing and every dismissal is a
      // no-op. A real one rather than a literal, so this fixture stays the services
      // object the composition root hands a handler.
      dismissal: createCardDismissal({ remove: null }),
      hub: {
        instanceId: hub.instanceId,
        // The health payload reports this process's own pid, which for a hub in this
        // test process is the test runner's.
        pid: process.pid,
        host: hub.host,
        port: hub.port,
        origin: hub.origin,
        startedAt: hub.startedAt,
        schemaVersion: hub.store.schemaVersion,
        rebuiltFromMigrations: false,
        dashboardRoot: null,
        servedRequests: () => 0,
        listening: () => hub.server.nodeServer.listening,
        state: () => hub.lifecycle.state().state,
        // The desktop section IO-2 added for `doctor`, spelled out rather than read:
        // this fixture is about the lifecycle states, and its hub is a headless one -
        // no bridge, so no tray and no card window. The shape is the composition root's
        // own for a run with no `DesktopBridge`.
        desktop: () => HEADLESS_DESKTOP,
      },
    } satisfies HubServices

    expect(readHealth(services).server.state).toBe('running')

    hub.lifecycle.begin('close')
    const during = readHealth(services)
    expect(during.server.state).toBe('stopping')
    expect(during.server.listening).toBe(true)

    await hub.close()
    expect(readHealth(services).server).toMatchObject({ state: 'stopped', listening: false })
  })

  it('derives the listening flag from the listener rather than asserting it', () => {
    // Asserted from the source, and the reason is worth stating: a stopped listener
    // cannot answer a question about itself. The real socket proves `listening: true`
    // above, and the health function above proves that a `false` is reported faithfully
    // once the hub's own services are used. What neither can reach is the *wiring* in
    // the composition root, so that is what this checks: the flag is read from the
    // bound server at request time, and the identity a hub serves before it binds says
    // it is not listening rather than claiming a port it does not have.
    const source = readFileSync(
      path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'src', 'main', 'index.ts'),
      'utf8',
    )

    expect(source).toContain('listening: (): boolean => server?.nodeServer.listening ?? false')
    // And the pre-bind identity, which is a function for the same reason: a snapshot
    // taken at construction would be a stale claim in a diagnostic payload.
    expect(source).toContain('listening: () => false')
  })

  it('reports the counter values a stopped hub left behind', async () => {
    // The flush is not observable as a return value, so it is observable as a file: a
    // committed-but-unfolded write leaves a write-ahead log, and a flushed database
    // leaves none. A second connection is held open across the close precisely so
    // SQLite's own close-time checkpoint cannot be mistaken for this product's flush.
    const stateDir = temporaryDirectory()
    const hub = await startHub({ stateDir, dashboardRoot: null, lifecycle: { installSignals: false } })
    openHubs.push(hub)

    // A second connection to the same file, held open, plus a committed write.
    const observer = openCounters({ filePath: databaseFilePath(stateDir) })
    openCountersList.push(observer)
    observer.recordToastDelivery()
    observer.recordDashboardOpen()
    expect(walSize(stateDir), 'the write is committed but not yet folded back').toBeGreaterThan(0)

    await hub.close()

    // The flush ran while a connection was still open, so the truncation is the
    // checkpoint this product asked for and not the one SQLite does when the last
    // connection closes.
    expect(walSize(stateDir)).toBe(0)
    // And the values are there, in the file, without a restart having to read them.
    const readings = observer.read()
    expect(readings.find((reading) => reading.counter === 'toast_deliveries')?.value).toBe(1)
    expect(readings.find((reading) => reading.counter === 'dashboard_opens')?.value).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// What the shutdown may not do
// ---------------------------------------------------------------------------

describe('the shutdown path reaches nothing outside this process', () => {
  it('has no member that could signal a harness, a session or another process', () => {
    // agent-ping is a sidecar: it observes agent processes and owns none of them
    // (APX-CON-03, ADR-001). A shutdown that could stop something outside this process
    // would be that violation in its most literal form, so the surface is asserted by
    // name: no kill, no signal, no spawn, no pid it was given.
    const state = harness()
    const members = Object.keys(state.lifecycle).sort()
    expect(members).toEqual([
      'begin',
      'dispose',
      'finish',
      'handledSignals',
      'install',
      'markRunning',
      'shutdown',
      'state',
    ])
    for (const forbidden of ['kill', 'signal', 'spawn', 'send', 'interrupt', 'stop', 'abort']) {
      expect(members, forbidden).not.toContain(forbidden)
    }
    // `shutdown` takes a reason it records; it takes no identifier to act on.
    expect(state.lifecycle.shutdown).toHaveLength(1)
  })

  it('handles only the signals it declares, and a signal name it is given is inert', async () => {
    // A caller cannot extend the set to a signal this product has no opinion about, and
    // cannot pass an arbitrary signal through `shutdown` as a way to act on one: the
    // reason is recorded, never dispatched.
    const state = harness()
    state.lifecycle.install()

    expect(state.lifecycle.handledSignals()).toEqual([...SHUTDOWN_SIGNALS])
    state.signals.fire('SIGHUP')
    state.signals.fire('SIGKILL')
    await settle()

    expect(state.closes).toHaveLength(0)
    expect(state.exits).toEqual([])
  })

  it('starts no subprocess of its own', () => {
    // Asserted from the source because it is an absence: a hub that spawned something
    // during a shutdown would be a supervisor, and this product is a sidecar
    // (ADR-001). The only process calls in this file are the test's own.
    const source = readFileSync(
      path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'src', 'hub', 'lifecycle.ts'),
      'utf8',
    )
    for (const forbidden of ['spawn', 'exec(', 'execFile', 'fork', 'child_process']) {
      expect(source, forbidden).not.toContain(forbidden)
    }
    // The one unlink it performs is its own runtime file, and the one signal it handles
    // is its own.
    expect(source).toContain('unlinkSync(runtimeFilePath(options.stateDir))')
  })
})

// ---------------------------------------------------------------------------
// A hub in this process, kept out of the way of the others
// ---------------------------------------------------------------------------

describe('the fixture hub is the real entry point', () => {
  it('publishes a port an adapter can read, and the process is a real OS process', async () => {
    const stateDir = temporaryDirectory('agent-ping-fixture-')
    const attemptsFile = path.join(temporaryDirectory('agent-ping-attempts-'), 'attempts.jsonl')
    const hub: RealHub = await startRealHub({ stateDir, attemptsFile, notifier: 'ok', preferredPort: SHUTDOWN_PORT_BASE })

    // A separate pid from this test runner: the guarantees below are about a process,
    // and a hub sharing this process could not fail in the ways a real one does.
    expect(hub.pid).toBeGreaterThan(0)
    expect(hub.pid).not.toBe(process.pid)
    expect(readRuntimeFile(stateDir)).toMatchObject({ pid: hub.pid, port: hub.port, host: '127.0.0.1' })

    hub.signal('SIGTERM')
    expect((await hub.waitForExit()).code).toBe(0)
  }, 60_000)
})
