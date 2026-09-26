// The Windows notifier: one PowerShell process carrying a Windows toast notification,
// with the payload base64-encoded so neither the operating system nor PowerShell can
// re-interpret a title (NT-FR-01, NT-FR-02, NT-FR-04, NT-FR-08, NT-FR-09, ADR-004,
// ADR-010, APX-CON-04, APX-CON-06, APX-FR-02, APX-FR-01).
//
// VERIFICATION STATE, SAID ONCE AND SAID PLAINLY
// This path is implemented and unit-tested. It is NOT live-verified on the authoring
// machine: this code was written on Linux, no Windows machine has run it, and nothing in
// this repository may be read as evidence that a Windows toast ever appeared. What the
// tests here prove is the argument list, the encoded payload's exact text, the refusal of
// an `fyi`, the failure vocabulary, and that a real process receives the payload as one
// discrete argument. What only a Windows machine can confirm is listed in
// docs/runbooks/notify-platforms.md and belongs to NT-5's human gate (APX-CON-06,
// NT-FR-04).
//
// WHY THE PAYLOAD IS BASE64, WHICH IS THE INTERESTING DECISION HERE
// A Windows `spawn` is not a POSIX `exec`: Node serialises the argument array into one
// command line string for the child, and the child parses that string with its own rules
// before it ever sees an argument. Passing the script with `-Command` would therefore put
// the title through two parsers, and the second one is PowerShell's - a `$`, a `;`, a
// backtick or a quote inside a repository short name would be interpreted rather than
// shown. `-EncodedCommand` takes a single base64 argument that neither layer can
// reinterpret, so the script crosses the boundary intact.
//
// That choice costs legibility, so it is paid back in three ways rather than left as a
// surprise: the encoder is a named function, the script is a named builder, and a test
// decodes the argument a real process received and asserts the script text inside it. An
// operator reading a recorded `command` sees base64 and runs the plaintext line in the
// runbook, which is checked against this file by that same test.
//
// THE SCRIPT, AND WHY IT HAS A try/catch AND EXITS NON-ZERO
// A PowerShell script that hits an error still exits zero unless it says otherwise, so a
// toast that never appeared could be reported as delivered - the exact lie APX-FR-02
// forbids and the reason this is more than three lines. So the script sets
// `$ErrorActionPreference = 'Stop'`, wraps the call, writes the exception's own message to
// stderr where this product's runner collects it, and exits 1. Zero is therefore reported
// as delivered only when the notification call really returned, and any failure arrives
// as a real exit status with a readable reason beside it (NT-FR-09, ADR-010).
//
// WHAT THE PAYLOAD MAY CONTAIN, AND THE TWO ESCAPES IT PASSES THROUGH
// The title and the body are the only free text, and on this platform they cannot be
// argv elements: `-EncodedCommand` takes the whole command and there is no second
// argument to carry a payload. So they are embedded, and an embedded string needs two
// escapes rather than none:
//   1. XML. The text goes inside `<text>` elements, so `&`, `<`, `>`, `"` and `'` are
//      escaped, and the control characters XML 1.0 forbids outright (including tab,
//      newline and carriage return) become a single space so the script stays one line.
//   2. PowerShell. The document sits in a single-quoted string literal, where the only
//      escape is a doubled apostrophe. After step 1 there are no apostrophes left in the
//      document - `&apos;` contains none - so this step is currently unreachable, and it
//      is written anyway so that changing the XML escape set cannot turn a title into
//      script.
// The two steps are separate named functions and a test asserts both, including against a
// title built to be hostile. Nothing from a prompt, a tool name, a diff, a transcript, a
// path or an identifier reaches this payload: the strings arrive on the request from
// ./policy.ts, built from a repository short name and one sentence from a closed table
// (APX-FR-01, ADR-008).
//
// WHAT THE TOAST CANNOT DO HERE, STATED RATHER THAN DISCOVERED
//   - The toast is attributed to the application id in `WINDOWS_TOAST_AUMID`, not to
//     "agent-ping". Windows attributes a WinRT toast to the registered identity that
//     called it, and a shell process has no identity of its own; `PowerShell` is the
//     shortcut Windows registers for Windows PowerShell, and NT-5 must confirm that the
//     registration resolves on a real machine. If it does not, the call either throws -
//     which this file reports as a failure with the tool's own message - or is dropped by
//     the shell, and a dropped toast is indistinguishable from a delivered one from the
//     process's point of view. That is the largest honest limitation of this path and the
//     runbook says so in the same words.
//   - `powershell.exe` is named rather than `pwsh.exe` on purpose: Windows PowerShell 5.1
//     is the one that still projects WinRT types, and PowerShell 7 removed that
//     projection, so the other name would build a script that cannot work.
//   - No persistence, no urgency, no activation. A toast stays in Action Centre by
//     Windows' own rules rather than by anything asked for here, the three libnotify
//     urgency levels have no counterpart, and the call cannot report which toast was
//     clicked - so the deep link on the request is carried and available but nothing on
//     this platform can act on it, exactly as on Linux and macOS (NT-FR-08, NT-3).
//   - No buttons and no `launch` argument. Two lines, no controls (the feature's UI rule),
//     and no protocol handler this product does not own.
//
// NO SOUND, AND NO WAY TO ADD ONE BY ACCIDENT (APX-CON-04)
// The toast schema has an `<audio>` element and PowerShell has bells, `Write-Host` and
// `[System.Media.SystemSounds]`. None of them appears here, the request has no sound
// field, and a test sweeps every argument and the decoded script against sound-capable
// spellings so that a later edit adding one fails rather than shipping. What remains is
// outside this process: a Windows profile with a notification sound configured will make
// one. NT-5 observes it; this file cannot.
//
// ONE ATTEMPT, NO RETRY, AND A BOUND LONGER THAN THE OTHER TWO PLATFORMS
// There is no loop and no second attempt: one request, one process, one outcome
// (NT-FR-08, APX-CON-10). The bound is eight seconds rather than one and a half because
// starting Windows PowerShell on a real machine commonly takes a second or more, and a
// bound that killed a working delivery would report a failure that had not happened. It is
// deliberately longer than the delivery policy's own 2 s call bound, so on a slow machine
// the hub may abandon the call and record `notifier-timeout` while the toast still
// arrives; that is the safe direction, because this product then under-claims rather than
// over-claims, and the child is still killed at this bound because the runner's own timer
// is not cleared when a caller stops waiting for it (APX-CON-10, APX-FR-02).

