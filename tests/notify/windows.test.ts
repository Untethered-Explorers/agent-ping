// The Windows notifier: the exact argument list, the encoded payload and the script inside
// it, the refusal of an fyi, and every way a delivery can fail without that being swallowed
// (NT-FR-01, NT-FR-02, NT-FR-04, NT-FR-08, NT-FR-09, ADR-004, ADR-010, APX-CON-04,
// APX-CON-06, APX-FR-01, APX-FR-02).
//
//   npm test -- tests/notify/windows.test.ts
//
// WHAT IS PROVEN HERE, AND WHAT IS NOT
// The argument list and the script are pure functions, so the first tests assert them
// exactly, per class - including decoding the base64 argument back to the script, which is
// the answer to the obvious objection that an encoded payload is an unreadable one. The
// payload-placement claim is then proven against a *real process*: a stub `powershell.exe`
// at the front of PATH that records the argv it was handed, given a title and body full of
// characters that would mean something very different in a PowerShell string. Nothing here
// mocks `child_process` and nothing here needs Windows.
//
// WHAT IS NOT PROVEN HERE, AND CANNOT BE FROM THIS MACHINE
// That a Windows toast appears, that the application id in `WINDOWS_TOAST_AUMID` resolves,
// that the WinRT projection works in the installed PowerShell, that the toast is attributed
// to anything in particular, and that 8 s is a long enough bound. This path is NOT
// live-verified on the authoring machine (APX-CON-06, NT-FR-04); each of those is an
// NT-5 observation on a Windows machine, listed in docs/runbooks/notify-platforms.md. The
// tests below assert that the runbook says so, and that the command it documents is the
// command this file generates.

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { NotificationRequest as HubNotificationRequest } from '@/hub/delivery'
import { createNodeCommandRunner } from '@/notify/command'
import { planNotification } from '@/notify/policy'
import { createPlatformNotifier } from '@/notify/registry'
import {
  POWERSHELL,
  POWERSHELL_ENCODED_FLAG,
  POWERSHELL_PROBE_SCRIPT,
  POWERSHELL_STARTUP_ARGS,
  WINDOWS_COMMAND_TIMEOUT_MS,
  WINDOWS_TOAST_AUMID,
  WINDOWS_TOAST_TEMPLATE,
  XML_TEXT_ESCAPES,
  buildPowerShellCommand,
  buildPowerShellProbeCommand,
  buildPowerShellScript,
  buildToastPayload,
  createWindowsNotifier,
  encodePowerShellCommand,
  escapePowerShellLiteral,
  escapeXmlText,
  probeWindowsNotifier,
} from '@/notify/windows'
import type { NotificationCommand, NotificationCommandRunner, NotificationRequest } from '@/notify/types'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION = 'ses_windows_01'
const ORIGIN = 'http://127.0.0.1:43733'
const REPO = 'agent-ping'

/**
 * The two lines a real `agent-ping` block produces, written out here.
 *
 * Spelled literally rather than read back from the policy, because the assertion is that
 * the two of them agree - a test that built its expectation with the same function it is
 * testing would pass whatever that function produced, including a title that had become a
 * prompt (APX-FR-01).
 */
const NEEDS_YOU_BODY = 'A session is blocked and needs a decision from you.'
const FINISHED_BODY = 'A session finished after working.'

/** A title and body built to be hostile in the ways this platform cares about. */
const HOSTILE_TITLE = 'repo $(id);`whoami` & | <tag> "quoted" \'single\''
const HOSTILE_BODY = "body\nsecond & third\t'tabbed'"

const RUNBOOK = fileURLToPath(new URL('../../docs/runbooks/notify-platforms.md', import.meta.url))

const temporaryDirectories: string[] = []

