// The macOS notifier: the exact argument list, the payload as discrete arguments, the
// refusal of an fyi, and every way a delivery can fail without that being swallowed
// (NT-FR-01, NT-FR-02, NT-FR-03, NT-FR-08, NT-FR-09, ADR-004, ADR-010, APX-CON-04,
// APX-CON-06, APX-FR-01, APX-FR-02).
//
//   npm test -- tests/notify/macos.test.ts
//
// WHAT IS PROVEN HERE, AND WHAT IS NOT
// The argument list is a pure function, so the first tests assert it exactly, per class.
// The payload-placement claim is then proven against a *real process*: a stub `osascript`
// at the front of PATH that records the argv it was handed, given a title and body full of
// shell metacharacters, AppleScript quotes and a newline. Nothing here mocks
// `child_process` and nothing here needs a Mac.
//
// WHAT IS NOT PROVEN HERE, AND CANNOT BE FROM THIS MACHINE
// That a macOS banner appears, that it is attributed to anything in particular, that the
// two classes are distinguishable on screen, and that the 1.5 s bound is long enough on a
// real machine. This path is NOT live-verified on the authoring machine (APX-CON-06,
// NT-FR-03); those are NT-5's observations on a Mac, listed in
// docs/runbooks/notify-platforms.md. The test below asserts that the runbook says so, and
// that the command it documents is the command this file generates - so the documentation
// a reviewer reads cannot drift from the code being reviewed.

import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  OSASCRIPT,
  OSASCRIPT_COMMAND_TIMEOUT_MS,
  OSASCRIPT_PAYLOAD_TERMINATOR,
  OSASCRIPT_PROBE_ARGS,
  OSASCRIPT_SCRIPT_LINES,
  buildOsascriptCommand,
  createMacosNotifier,
  probeMacosNotifier,
} from '@/notify/macos'
import { createNodeCommandRunner } from '@/notify/command'
import { planNotification } from '@/notify/policy'
import { createPlatformNotifier } from '@/notify/registry'
import type { NotificationRequest as HubNotificationRequest } from '@/hub/delivery'
import type { NotificationCommand, NotificationCommandRunner, NotificationRequest } from '@/notify/types'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION = 'ses_macos_01'
const ORIGIN = 'http://127.0.0.1:43731'
const REPO = 'agent-ping'

/**
 * The two lines a real `agent-ping` block produces, written out here.
 *
 * Spelled literally rather than read back from the policy, because the assertion is that
 * the two of them agree - a test that built its expectation with the same function it is
 * testing would pass whatever that function produced, including a title that had become
 * a prompt (APX-FR-01).
 */
const NEEDS_YOU_BODY = 'A session is blocked and needs a decision from you.'
const FINISHED_BODY = 'A session finished after working.'

/** A title and body built to be hostile, in the ways this platform cares about. */
const HOSTILE_TITLE = 'repo $(touch /tmp/pwned) `touch /tmp/pwned2`; touch /tmp/pwned3'
const HOSTILE_BODY = 'body && touch /tmp/pwned4 | "quoted" \'single\'\nnewline & <tag>'

const RUNBOOK = fileURLToPath(new URL('../../docs/runbooks/notify-platforms.md', import.meta.url))

const temporaryDirectories: string[] = []

function temporaryDirectory(prefix = 'agent-ping-macos-'): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/** A request for one class, rendered exactly as the class policy renders it. */
function requestFor(eventClass: 'needs-you' | 'finished'): NotificationRequest {
  const plan = planNotification({
    class: eventClass,
    repoShortName: REPO,
    origin: ORIGIN,
    sessionId: SESSION,
  })
  if (plan.kind !== 'deliver') throw new Error('expected a delivered plan')
  return plan.request
}

/**
 * A stub `osascript`, written into a directory of its own.
 *
 * A real executable with a real shebang, at the front of PATH, so the product starts it
 * exactly as it would start the installed tool - through PATH, with the argument array it
 * built, with no shell. The argv is recorded NUL-delimited, because an argument may
 * legitimately contain a newline and a line-delimited record could not tell one argument
 * from two.
 */