import {
  createNodeCommandRunner,
  probeAvailability,
  refusedOutcome,
  reportCommandResult,
  RUNNER_REJECTED,
} from './command.js'
import { decideNotification } from './policy.js'
import {
  type NotificationAvailability,
  type NotificationCommand,
  type NotificationCommandResult,
  type NotificationCommandRunner,
  type NotificationOutcome,
  type NotificationRequest,
  type Notifier,
} from './types.js'

/**
 * The tool.
 *
 * `powershell.exe`, never `pwsh.exe`: Windows PowerShell 5.1 is the one that projects
 * WinRT types, and PowerShell 7 removed that projection (see the header). A bare name is
 * resolved through PATH by the operating system and never by a shell.
 */
export const POWERSHELL = 'powershell.exe'

/**
 * The two startup flags, and why exactly these two.
 *
 * `-NoProfile` so a developer's PowerShell profile - modules, prompts, a `Read-Host` - is
 * not loaded into a process that is only going to show a toast, and `-NonInteractive` so
 * the process can never stop and ask a question the hub is not there to answer. Nothing
 * else is passed: every additional flag is a thing that can differ between Windows
 * versions, and this invocation has to be one a developer can paste from the runbook.
 * Deliberately absent is `-ExecutionPolicy Bypass`, because execution policy governs
 * script *files* and this path runs none.
 */
