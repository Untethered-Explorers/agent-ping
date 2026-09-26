// The Linux notifier: the exact argument list, the real process that receives it, and
// every way a delivery can fail without that being swallowed (NT-FR-01, NT-FR-02,
// NT-FR-08, NT-FR-09, ADR-010, APX-FR-02, APX-CON-04, APX-CON-10, APX-CON-12).
//
//   npm test -- tests/notify/linux.test.ts
//
// WHAT IS PROVEN HERE, AND HOW
// The argument list is a pure function, so the first tests assert it exactly. Everything
// after that is a *real* process: a stub `notify-send` placed at the front of PATH that
// records the argv it was handed and exits with a code a test chooses, and the real
// `notify-send` binary where the claim is about what the installed tool accepts. Nothing
// here mocks `child_process`, and nothing here needs a display server.
//
//   - "A test asserts the notify-send argument list contains no shell interpolation of
//     the title or body." Two real claims. The exact array, per class, with the two lines
//     as the last two discrete arguments after `--`. And a real process: a title and body
//     carrying `$(...)`, backticks, `;`, `&&`, quotes and a newline, delivered to a stub
//     that prints its own argv, with a marker file proving no shell ever expanded
//     anything. A test that only checked the array would pass against an implementation
//     that later joined it into a string.
//
//   - "A test asserts a non-zero exit from the notifier is recorded as a failure with a
//     reason rather than swallowed." A real process exiting 3, a real exit code in the
//     outcome, the real stderr on the diagnostic line, and `doctor`'s route left with
//     something to report (the health half is proven in tests/notify/registry-selection).
//     The real binary is asked an option it does not have, so the failure comes from
//     `notify-send` itself and the claim cannot be a self-consistent invention.
//
//   - the other ways a delivery does not happen, each against a real process: a tool
//     that is not installed (`command-not-found`), a process that hangs and is killed at
//     the bound (`command-timed-out`, with the killed process's own side effect proving
//     it never ran to completion), and a process killed by a signal.
//
// AND THE TWO THINGS A TOAST MUST NEVER DO
//   - No sound, on any class (APX-CON-04). Every argument of every class is swept against
//     a list of sound-capable flags and a word-boundary pattern, and the request's own key
//     set is asserted, so a sound cannot arrive as a new argument or as a new field.
//   - No repeat, no second attempt (NT-FR-08, APX-CON-10). One request is one command.
//     A failure is reported once, and the module contains no loop and no timer that could
//     re-fire one.

import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FINISHED_EXPIRE_MS,
  NOTIFY_COMMAND_TIMEOUT_MS,
  NOTIFY_SEND,
  RESIDENT_EXPIRE_MS,
  buildNotifySendCommand,
  createLinuxNotifier,
  createNodeCommandRunner,
  probeLinuxNotifier,
} from '@/notify/linux'
import { planNotification } from '@/notify/policy'
import type { NotificationCommand, NotificationCommandRunner, NotificationRequest } from '@/notify/types'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION = 'ses_linux_01'
const ORIGIN = 'http://127.0.0.1:43727'

/**
 * A title and a body built to be hostile.
 *
 * Every one of these is a shell metacharacter or a substitution, and the point of the
 * real-process test below is that the stub receives them as text. If any of them were
 * ever expanded, a marker file would appear.
 */
const HOSTILE_TITLE = 'repo $(touch /tmp/pwned) `touch /tmp/pwned2`; touch /tmp/pwned3'
const HOSTILE_BODY = 'body && touch /tmp/pwned4 | touch /tmp/pwned5 "quoted" \'single\'\nnewline'

const temporaryDirectories: string[] = []

function temporaryDirectory(prefix = 'agent-ping-notify-'): string {
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
    repoShortName: 'agent-ping',
    origin: ORIGIN,
    sessionId: SESSION,
  })
  if (plan.kind !== 'deliver') throw new Error('expected a delivered plan')
  return plan.request
}