function temporaryDirectory(prefix = 'agent-ping-windows-'): string {
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

/** One hub-shaped request, for the composed registry path. */
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

/**
 * A stub `powershell.exe`, written into a directory of its own.
 *
 * A real executable with a real shebang, at the front of PATH, so the product starts it
 * exactly as it would start the installed shell - through PATH, with the argument array it
 * built, with no shell in between. The argv is recorded NUL-delimited, because an argument
 * may legitimately contain a newline and a line-delimited record could not tell one
 * argument from two. The file is named `powershell.exe` because that is the name the
 * product starts, and this machine's filesystem is case-preserving.
 */
function stubPowershell(options: {
  readonly exit?: number
  readonly stderr?: string
  readonly body?: string
} = {}): { readonly directory: string; readonly recordFile: string } {
  const directory = temporaryDirectory('agent-ping-windows-bin-')
  const recordFile = path.join(directory, 'argv.txt')
  const lines =
    options.body ??
    [
      '#!/bin/sh',
      `for arg in "$@"; do printf '%s\\0' "$arg" >> ${shellQuote(recordFile)}; done`,
      ...(options.stderr === undefined ? [] : [`printf '%s\\n' ${shellQuote(options.stderr)} >&2`]),
      `exit ${String(options.exit ?? 0)}`,
    ].join('\n')
  writeFileSync(path.join(directory, POWERSHELL), `${lines}\n`)
  chmodSync(path.join(directory, POWERSHELL), 0o755)
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
 * The production runner from the shared command boundary with only the bound changed, so
 * what these tests observe is what production does with the same argument list.
 */
function realRunner(timeoutMs = 5_000): NotificationCommandRunner {
  return createNodeCommandRunner({ timeoutMs })
}

/** The script a base64 argument decodes to, which is what a reviewer needs to read. */
function decode(encoded: string): string {
  return Buffer.from(encoded, 'base64').toString('utf16le')
}

// ---------------------------------------------------------------------------
// The argument list
// ---------------------------------------------------------------------------

describe('the PowerShell invocation is exactly this, per class', () => {
  it('is the tool, two startup flags, and one encoded script', () => {
    // The whole of NT-FR-04's argument claim. Four arguments, and the fourth is opaque by
    // design: it is one base64 argument that neither Node's Windows command-line
    // serialisation nor PowerShell's own parser can reinterpret.
    const command = buildPowerShellCommand(requestFor('needs-you'))
    expect(command.file).toBe('powershell.exe')
    expect(command.args).toHaveLength(4)
    expect(command.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand'])
    // And it decodes to the script, so an encoded payload is an unreadable one only until
    // anyone asks.
    expect(decode(command.args[3] ?? '')).toBe(
      buildPowerShellScript(REPO, NEEDS_YOU_BODY),
    )
  })

  it('builds the same shape for a finished turn, with that class\'s sentence', () => {
    // Same four arguments, different payload: that is the honest difference between the
    // two delivered classes on this platform, and asserting it exactly is what stops a
    // second policy appearing here (NT-FR-02, NT-FR-04).
    const needsYou = buildPowerShellCommand(requestFor('needs-you'))
    const finished = buildPowerShellCommand(requestFor('finished'))
    expect(finished.file).toBe(needsYou.file)
    expect(finished.args.slice(0, 3)).toEqual(needsYou.args.slice(0, 3))
    expect(finished.args[3]).not.toBe(needsYou.args[3])
    const script = decode(finished.args[3] ?? '')
    expect(script).toContain(`<text>${FINISHED_BODY}</text>`)
    expect(script).not.toContain(NEEDS_YOU_BODY)
  })

  it('carries the payload as a single argument, and never asks to bypass a policy', () => {
    // One argument, so nothing between this process and the shell can split it. And no
    // `-ExecutionPolicy Bypass`: this path runs no script file, and asking to be exempt
    // from a machine's policy to show a toast is not a trade worth making.
    const command = buildPowerShellCommand(requestFor('needs-you'))
    expect(command.args.slice(3)).toHaveLength(1)
    expect(command.args.join(' ')).not.toMatch(/ExecutionPolicy|ByPass|bypass/i)
  })

  it('is a pure function of the request, and does not modify it', () => {
    const request = requestFor('needs-you')
    const before = JSON.stringify(request)
    const first = buildPowerShellCommand(request)
    expect(buildPowerShellCommand(request)).toEqual(first)
    expect(JSON.stringify(request)).toBe(before)
  })

  it('encodes UTF-16LE base64, which is what -EncodedCommand decodes', () => {
    // The encoding is not a detail: UTF-8 or Base64url here would produce a script
    // PowerShell cannot read, and the symptom would be a toast that never appears and an
    // exit status that says nothing about why.
    const encoded = buildPowerShellCommand(requestFor('finished')).args[3] ?? ''
    expect(encoded).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe(
      buildPowerShellScript(REPO, FINISHED_BODY),
    )
    // Round-tripping a non-ASCII title is the part a latin1 mistake would break.
    const accented = buildPowerShellScript('café-münchen', 'A session is blocked.')
    expect(decode(encodePowerShellCommand(accented))).toBe(accented)
  })
})

// ---------------------------------------------------------------------------
// The script
// ---------------------------------------------------------------------------

describe('the script inside the payload is exactly this', () => {
  it('is one line, with a stop-on-error, a catch, a stderr write and a non-zero exit', () => {
    // The part of this platform that a reviewer must not take on trust. A PowerShell script
    // exits zero after an error unless it says otherwise, so without these four things a
    // toast that never appeared would be recorded as delivered - the lie APX-FR-02
    // forbids. Each is asserted separately so removing one is a failing test and not a
    // quiet regression.
    const script = buildPowerShellScript(REPO, NEEDS_YOU_BODY)
    expect(script).not.toContain('\n')
    expect(script).toContain("$ErrorActionPreference = 'Stop';")
    expect(script).toContain('try {')
    expect(script).toContain('}catch{')
    expect(script).toContain('[Console]::Error.WriteLine($_.Exception.Message);')
    expect(script.trimEnd().endsWith('exit 1}')).toBe(true)
  })

  it('builds a toast with the two lines, the template and the application id', () => {
    // The payload shape, asserted as a whole so a reordering or a renamed element is
    // visible. Two `<text>` elements and nothing else: the feature's UI rule is two lines
    // with no buttons (NT-FR-04, and the feature's own UI section).
    expect(buildToastPayload(REPO, NEEDS_YOU_BODY)).toBe(
      '<toast><visual><binding template="ToastGeneric">' +
        `<text>${REPO}</text><text>${NEEDS_YOU_BODY}</text>` +
        '</binding></visual></toast>',
    )
    const script = buildPowerShellScript(REPO, NEEDS_YOU_BODY)
    expect(script).toContain(`CreateToastNotifier('${WINDOWS_TOAST_AUMID}')`)
    expect(WINDOWS_TOAST_TEMPLATE).toBe('ToastGeneric')
  })

  it('escapes a hostile title and body instead of letting them become script', () => {
    // Two escapes, two named functions, both asserted. The metacharacter set is
    // enumerated from the table the code uses, so a character somebody forgot is a missing
    // row rather than an injection (APX-FR-01).
    for (const [character, entity] of Object.entries(XML_TEXT_ESCAPES)) {
      expect(escapeXmlText(`a${character}b`), character).toBe(`a${entity}b`)
    }
    expect(escapePowerShellLiteral("it's")).toBe("it''s")
    // Nothing from the hostile payload reaches the script unescaped, and the XML is still
    // one parsable line.
    const payload = buildToastPayload(HOSTILE_TITLE, HOSTILE_BODY)
    expect(payload).toBe(
      '<toast><visual><binding template="ToastGeneric">' +
        '<text>repo $(id);`whoami` &amp; | &lt;tag&gt; &quot;quoted&quot; &apos;single&apos;</text>' +
        '<text>body second &amp; third &apos;tabbed&apos;</text>' +
        '</binding></visual></toast>',
    )
    expect(payload).not.toMatch(/[\r\n\t]/)
    // And the document sits inside one single-quoted PowerShell literal, so there is no
    // unterminated string for a title to have created: the text between the literal's own
    // delimiters is the escaped document and nothing else.
    const script = buildPowerShellScript(HOSTILE_TITLE, HOSTILE_BODY)
    const open = script.indexOf("$payload='") + "$payload='".length
    const close = script.indexOf("';$toast=")
    expect(close).toBeGreaterThan(open)
    expect(script.slice(open, close)).toBe(payload)
  })

  it('neutralises the control characters XML forbids, so the document always parses', () => {
    // Every one of these characters would be a parse error in XML 1.0, and a parse error
    // would be a delivery that never happens for a reason nobody chose. Newline and tab are
    // in the set too, because the script has to stay one line.
    for (const character of [' ', '', '\t', '\n', '', '']) {
      expect(escapeXmlText(`a${character}b`), JSON.stringify(character)).toBe('a b')
    }
  })

  it('has no sound anywhere in the payload or the script (APX-CON-04)', () => {
    // The toast schema offers `<audio>` and PowerShell offers bells, `Write-Host` and
    // `[System.Media.SystemSounds]`. None of them appears, the request has no sound field,
    // and this sweep covers the arguments and the decoded script together - an encoded
    // payload would otherwise hide a sound-capable token from a test that only read the
    // argv.
    const soundCapable = /(^|[^a-z])(sound|audio|bell|chime|beep|ding|tone|playsound)([^a-z]|$)/i
    for (const eventClass of ['needs-you', 'finished'] as const) {
      const command = buildPowerShellCommand(requestFor(eventClass))
      expect(command.file.toLowerCase(), eventClass).not.toMatch(soundCapable)
      for (const arg of command.args) {
        expect(arg, `${eventClass}: ${arg}`).not.toMatch(soundCapable)
      }
      expect(decode(command.args[3] ?? ''), eventClass).not.toMatch(soundCapable)
    }
    // ...and no control is offered to the shell, either.
    expect(buildPowerShellCommand(requestFor('needs-you')).args).not.toContain('-STA')
  })
})

// ---------------------------------------------------------------------------
// The fyi refusal
// ---------------------------------------------------------------------------

describe('an fyi never reaches PowerShell', () => {
  it('refuses an fyi request, and starts no process at all', async () => {
    // NT-FR-02 on this platform: the refusal comes from the one class table, the outcome
    // carries no command because none was built, and the runner was never called.
    const commands: NotificationCommand[] = []
    const diagnostics: string[] = []
    const notifier = createWindowsNotifier({
      run: (command) => {
        commands.push(command)
        return Promise.resolve({ code: 0, signal: null, spawnError: null, stderr: '' })
      },
      onDiagnostic: (message) => diagnostics.push(message),
    })

    const outcome = await notifier({ ...requestFor('needs-you'), class: 'fyi' })

    expect(outcome).toEqual({ status: 'refused', reason: 'refused-in-app-only', platform: 'windows' })
    expect(outcome.command).toBeUndefined()
    expect(commands).toEqual([])
    expect(diagnostics).toEqual([])
  })

  it('refuses through the registry too, and delivers a block as the command asserted above', async () => {
    // The composed path, because that is the one production uses. Both halves in one test,
    // because the interesting claim is that the same entry does both: a class it refuses
    // and a class it delivers with this file's exact argument list.
    const commands: NotificationCommand[] = []
    const resolution = createPlatformNotifier({
      platform: 'win32',
      run: (command) => {
        commands.push(command)
        return Promise.resolve({ code: 0, signal: null, spawnError: null, stderr: '' })
      },
    })
    if (!resolution.supported) throw new Error('expected Windows to be supported')

    await resolution.notifier(hubRequest('fyi'))
    expect(commands).toEqual([])

    const outcome = await resolution.notifier(hubRequest('needs-you'))
    expect(commands).toEqual([buildPowerShellCommand(requestFor('needs-you'))])
    expect(outcome).toMatchObject({ status: 'delivered', platform: 'windows', exitCode: 0 })
  })
})

// ---------------------------------------------------------------------------
// The real process
// ---------------------------------------------------------------------------

describe('a real process receives the payload as one discrete argument', () => {
  it('hands a hostile title and body to a real stub, encoded and unsplit', async () => {
    // The claim that the encoding exists for. A real process receives four arguments; the
    // fourth decodes to a script whose payload has the metacharacters escaped, and nothing
    // in the argv was expanded, split or interpreted on the way.
    const { directory, recordFile } = stubPowershell()
    const notifier = createWindowsNotifier({ run: realRunner() })

    const outcome = await withPath(directory, () =>
      notifier({ ...requestFor('needs-you'), title: HOSTILE_TITLE, body: HOSTILE_BODY }),
    )

    expect(outcome.status).toBe('delivered')
    const argv = recordedArgv(recordFile)
    expect(argv).toHaveLength(4)
    expect(argv.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand'])
    const script = decode(argv[3] ?? '')
    expect(script).toContain('&amp;')
    expect(script).toContain('&lt;tag&gt;')
    expect(script).not.toMatch(/[\r\n]/)
    // The dangerous characters are still present as text, inside the escaped document.
    expect(script).toContain('$(id);`whoami`')
  })

  it('records the real exit status as a failure with a reason and a diagnostic', async () => {
    // The failure the try/catch exists to produce: a real process exiting 1, the code on the
    // outcome, the tool's own sentence on the diagnostic line, and no content in either
    // (APX-FR-02, NT-FR-09).
    const { directory, recordFile } = stubPowershell({ exit: 1, stderr: 'stub: no toast here' })
    const diagnostics: string[] = []
    const notifier = createWindowsNotifier({ run: realRunner(), onDiagnostic: (m) => diagnostics.push(m) })

    const outcome = await withPath(directory, () => notifier(requestFor('needs-you')))

    expect(outcome).toMatchObject({
      status: 'failed',
      reason: 'command-failed',
      platform: 'windows',
      exitCode: 1,
      detail: 'stub: no toast here',
    })
    expect(recordedArgv(recordFile)).toHaveLength(4)
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatch(/did not happen \(command-failed, exit 1\)/)
    expect(diagnostics[0]).toContain('no toast here')
    expect(diagnostics[0]).not.toContain(NEEDS_YOU_BODY)
  })

  it('records a missing shell as a failure, not as a delivered notification', async () => {
    // An empty PATH: the real spawn cannot find the tool, and there is no exit code for a
    // process that never ran. Reporting `delivered` here would be the lie APX-FR-02
    // forbids.
    const empty = temporaryDirectory('agent-ping-windows-empty-')
    const diagnostics: string[] = []
    const notifier = createWindowsNotifier({ run: realRunner(), onDiagnostic: (m) => diagnostics.push(m) })

    const outcome = await withPath(empty, () => notifier(requestFor('needs-you')))

    expect(outcome).toMatchObject({
      status: 'failed',
      reason: 'command-not-found',
      platform: 'windows',
      exitCode: null,
    })
    expect(diagnostics.join('\n')).toMatch(/command-not-found/)
  })

  it('kills a shell that hangs, and records which way it failed', async () => {
    // The stub would create its marker five seconds in; the bound is 250 ms, so the
    // marker's absence is the proof that the process was stopped rather than merely
    // unobserved (APX-CON-10).
    const markerDirectory = temporaryDirectory('agent-ping-windows-hang-')
    const marker = path.join(markerDirectory, 'finished.txt')
    const { directory } = stubPowershell({
      body: `#!/bin/sh\nsleep 5\nprintf 'ran\\n' > ${shellQuote(marker)}\n`,
    })
    const notifier = createWindowsNotifier({ run: realRunner(250) })

    const began = Date.now()
    const outcome = await withPath(`${directory}:/usr/bin:/bin`, () => notifier(requestFor('finished')))
    const elapsed = Date.now() - began

    expect(outcome).toMatchObject({ status: 'failed', reason: 'command-timed-out', exitCode: null })
    expect(elapsed).toBeLessThan(2_000)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(existsSync(marker)).toBe(false)
  })

  it('bounds one process, however long PowerShell takes to start on a real machine', () => {
    // The bound is a property of this platform rather than a copy of the Linux number, and
    // it is asserted so the difference is deliberate: Windows PowerShell's cold start is
    // commonly over a second, and a bound that killed a working delivery would report a
    // failure that had not happened. The cost - it exceeds the hub's own 2 s call bound, so
    // a slow machine may record `notifier-timeout` while the toast still arrives - is
    // recorded in the file header and in the runbook rather than hidden by a smaller
    // number here (APX-CON-10, APX-FR-02).
    expect(WINDOWS_COMMAND_TIMEOUT_MS).toBeGreaterThan(2_000)
    expect(WINDOWS_COMMAND_TIMEOUT_MS).toBeLessThanOrEqual(10_000)
  })
})

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

describe('the availability probe reports, and never delivers', () => {
  it('starts the shell with a script that does nothing at all', async () => {
    // `exit 0` starts the shell, does nothing and answers. No toast, no WinRT type, no
    // notification centre call, so a probe cannot put a banner on a developer's screen and
    // `install` can run it on a real machine (NT-FR-09, IO-2).
    const { directory, recordFile } = stubPowershell()
    const availability = await withPath(directory, () => probeWindowsNotifier())
    expect(availability).toEqual({ available: true, platform: 'windows', reason: 'available' })
    const argv = recordedArgv(recordFile)
    expect(argv.slice(0, 3)).toEqual(POWERSHELL_STARTUP_ARGS.concat(POWERSHELL_ENCODED_FLAG))
    expect(decode(argv[3] ?? '')).toBe(POWERSHELL_PROBE_SCRIPT)
    expect(argv.join(' ')).not.toMatch(/ToastNotification/i)
  })

  it('uses the same argument shape as a real delivery, so one is proof of the other', () => {
    const probe = buildPowerShellProbeCommand()
    const delivery = buildPowerShellCommand(requestFor('needs-you'))
    expect(probe.file).toBe(delivery.file)
    expect(probe.args.slice(0, 3)).toEqual(delivery.args.slice(0, 3))
  })

  it('says a shell that is not installed is not available, with which reason', async () => {
    const empty = temporaryDirectory('agent-ping-windows-empty-')
    const availability = await withPath(empty, () => probeWindowsNotifier())
    expect(availability).toMatchObject({ available: false, platform: 'windows', reason: 'command-not-found' })
  })

  it('says a shell that cannot run is unusable rather than available', async () => {
    const { directory } = stubPowershell({ exit: 1, stderr: 'stub: refusing' })
    const availability = await withPath(directory, () => probeWindowsNotifier())
    expect(availability).toMatchObject({ available: false, platform: 'windows', reason: 'command-unusable' })
  })
})

// ---------------------------------------------------------------------------
// The runbook
// ---------------------------------------------------------------------------

describe('the runbook names the command, and says this path is not live-verified here', () => {
  it('documents the exact script this file generates, for both delivered classes', () => {
    // The AC: the runbook names the manual command per platform. Asserting that the
    // documented line *is* the generated one means a developer who copies it out of the
    // runbook runs what the product runs, and it cannot go stale quietly.
    const blocks = powershellBlocks(readFileSync(RUNBOOK, 'utf8'))
    for (const eventClass of ['needs-you', 'finished'] as const) {
      const script = buildPowerShellScript(REPO, eventClass === 'needs-you' ? NEEDS_YOU_BODY : FINISHED_BODY)
      expect(blocks, eventClass).toContain(script)
    }
    // The encoded form is documented too, so a reader knows what the product actually
    // executes and why the plaintext is what they should paste.
    expect(blocks.some((block) => block.startsWith('powershell.exe -NoProfile -NonInteractive -EncodedCommand'))).toBe(
      true,
    )
  })

  it('states that the Windows path is not live-verified, and lists what only Windows can confirm', () => {
    // Each row of the assumptions table is an unverified claim, and NT-5's whole job is to
    // settle them. A runbook that quietly dropped this would let a later reader treat the
    // path as proven.
    const text = readFileSync(RUNBOOK, 'utf8')
    expect(text).toMatch(/macOS and Windows paths are NOT live-verified on the authoring machine/)
    expect(text).toContain('docs/reviews/notification-macos-windows.json')
    for (const assumption of [
      'CreateToastNotifier(',
      'ToastGeneric',
      'Windows PowerShell 5.1',
      '8 s is a long enough bound',
    ]) {
      expect(text, assumption).toContain(assumption)
    }
  })
})

// ---------------------------------------------------------------------------
// Helpers that need the runbook
// ---------------------------------------------------------------------------

/** Every ```powershell fenced block in the runbook, whitespace-collapsed. */
function powershellBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```powershell\n([\s\S]*?)```/g)]
    .map((match) => (match[1] ?? '').replaceAll(/\s+/g, ' ').trim())
}