export const POWERSHELL_STARTUP_ARGS: readonly string[] = ['-NoProfile', '-NonInteractive']

/**
 * The flag that takes the encoded script.
 *
 * One argument, one base64 string, nothing after it: `-EncodedCommand` consumes the rest
 * of the command line as the script, so this must stay last. A PowerShell that cannot be
 * given a payload this way would need a script file, which would put a file this product
 * writes on a developer's disk for the sake of a toast - the wrong trade for a loopback
 * sidecar.
 */
export const POWERSHELL_ENCODED_FLAG = '-EncodedCommand'

/**
 * The application id the toast is attributed to.
 *
 * NOT an assumption this file can verify, and the runbook lists it as the first thing
 * NT-5 must observe. A WinRT toast is attributed to the registered application identity
 * that raised it, and a `powershell.exe` process has none of its own; `PowerShell` is the
 * shortcut Windows registers for Windows PowerShell and is the form in circulation for
 * scripted toasts. If that registration is absent, `CreateToastNotifier` throws and this
 * file reports a failure with the real message rather than a delivery.
 */
export const WINDOWS_TOAST_AUMID = 'PowerShell'

/**
 * The toast template.
 *
 * `ToastGeneric` is the current text-only template and needs Windows 10 1709 or later;
 * its shape is two `<text>` elements, which is exactly the two lines this product's UI
 * rule allows (a headline and one sentence). A machine that does not know the template
 * rejects the XML, and that arrives here as a non-zero exit with stderr - a recorded
 * failure, not a silent success.
 */
export const WINDOWS_TOAST_TEMPLATE = 'ToastGeneric'

/**
 * How long one PowerShell process may take.
 *
 * Eight seconds, and the reasoning is in the header: a real cold start of Windows
 * PowerShell is commonly a second or more, so the Linux-shaped 1.5 s bound would report
 * failures that had not happened, while an unbounded process would hold a delivery open
 * forever (APX-CON-10).
 */
export const WINDOWS_COMMAND_TIMEOUT_MS = 8_000

/**
 * Characters XML 1.0 will not accept in a document, control characters included.
 *
 * Matched as one class and replaced with a single space, which also means a tab, a
 * newline and a carriage return in a title cannot split the payload across lines of the
 * script. Every one of these characters is unreachable in practice - the title is a
 * repository short name and the body is one sentence from a table (./policy.ts) - and the
 * point of handling them is that a *refusal* to handle them is not available: an
 * unescaped control character in XML is a parse error, and a parse error would be a
 * delivery that never happens for a reason nobody chose.
 */
const XML_FORBIDDEN = /[\u0000-\u001f\u007f]/g

/**
 * The XML metacharacters, and what each becomes.
 *
 * As a table rather than a chain of `replace` calls so that the mapping is a thing a test
 * can enumerate: escaping a character nobody thought about is exactly the failure mode
 * this table exists to prevent, and a table makes the omission visible (APX-FR-01).
 */
export const XML_TEXT_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
}

/**
 * Make one value safe as XML text content.
 *
 * Two steps, in this order: the characters XML forbids become spaces, and then the five
 * metacharacters become entities. The order matters - doing the entities first would let
 * the control-character pass eat the `&` of an entity it had just written - and the
 * result is a single-line document that parses.
 */
export function escapeXmlText(value: string): string {
  const withoutForbidden = value.replaceAll(XML_FORBIDDEN, ' ')
  let escaped = ''
  for (const character of withoutForbidden) {
    escaped += XML_TEXT_ESCAPES[character] ?? character
  }
  return escaped
}

/**
 * Make one value safe inside a PowerShell single-quoted string literal.
 *
 * One rule, and it is the only one: a literal apostrophe is written twice. Nothing else
 * is special inside single quotes - `$`, a backtick, `"` and `&` are all literal there -
 * which is why the payload is placed in single quotes and why the XML escaping happens
 * first (see the header).
 */