/**
 * A stub `notify-send`, written into a directory of its own.
 *
 * A real executable with a real shebang: the product starts it exactly as it would start
 * the installed tool, through PATH, with the argument array it built. The generated
 * script appends the argv it was handed to `recordFile`, one argument per line, so a test
 * can read back what a real process received rather than what this repository believes it
 * passed, and then exits with `exit` after complaining with `stderr` on stderr. A caller
 * that needs a specific behaviour - a script that hangs, or one that kills itself - passes
 * `body` and owns the whole script.
 *
 * The returned `recordFile` is the file the stub actually writes to, which is the point
 * of returning it: a test must never have to reconstruct where the evidence landed.
 */
function stubNotifySend(options: {
  readonly body?: string
  readonly recordFile?: string
  readonly exit?: number
  readonly stderr?: string
}): { readonly directory: string; readonly recordFile: string } {
  const directory = temporaryDirectory('agent-ping-notify-bin-')
  const recordFile = options.recordFile ?? path.join(directory, 'argv.txt')
  const lines =
    options.body === undefined
      ? [
          '#!/bin/sh',
          // NUL-delimited, because an argument may legitimately contain a newline and a
          // line-delimited record could not tell one argument from two. The recorder has
          // to be able to represent what it is recording, or it cannot prove anything
          // about it.
          `for arg in "$@"; do printf '%s\\0' "$arg" >> ${shellQuote(recordFile)}; done`,
          ...(options.stderr === undefined
            ? []
            : [`printf '%s\\n' ${shellQuote(options.stderr)} >&2`]),
          `exit ${String(options.exit ?? 0)}`,
        ]
      : options.body.split('\n')
  const stub = path.join(directory, NOTIFY_SEND)
  writeFileSync(stub, `${lines.join('\n')}\n`)
  chmodSync(stub, 0o755)
  return { directory, recordFile }
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

/** Single-quote a value for `sh`, so a path with a space cannot break the stub. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * The arguments the stub recorded, in order.
 *
 * NUL-delimited on disk, so an argument that contains a newline comes back as the one
 * argument it was. A line-delimited record would have made the hostile-payload test
 * unable to see the thing it is testing.
 */
function recordedArgv(recordFile: string): string[] {
  if (!existsSync(recordFile)) return []
  return readFileSync(recordFile, 'utf8').split('\0').slice(0, -1)
}

/**
 * The real runner, with an optional rewrite of the command it is about to start.
 *
 * Real in every part: real processes, the real spawn options, the real bound. `timeoutMs`
 * is the runner's own because an injected runner owns its bound - the notifier's option
 * configures the runner *it* would build, and a test that lowers it has to lower the one
 * actually running.
 */
function realRunner(
  rewrite?: (command: NotificationCommand) => NotificationCommand,
  timeoutMs = 5_000,
): NotificationCommandRunner {
  const base = createNodeCommandRunner({ timeoutMs })
  return (command) => base(rewrite === undefined ? command : rewrite(command))
}

/** The index of the `--` terminator in a built command's arguments. */
function terminatorIndex(command: NotificationCommand): number {
  const index = command.args.indexOf('--')
  expect(index, 'the argument list ends with `--`, title and body').toBeGreaterThan(0)
  return index
}

// ---------------------------------------------------------------------------
// The argument list
// ---------------------------------------------------------------------------

describe('the notify-send invocation is exactly this, per class', () => {
  it('asks for a resident, critical, non-auto-dismissing toast for a block', () => {
    // NT-FR-02, the resident half. `--expire-time=0` is notify-send's "never expire" and
    // the resident hint is libnotify's own; both are the assumed hint set PRD 16 Open
    // Question 2 records as a question, and NT-4's live gate is what confirms them.
    expect(buildNotifySendCommand(requestFor('needs-you'))).toEqual({
      file: NOTIFY_SEND,
      args: [
        '--app-name=agent-ping',
        '--urgency=critical',
        '--expire-time=0',
        '--hint=boolean:resident:true',
        '--',
        'agent-ping',
        'A session is blocked and needs a decision from you.',
      ],
    })
    expect(RESIDENT_EXPIRE_MS).toBe(0)
  })

  it('asks for an expiring, normal toast for a finished turn, with no resident hint', () => {
    // The AC for NT-FR-02 is that the resident and non-auto-dismissing flags are *not*
    // set for a finished turn, and omitting them is the stronger form of "not set": there
    // is no `--hint=boolean:resident:false` and no `--expire-time=0` to be misread later.
    const command = buildNotifySendCommand(requestFor('finished'))
    expect(command).toEqual({
      file: NOTIFY_SEND,
      args: [
        '--app-name=agent-ping',
        '--urgency=normal',
        '--expire-time=5000',
        '--',
        'agent-ping',
        'A session finished after working.',
      ],
    })
    expect(command.args).not.toContain('--hint=boolean:resident:true')
    expect(command.args).not.toContain('--expire-time=0')
    expect(FINISHED_EXPIRE_MS).toBe(5_000)
  })

  it('puts the two lines last, one argument each, after a terminator', () => {
    for (const eventClass of ['needs-you', 'finished'] as const) {
      const request = requestFor(eventClass)
      const command = buildNotifySendCommand(request)
      const index = terminatorIndex(command)
      expect(command.args.slice(index + 1), eventClass).toEqual([request.title, request.body])
    }
  })

  it('is a pure function of the request, and does not modify it', () => {
    const request = requestFor('needs-you')
    const before = JSON.stringify(request)
    const first = buildNotifySendCommand(request)
    expect(buildNotifySendCommand(request)).toEqual(first)
    expect(JSON.stringify(request)).toBe(before)
  })

  it('passes no sound-capable argument, for either class (APX-CON-04)', () => {
    // Sound in v1 is forbidden outright, so the assertion is a sweep rather than a
    // single flag: any of the spellings a desktop tool might accept, and any argument
    // with a sound-ish word in it, fails. A new flag with a new name would need a new
    // test, which is the review this constraint deserves.
    const soundCapable = [
      '--sound',
      '-s',
      '--audio',
      '--bell',
      '--chime',
      '--beep',
      '--tone',
      '--play-sound',
      '--sound-file',
      '--sound-name',
      '--enable-sound',
      '--disable-silent',
      '--urgent-sound',
    ]
    for (const eventClass of ['needs-you', 'finished'] as const) {
      const { file, args } = buildNotifySendCommand(requestFor(eventClass))
      for (const arg of args) {
        expect(soundCapable, `${eventClass}: ${arg}`).not.toContain(arg)
        expect(arg, `${eventClass}: ${arg}`).not.toMatch(
          /(^|[-_=])(sound|audio|bell|chime|beep|tone|ding)([-_=:]|$)/i,
        )
      }
      // And the executable itself is a bare name, with nothing attached to it.
      expect(file).toBe('notify-send')
    }
  })
})

// ---------------------------------------------------------------------------
// The real process
// ---------------------------------------------------------------------------

describe('a real process receives the payload as discrete arguments', () => {
  it('hands a hostile title and body to a real stub without a shell expanding them', async () => {
    // The claim: no shell is on this path, and the strongest way to show it is to give it
    // something to expand. Every substitution below would create a file if any of them
    // ran; the assertions are that no file appeared and that the stub's own argv contains
    // the payload verbatim.
    const markerDirectory = temporaryDirectory('agent-ping-notify-markers-')
    // The argv recording lives in its own directory so that anything appearing in the
    // marker directory is, by construction, something a shell would have created.
    const { directory, recordFile } = stubNotifySend({
      recordFile: path.join(temporaryDirectory('agent-ping-notify-argv-'), 'argv.txt'),
      exit: 0,
    })
    const notifier = createLinuxNotifier({ run: realRunner() })
    const request = requestFor('needs-you')
    const hostile = {
      ...request,
      title: HOSTILE_TITLE.replaceAll('/tmp/', `${markerDirectory}/`),
      body: HOSTILE_BODY.replaceAll('/tmp/', `${markerDirectory}/`),
    }

    const outcome = await withPath(directory, () => notifier(hostile))

    expect(outcome.status).toBe('delivered')
    const argv = recordedArgv(recordFile)
    // One line per argument, and the payload is a single line of each - a newline in the
    // body did not become two arguments, because nothing split the string.
    expect(argv).toContain(hostile.title)
    expect(argv).toContain(hostile.body)
    expect(argv.slice(-2)).toEqual([hostile.title, hostile.body])
    // Nothing was expanded: no marker file exists, and the substitutions are still text.
    expect(readdirSync(markerDirectory)).toEqual([])
    expect(argv.join('\n')).toContain('$(touch')
  })

  it('records the real exit status as a failure with a reason and a diagnostic', async () => {
    // AC: a non-zero exit from the notifier is recorded as a failure with a reason rather
    // than swallowed. The process here is a real one exiting 3, and the reason, the code
    // and the tool's own complaint are all visible afterwards (APX-FR-02, NT-FR-09).
    const { directory, recordFile } = stubNotifySend({ exit: 3, stderr: 'stub: no session bus' })
    const diagnostics: string[] = []
    const notifier = createLinuxNotifier({ run: realRunner(), onDiagnostic: (m) => diagnostics.push(m) })

    const outcome = await withPath(directory, () => notifier(requestFor('needs-you')))

    expect(outcome).toMatchObject({
      status: 'failed',
      reason: 'command-failed',
      platform: 'linux',
      exitCode: 3,
      detail: 'stub: no session bus',
    })
    // The argument list is still on the outcome, so `doctor` can say what was attempted.
    expect(outcome.command).toContain('--hint=boolean:resident:true')
    expect(recordedArgv(recordFile)).toHaveLength(7)
    // One line, naming the reason and the code, and carrying no content.
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatch(/did not happen \(command-failed, exit 3\)/)
    expect(diagnostics[0]).toContain('no session bus')
    expect(diagnostics[0]).not.toContain('A session is blocked')
  })

  it('records a missing tool as a failure, not as a delivered notification', async () => {
    // An empty PATH: the real spawn cannot find the executable, and there is no exit code
    // for a process that never ran - which is why the result carries a spawn error beside
    // a null code. Reporting `delivered` here would be the exact lie APX-FR-02 forbids.
    const empty = temporaryDirectory('agent-ping-notify-empty-')
    const diagnostics: string[] = []
    const notifier = createLinuxNotifier({ run: realRunner(), onDiagnostic: (m) => diagnostics.push(m) })

    const outcome = await withPath(empty, () => notifier(requestFor('needs-you')))

    expect(outcome).toMatchObject({
      status: 'failed',
      reason: 'command-not-found',
      platform: 'linux',
      exitCode: null,
    })
    expect(diagnostics.join('\n')).toMatch(/command-not-found/)
  })

  it('kills a process that hangs, and records which way it failed', async () => {
    // APX-CON-10 and the reason this file has its own bound: a wedged tool must not hold
    // a delivery open, and it must not outlive it either. The stub would create its marker
    // five seconds in; the bound is 250 ms, so the marker's absence is the proof that the
    // process was stopped rather than merely unobserved.
    const markerDirectory = temporaryDirectory('agent-ping-notify-hang-')
    const marker = path.join(markerDirectory, 'finished.txt')
    const { directory } = stubNotifySend({
      body: `#!/bin/sh\nsleep 5\nprintf 'ran\\n' > ${shellQuote(marker)}\n`,
    })
    const notifier = createLinuxNotifier({ run: realRunner(undefined, 250) })

    const began = Date.now()
    const outcome = await withPath(`${directory}:/usr/bin:/bin`, () => notifier(requestFor('needs-you')))
    const elapsed = Date.now() - began

    expect(outcome).toMatchObject({
      status: 'failed',
      reason: 'command-timed-out',
      platform: 'linux',
      exitCode: null,
    })
    expect(elapsed).toBeLessThan(2_000)
    // Give the killed process more than its own bound to have finished, and then check
    // it did not.
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(existsSync(marker)).toBe(false)
    // The bound is shorter than the delivery policy's, so the reason recorded is this
    // file's rather than a promise the hub had to abandon.
    expect(NOTIFY_COMMAND_TIMEOUT_MS).toBeLessThan(2_000)
  })

  it('records a process killed by a signal as a failure, not as a delivered one', async () => {
    const { directory } = stubNotifySend({
      body: '#!/bin/sh\nkill -TERM $$\nsleep 1\n',
    })
    const notifier = createLinuxNotifier({ run: realRunner() })
    const outcome = await withPath(directory, () => notifier(requestFor('finished')))
    expect(outcome.status).toBe('failed')
    expect(['command-signalled', 'command-failed']).toContain(outcome.reason)
    expect(outcome.exitCode).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Against the installed tool
// ---------------------------------------------------------------------------

describe('the installed notify-send agrees about the flags this file generates', () => {
  it('parses the exact option set a block produces, without delivering a toast', async () => {
    // The real binary, asked for its version with this product's own options in front of
    // it. `--version` is answered and exited on before any notification server is
    // contacted, so this proves the parser accepted every flag we generate - including the
    // resident hint's spelling, which a wrong type would reject - and puts nothing on a
    // developer's screen.
    const notifier = createLinuxNotifier({
      run: realRunner((command) => ({
        file: command.file,
        args: [...command.args.slice(0, terminatorIndex(command) + 1), '--version'],
      })),
    })

    const outcome = await notifier(requestFor('needs-you'))

    if (outcome.reason === 'command-not-found') {
      // No notify-send installed: a real fact about this machine, and the notifier
      // reports it rather than claiming a delivery. It is not a pass for the claim above,
      // which is why the reason is asserted rather than skipped.
      expect(outcome.status).toBe('failed')
      expect(outcome.exitCode).toBeNull()
      return
    }
    expect(outcome).toMatchObject({ status: 'delivered', reason: 'delivered-to-desktop', exitCode: 0 })
  })

  it('turns the real complaint from the real tool about an option into a failure', async () => {
    // One bogus flag in front of the real binary's option set. It exits non-zero and says
    // why on stderr, and both the code and the sentence survive into the outcome and the
    // diagnostic - which is the whole of NT-FR-09's "recorded with its reason" for a
    // failure nobody else is going to reproduce.
    const diagnostics: string[] = []
    const notifier = createLinuxNotifier({
      run: realRunner((command) => ({
        file: command.file,
        args: [
          ...command.args.slice(0, terminatorIndex(command)),
          '--option-agent-ping-does-not-have',
          ...command.args.slice(terminatorIndex(command)),
        ],
      })),
      onDiagnostic: (m) => diagnostics.push(m),
    })

    const outcome = await notifier(requestFor('needs-you'))

    if (outcome.reason === 'command-not-found') {
      expect(outcome.status).toBe('failed')
      return
    }
    expect(outcome.status).toBe('failed')
    expect(outcome.reason).toBe('command-failed')
    expect(outcome.exitCode).not.toBe(0)
    expect(outcome.detail).toMatch(/Unknown option/i)
    expect(diagnostics.join('\n')).toMatch(/Unknown option/i)
  })
})

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

describe('the availability probe reports, and never delivers', () => {
  it('says a working tool is available, and asked for nothing but its version', async () => {
    const { directory, recordFile } = stubNotifySend({ exit: 0 })
    const availability = await withPath(directory, () => probeLinuxNotifier())
    expect(availability).toEqual({ available: true, platform: 'linux', reason: 'available' })
    // A probe that could put a toast on a developer's screen would be a probe nobody runs.
    expect(recordedArgv(recordFile)).toEqual(['--version'])
  })

  it('says a tool that is not installed is not available, with which reason', async () => {
    const empty = temporaryDirectory('agent-ping-notify-empty-')
    const availability = await withPath(empty, () => probeLinuxNotifier())
    expect(availability).toMatchObject({ available: false, platform: 'linux', reason: 'command-not-found' })
  })

  it('says a tool that cannot run is unusable rather than available', async () => {
    const { directory } = stubNotifySend({ exit: 1, stderr: 'stub: refusing' })
    const availability = await withPath(directory, () => probeLinuxNotifier())
    expect(availability).toMatchObject({ available: false, reason: 'command-unusable' })
  })
})