function stubOsascript(options: {
  readonly exit?: number
  readonly stderr?: string
  readonly body?: string
} = {}): { readonly directory: string; readonly recordFile: string } {
  const directory = temporaryDirectory('agent-ping-macos-bin-')
  const recordFile = path.join(directory, 'argv.txt')
  const lines =
    options.body ??
    [
      '#!/bin/sh',
      `for arg in "$@"; do printf '%s\\0' "$arg" >> ${shellQuote(recordFile)}; done`,
      ...(options.stderr === undefined ? [] : [`printf '%s\\n' ${shellQuote(options.stderr)} >&2`]),
      `exit ${String(options.exit ?? 0)}`,
    ].join('\n')
  writeFileSync(path.join(directory, OSASCRIPT), `${lines}\n`)
  chmodSync(path.join(directory, OSASCRIPT), 0o755)
  return { directory, recordFile }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** `before` and `after`, for the one thing a test cannot inject: the environment. */
async function withPath<T>(value: string, body: () => Promise<T>): Promise<T> {
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
function recordedArgv(recordFile: string): string[] {
  if (!existsSync(recordFile)) return []
  return readFileSync(recordFile, 'utf8').split('\0').slice(0, -1)
}

/**
 * The real runner, so most of these tests start a real process rather than a fake one.
 *
 * The production runner from the shared command boundary, with only the bound changed, so
 * what these tests observe is what production does with the same argument list: `shell:
 * false`, stdin closed, stderr collected to a bound, and a child killed at that bound.
 */
function realRunner(timeoutMs = 5_000): NotificationCommandRunner {
  return createNodeCommandRunner({ timeoutMs })
}

/** One hub-shaped request, for the composed registry path (the shape the hub hands over). */
function hubRequest(eventClass: 'needs-you' | 'fyi'): HubNotificationRequest {
  return {
    event: {
      eventId: `evt_${eventClass}`,
      sessionId: SESSION,
      class: eventClass,
      subtype: null,
      rawEventType: 'permission.asked',
      occurredAt: '2026-09-26T09:00:00.000Z',
      receivedAt: '2026-09-26T09:00:00.000Z',
      dedupeKey: `opencode:${SESSION}:${eventClass}`,
      ackState: 'unacknowledged',
      resolutionState: 'unresolved',
    },
    class: eventClass,
    pendingCount: 1,
    repoShortName: REPO,
    origin: ORIGIN,
    source: 'event',
  }
}

// ---------------------------------------------------------------------------
// The argument list
// ---------------------------------------------------------------------------

describe('the osascript invocation is exactly this, per class', () => {
  it('passes the title and the body as the last two arguments, after the terminator', () => {
    // The whole of NT-FR-03's argument claim, for the class that matters most. The script
    // is a constant; only the two lines change, and they change as two arguments.
    expect(buildOsascriptCommand(requestFor('needs-you'))).toEqual({
      file: 'osascript',
      args: [
        '-e',
        'on run argv',
        '-e',
        'display notification ((item 2 of argv) as text) with title ((item 1 of argv) as text)',
        '-e',
        'end run',
        '--',
        REPO,
        NEEDS_YOU_BODY,
      ],
    })
  })

  it('builds the same array for a finished turn, with that class\'s sentence', () => {
    // Same shape, different words. That is the honest difference between the two delivered
    // classes on this platform, and asserting it exactly is what stops a second policy
    // appearing here (NT-FR-02, NT-FR-03).
    expect(buildOsascriptCommand(requestFor('finished'))).toEqual({
      file: OSASCRIPT,
      args: [
        '-e',
        'on run argv',
        '-e',
        'display notification ((item 2 of argv) as text) with title ((item 1 of argv) as text)',
        '-e',
        'end run',
        '--',
        REPO,
        FINISHED_BODY,
      ],
    })
  })

  it('reads the two lines out of the handler\'s own argv, in title-then-body order', () => {
    // If the order were ever swapped, the repository name would be the sentence. The
    // script text and the argument positions are asserted together so neither can move
    // alone.
    const command = buildOsascriptCommand(requestFor('needs-you'))
    const display = OSASCRIPT_SCRIPT_LINES[1] ?? ''
    expect(command.args).toContain(display)
    expect(display).toMatch(/^display notification \(\(item 2 of argv\)/)
    expect(display).toMatch(/with title \(\(item 1 of argv\)/)
    // The terminator sits immediately before the payload, and the payload is the last two
    // arguments in title-then-body order.
    expect(command.args.at(-3)).toBe(OSASCRIPT_PAYLOAD_TERMINATOR)
    expect(command.args.at(-2)).toBe(REPO)
    expect(command.args.at(-1)).toBe(NEEDS_YOU_BODY)
    expect(OSASCRIPT_SCRIPT_LINES[0]).toBe('on run argv')
    expect(OSASCRIPT_SCRIPT_LINES[2]).toBe('end run')
  })

  it('never interpolates a title or a body into the script, whatever they contain', () => {
    // The claim that separates this from the obvious implementation. The prefix of the
    // argument list - everything except the two lines - is asserted to be byte-identical
    // for a benign request and for one built to be hostile, so there is nothing left in the
    // script that a title could have altered.
    const hostile = { ...requestFor('needs-you'), title: HOSTILE_TITLE, body: HOSTILE_BODY }
    const benign = buildOsascriptCommand(requestFor('needs-you'))
    const hostileCommand = buildOsascriptCommand(hostile)
    expect(hostileCommand.args.slice(0, -2)).toEqual(benign.args.slice(0, -2))
    expect(hostileCommand.args.slice(-2)).toEqual([HOSTILE_TITLE, HOSTILE_BODY])
    // And no AppleScript literal is even opened, so there is nothing for a quote to escape.
    for (const line of OSASCRIPT_SCRIPT_LINES) {
      expect(line).not.toContain('"')
    }
    expect(OSASCRIPT_SCRIPT_LINES.join('\n')).not.toContain(HOSTILE_TITLE)
  })

  it('is a pure function of the request, and does not modify it', () => {
    const request = requestFor('finished')
    const before = JSON.stringify(request)
    const first = buildOsascriptCommand(request)
    expect(buildOsascriptCommand(request)).toEqual(first)
    expect(JSON.stringify(request)).toBe(before)
  })

  it('passes no sound-capable argument, for either class (APX-CON-04)', () => {
    // `display notification` has a `sound name` parameter and this must not use it. The
    // sweep is over every argument, script lines included, so an edit that adds a sound
    // fails rather than shipping (APX-CON-04).
    const soundCapable = ['sound name', 'sound', '-s', 'audio', 'bell', 'chime', 'beep', 'ding', 'tone']
    for (const eventClass of ['needs-you', 'finished'] as const) {
      const { file, args } = buildOsascriptCommand(requestFor(eventClass))
      for (const arg of args) {
        for (const forbidden of soundCapable) {
          expect(arg.toLowerCase(), `${eventClass}: ${arg}`).not.toContain(forbidden)
        }
      }
      expect(file).toBe('osascript')
    }
  })

  it('carries a bound shorter than the call bound in the hub, so a wedged process is killed', () => {
    // APX-CON-10: the child is killed at this file's bound rather than a promise being
    // abandoned with the process still running.
    expect(OSASCRIPT_COMMAND_TIMEOUT_MS).toBeLessThan(2_000)
  })
})

// ---------------------------------------------------------------------------
// The fyi refusal
// ---------------------------------------------------------------------------

describe('an fyi never reaches osascript', () => {
  it('refuses an fyi request, and starts no process at all', async () => {
    // NT-FR-02 on this platform: the refusal comes from the one class table, the outcome
    // carries no command because none was built, and the runner was never called. A test
    // that only checked the outcome would still pass if a process had been started and
    // then reported as refused.
    const commands: NotificationCommand[] = []
    const diagnostics: string[] = []
    const notifier = createMacosNotifier({
      run: (command) => {
        commands.push(command)
        return Promise.resolve({ code: 0, signal: null, spawnError: null, stderr: '' })
      },
      onDiagnostic: (message) => diagnostics.push(message),
    })

    const outcome = await notifier({
      ...requestFor('needs-you'),
      class: 'fyi',
    })

    expect(outcome).toEqual({ status: 'refused', reason: 'refused-in-app-only', platform: 'macos' })
    expect(outcome.command).toBeUndefined()
    expect(commands).toEqual([])
    // A correct refusal is not a fault, so it is not a line in the operator's log either.
    expect(diagnostics).toEqual([])
  })

  it('refuses through the registry too, when the hub asks the macOS notifier for an fyi', async () => {
    // The composed path, because that is the one production uses: the registry's macOS
    // entry plans the request and never reaches a platform notifier for a refused class.
    const commands: NotificationCommand[] = []
    const resolution = createPlatformNotifier({
      platform: 'darwin',
      run: (command) => {
        commands.push(command)
        return Promise.resolve({ code: 0, signal: null, spawnError: null, stderr: '' })
      },
    })
    if (!resolution.supported) throw new Error('expected macOS to be supported')
    await resolution.notifier(hubRequest('fyi'))
    expect(commands).toEqual([])
  })

  it('delivers a block through the registry as exactly the command asserted above', async () => {
    // The other half of the same composed path, so "the registry's macOS entry is the
    // notifier in this file" is a fact rather than a naming convention.
    const commands: NotificationCommand[] = []
    const resolution = createPlatformNotifier({
      platform: 'darwin',
      run: (command) => {
        commands.push(command)
        return Promise.resolve({ code: 0, signal: null, spawnError: null, stderr: '' })
      },
    })
    if (!resolution.supported) throw new Error('expected macOS to be supported')
    const outcome = await resolution.notifier(hubRequest('needs-you'))

    expect(commands).toEqual([buildOsascriptCommand(requestFor('needs-you'))])
    expect(outcome).toMatchObject({ status: 'delivered', platform: 'macos', exitCode: 0 })
  })
})

// ---------------------------------------------------------------------------
// The real process
// ---------------------------------------------------------------------------

describe('a real process receives the payload as discrete arguments', () => {
  it('hands a hostile title and body to a real stub without a shell expanding them', async () => {
    const markerDirectory = temporaryDirectory('agent-ping-macos-markers-')
    const { directory, recordFile } = stubOsascript()
    const notifier = createMacosNotifier({ run: realRunner() })
    const request = requestFor('needs-you')
    const hostile = {
      ...request,
      title: HOSTILE_TITLE.replaceAll('/tmp/', `${markerDirectory}/`),
      body: HOSTILE_BODY.replaceAll('/tmp/', `${markerDirectory}/`),
    }

    const outcome = await withPath(directory, () => notifier(hostile))

    expect(outcome.status).toBe('delivered')
    const argv = recordedArgv(recordFile)
    expect(argv.slice(-2)).toEqual([hostile.title, hostile.body])
    // The newline in the body did not become two arguments, because nothing split a string.
    expect(argv).toHaveLength(OSASCRIPT_SCRIPT_LINES.length * 2 + 3)
    // Nothing was expanded: no marker file exists and the substitutions are still text.
    expect(readdirSync(markerDirectory)).toEqual([])
    expect(argv.join('\n')).toContain('$(touch')
  })

  it('records the real exit status as a failure with a reason and a diagnostic', async () => {
    // APX-FR-02 and NT-FR-09: a real process exiting 3, the code on the outcome, the
    // tool's own complaint on the diagnostic line, and no content in either.
    const { directory, recordFile } = stubOsascript({ exit: 3, stderr: 'stub: no notification centre' })
    const diagnostics: string[] = []
    const notifier = createMacosNotifier({ run: realRunner(), onDiagnostic: (m) => diagnostics.push(m) })

    const outcome = await withPath(directory, () => notifier(requestFor('needs-you')))

    expect(outcome).toMatchObject({
      status: 'failed',
      reason: 'command-failed',
      platform: 'macos',
      exitCode: 3,
      detail: 'stub: no notification centre',
    })
    expect(recordedArgv(recordFile)).toHaveLength(OSASCRIPT_SCRIPT_LINES.length * 2 + 3)
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatch(/did not happen \(command-failed, exit 3\)/)
    expect(diagnostics[0]).toContain('no notification centre')
    expect(diagnostics[0]).not.toContain(NEEDS_YOU_BODY)
  })

  it('records a missing osascript as a failure, not as a delivered notification', async () => {
    // An empty PATH: the real spawn cannot find the tool, and there is no exit code for a
    // process that never ran. Reporting `delivered` here would be the lie APX-FR-02
    // forbids.
    const empty = temporaryDirectory('agent-ping-macos-empty-')
    const diagnostics: string[] = []
    const notifier = createMacosNotifier({ run: realRunner(), onDiagnostic: (m) => diagnostics.push(m) })

    const outcome = await withPath(empty, () => notifier(requestFor('needs-you')))

    expect(outcome).toMatchObject({
      status: 'failed',
      reason: 'command-not-found',
      platform: 'macos',
      exitCode: null,
    })
    expect(diagnostics.join('\n')).toMatch(/command-not-found/)
  })

  it('kills a process that hangs, and records which way it failed', async () => {
    // The stub would create its marker five seconds in; the bound is 250 ms, so the
    // marker's absence is the proof that the process was stopped rather than merely
    // unobserved (APX-CON-10).
    const markerDirectory = temporaryDirectory('agent-ping-macos-hang-')
    const marker = path.join(markerDirectory, 'finished.txt')
    const { directory } = stubOsascript({
      body: `#!/bin/sh\nsleep 5\nprintf 'ran\\n' > ${shellQuote(marker)}\n`,
    })
    const notifier = createMacosNotifier({ run: realRunner(250) })

    const began = Date.now()
    const outcome = await withPath(`${directory}:/usr/bin:/bin`, () => notifier(requestFor('finished')))
    const elapsed = Date.now() - began

    expect(outcome).toMatchObject({ status: 'failed', reason: 'command-timed-out', exitCode: null })
    expect(elapsed).toBeLessThan(2_000)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(existsSync(marker)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

describe('the availability probe reports, and never delivers', () => {
  it('asks for a script that touches nothing, and nothing else', async () => {
    // `return 1` compiles, runs and exits without contacting anything. A probe that could
    // put a banner on a developer's screen is a probe nobody runs, and `install` runs this
    // on a real machine (NT-FR-09, IO-2).
    const { directory, recordFile } = stubOsascript()
    const availability = await withPath(directory, () => probeMacosNotifier())
    expect(availability).toEqual({ available: true, platform: 'macos', reason: 'available' })
    expect(recordedArgv(recordFile)).toEqual(OSASCRIPT_PROBE_ARGS)
    expect(OSASCRIPT_PROBE_ARGS.join(' ')).not.toMatch(/display notification/)
  })

  it('says a tool that is not installed is not available, with which reason', async () => {
    const empty = temporaryDirectory('agent-ping-macos-empty-')
    const availability = await withPath(empty, () => probeMacosNotifier())
    expect(availability).toMatchObject({ available: false, platform: 'macos', reason: 'command-not-found' })
  })

  it('says a tool that cannot run is unusable rather than available', async () => {
    const { directory } = stubOsascript({ exit: 1, stderr: 'stub: refusing' })
    const availability = await withPath(directory, () => probeMacosNotifier())
    expect(availability).toMatchObject({ available: false, platform: 'macos', reason: 'command-unusable' })
  })
})

// ---------------------------------------------------------------------------
// The runbook
// ---------------------------------------------------------------------------

describe('the runbook names the command, and says this path is not live-verified here', () => {
  it('documents the exact command this file generates, for both delivered classes', () => {
    // The AC: the runbook names the manual command per platform. Asserting that the
    // documented line *is* the generated one means a developer who copies it out of the
    // runbook runs what the product runs, and it cannot go stale quietly.
    const blocks = shBlocks(readFileSync(RUNBOOK, 'utf8'))
    for (const eventClass of ['needs-you', 'finished'] as const) {
      expect(blocks, eventClass).toContain(displayCommand(buildOsascriptCommand(requestFor(eventClass))))
    }
  })

  it('states that the macOS path is not live-verified on the authoring machine', () => {
    // The same claim NT-5 depends on, asserted rather than trusted. A runbook that quietly
    // dropped this sentence would let a later reader treat the path as proven.
    const text = readFileSync(RUNBOOK, 'utf8')
    expect(text).toMatch(/macOS and Windows paths are NOT live-verified on the authoring machine/)
    expect(text).toContain('docs/reviews/notification-macos-windows.json')
    // ...and names the per-platform manual step, for both platforms.
    expect(text).toMatch(/## 3\. macOS/)
    expect(text).toMatch(/## 4\. Windows/)
  })
})

// ---------------------------------------------------------------------------
// Helpers that need the module under test or the runbook
// ---------------------------------------------------------------------------

/**
 * A command as a developer would type it.
 *
 * The tool bare, and each argument quoted only when it needs it - which is what makes the
 * result both copy-pasteable and comparable to the runbook's fenced block, which is
 * written the way a person would type it.
 */
function displayCommand(command: NotificationCommand): string {
  return [command.file, ...command.args].map(quoteIfNeeded).join(' ')
}

/** The `sh` rule of thumb: a token of unremarkable characters needs no quoting. */
function quoteIfNeeded(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : shellQuote(value)
}

/** Every ```sh fenced block in the runbook, whitespace-collapsed. */
function shBlocks(markdown: string): string[] {
  return fencedBlocks(markdown, 'sh').map(collapse)
}

function fencedBlocks(markdown: string, language: string): string[] {
  const blocks: string[] = []
  const pattern = new RegExp('```' + language + '\\n([\\s\\S]*?)```', 'g')
  for (const match of markdown.matchAll(pattern)) {
    const body = match[1]
    if (body !== undefined) blocks.push(body)
  }
  return blocks
}

function collapse(value: string): string {
  return value.replaceAll(/\s+/g, ' ').trim()
}