export function escapePowerShellLiteral(value: string): string {
  return value.replaceAll("'", "''")
}

/**
 * The toast document for two lines, as one line of XML.
 *
 * `template` is interpolated from the named constant rather than typed into the string, so
 * the template this product asks for is a value a test and a diagnostic can both name.
 * There is no `<audio>`, no `<actions>`, no `<header>` and no `launch` attribute: two
 * lines, no controls, no sound, and no protocol handler this product does not own
 * (APX-CON-04, and the feature's own two-line UI rule).
 */
export function buildToastPayload(title: string, body: string): string {
  const safeTitle = escapePowerShellLiteral(escapeXmlText(title))
  const safeBody = escapePowerShellLiteral(escapeXmlText(body))
  return (
    `<toast><visual><binding template="${WINDOWS_TOAST_TEMPLATE}">` +
    `<text>${safeTitle}</text><text>${safeBody}</text>` +
    '</binding></visual></toast>'
  )
}

/**
 * The whole script, for two lines.
 *
 * Pure and total: the only interpolation is the payload and the application id, and both
 * are escaped or constant. The shape is fixed in five parts:
 *
 *   $ErrorActionPreference = 'Stop'   a non-terminating error becomes terminating
 *   try {                             so the catch below can see it
 *     <load the two WinRT types>      the projection, once each
 *     $payload = '<toast .../>'       the document from buildToastPayload
 *     <build the toast and Show it>   the notification-centre equivalent
 *   } catch {
 *     [Console]::Error.WriteLine(...) the tool's own message, where the runner collects it
 *     exit 1                          a real non-zero status, so nobody was told
 *   }
 *
 * Every line is a single line, which is what keeps the encoded command one argument.
 */
export function buildPowerShellScript(title: string, body: string): string {
  const typeOption = 'Windows.UI.Notifications, ContentType=WindowsRuntime'
  const manager = `[Windows.UI.Notifications.ToastNotificationManager, ${typeOption}]`
  const notification = `[Windows.UI.Notifications.ToastNotification, ${typeOption}]`
  return (
    "$ErrorActionPreference = 'Stop';" +
    'try {' +
    `${manager}|Out-Null;` +
    `${notification}|Out-Null;` +
    `$payload='${buildToastPayload(title, body)}';` +
    `$toast=${notification}::new($payload);` +
    `${manager}::CreateToastNotifier('${WINDOWS_TOAST_AUMID}').Show($toast);` +
    "}catch{[Console]::Error.WriteLine($_.Exception.Message);exit 1}"
  )
}

/**
 * The script as the one argument `-EncodedCommand` takes.
 *
 * Base64 of UTF-16LE, which is what PowerShell's `-EncodedCommand` decodes - not UTF-8,
 * not Base64url, and no line breaks. The encoding is the reason the payload survives the
 * two parsers on this platform, so it is a named function rather than an expression at the
 * call site: a test decodes this and asserts the script inside it, which is what keeps an
 * uninspectable blob from becoming an uninspectable claim.
 */
export function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/**
 * The exact invocation for one rendered request.
 *
 * Pure, and the same array for every class on this platform: a class may not change what
 * kind of call is made, only whether one is made at all, and the request's own text is the
 * only thing that varies. `urgency` and `persistence` are not consulted because this
 * platform's toast has no parameter that either could set - see the header.
 */
export function buildPowerShellCommand(request: NotificationRequest): NotificationCommand {
  const script = buildPowerShellScript(request.title, request.body)
  return { file: POWERSHELL, args: [...POWERSHELL_STARTUP_ARGS, POWERSHELL_ENCODED_FLAG, encodePowerShellCommand(script)] }
}

// ---------------------------------------------------------------------------
// The notifier
// ---------------------------------------------------------------------------

export interface CreateWindowsNotifierOptions {
  /** The runner. A test passes a recording function; production passes the real one. */
  readonly run?: NotificationCommandRunner
  /**
   * Overrides the bound of the runner this notifier builds.
   *
   * An injected `run` owns its own bound, so this does not apply to one: the notifier
   * cannot bound a runner it did not write, and a silent no-op option is worse than none.
   */
  readonly timeoutMs?: number
  /** Reports a diagnostic line, on a failure only. Never called with content. */
  readonly onDiagnostic?: (message: string) => void
}

/**
 * The Windows notifier behind the shared interface.
 *
 * The same four steps as the other two platforms, and deliberately: read the one class
 * policy, refuse what it refuses, build this platform's argument list, and hand the result
 * to the shared classification in ./command.ts. The only thing this file knows that the
 * others do not is what a PowerShell toast looks like (NT-FR-02, NT-FR-04).
 */
export function createWindowsNotifier(options: CreateWindowsNotifierOptions = {}): Notifier {
  const run = options.run ?? createNodeCommandRunner({ timeoutMs: options.timeoutMs ?? WINDOWS_COMMAND_TIMEOUT_MS })

  return async (request: NotificationRequest): Promise<NotificationOutcome> => {
    // The same table the planner used. A refused class cannot be delivered even if this
    // notifier is handed one directly, which is what makes "an fyi never reaches
    // PowerShell" true of the notifier and not only of the planner.
    const policy = decideNotification(request.class)
    if (policy.kind === 'refuse') return refusedOutcome('windows', policy.reason)
    const command = buildPowerShellCommand(request)
    let result: NotificationCommandResult
    try {
      result = await run(command)
    } catch {
      // A runner that rejects is a broken runner, not a delivered toast (APX-FR-02).
      result = RUNNER_REJECTED
    }
    return reportCommandResult({
      command,
      platform: 'windows',
      result,
      toolName: POWERSHELL,
      ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
    })
  }
}

/**
 * The script a reachability probe asks PowerShell to run.
 *
 * `exit 0` - it starts the shell, does nothing else, and answers. No toast, no WinRT type,
 * no notification centre call, so a probe cannot put a banner on a developer's screen, and
 * it is encoded by the same function as a real delivery so the probe exercises the same
 * argument shape (NT-FR-09).
 */
export const POWERSHELL_PROBE_SCRIPT = 'exit 0'

/** The probe's own command, kept beside the script so the two cannot disagree. */
export function buildPowerShellProbeCommand(): NotificationCommand {
  return {
    file: POWERSHELL,
    args: [...POWERSHELL_STARTUP_ARGS, POWERSHELL_ENCODED_FLAG, encodePowerShellCommand(POWERSHELL_PROBE_SCRIPT)],
  }
}

/**
 * Is there a notifier to deliver with on this machine?
 *
 * The shared probe from ./command.ts with this platform's tool and bound. A Windows machine
 * where `powershell.exe` is not on PATH, or where the shell is disabled by policy, answers
 * `command-not-found` or `command-unusable`, and that is the fact `doctor` needs in order
 * to tell "no notifier" apart from "notifier that cannot deliver" (NT-FR-09, APX-FR-02).
 *
 * What it cannot answer is whether a toast would be *shown* on this machine: that depends
 * on the notification centre and on the application id in `WINDOWS_TOAST_AUMID`, and the
 * only honest answer to that is NT-5 watching one.
 */
export async function probeWindowsNotifier(
  options: CreateWindowsNotifierOptions = {},
): Promise<NotificationAvailability> {
  return probeAvailability({
    platform: 'windows',
    command: buildPowerShellProbeCommand(),
    timeoutMs: options.timeoutMs ?? WINDOWS_COMMAND_TIMEOUT_MS,
    ...(options.run === undefined ? {} : { run: options.run }),
  })
}
