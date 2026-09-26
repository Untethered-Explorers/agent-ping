# Runbook: the notification path on all three platforms

Owner: notification-engineer. Requirements: NT-FR-01, NT-FR-02, NT-FR-03, NT-FR-04,
NT-FR-09. Constraints: APX-CON-04 (no sound), APX-CON-06 (Linux, macOS, Windows in v1),
APX-FR-02 (a delivery failure is never silent).

This is the file NT-4 and NT-5 read. It names the exact command a developer can run by
hand on each platform, says what the automated tests in this repository already cover, and
says what only that platform can confirm.

---

## 0. The verification state, in one table, stated plainly

| Platform | Implementation | Automated checks in this repository | Live-verified on the authoring machine (Linux) | Human gate |
|---|---|---|---|---|
| Linux | `src/notify/linux.ts` | Yes, plus real `notify-send` invocations | **Yes** for the argument list and the failure paths; **no** for on-screen persistence | NT-4, `docs/reviews/notification-linux.json` |
| macOS | `src/notify/macos.ts` | Yes: the exact argument list, the payload placement, the `fyi` refusal, the failure vocabulary | **No** | NT-5, `docs/reviews/notification-macos-windows.json` |
| Windows | `src/notify/windows.ts` | Yes: the exact argument list, the encoded payload, the `fyi` refusal, the failure vocabulary | **No** | NT-5, `docs/reviews/notification-macos-windows.json` |

**The macOS and Windows paths are NOT live-verified on the authoring machine.** This was
written on Linux. No macOS machine and no Windows machine has run this code, no toast has
been observed on either, and nothing in this repository is evidence that one would appear.
The macOS and Windows implementations ship with scripted checks and these documented manual
steps, and their human review gate can only be completed on those platforms (APX-CON-06).
Where this runbook says a thing "is assumed", that is the whole of its evidence.

What the automated checks *can* establish on a Linux machine, and do, for all three
platforms: the exact argument list each platform builds, that a title and body reach the
operating system unsplit and unexpanded - as two discrete arguments on Linux and macOS, as
one base64 argument nothing can reinterpret on Windows - that an `fyi` is refused before
any process is started, that no sound-capable argument exists anywhere in the invocation
or in the generated script, that a non-zero exit becomes a recorded failure with a closed
reason and a diagnostic line, and that the commands printed in this runbook are the
commands the code generates. What they cannot establish, on any platform: that a human saw
a banner, and how long it stayed.

---

## 1. The one policy all three platforms apply

There is one class table, in `src/notify/policy.ts`, and each platform reads it rather
than reimplementing it (ADR-004, NT-FR-02):

| Class | Decision | Urgency | Persistence | Reaches a command line |
|---|---|---|---|---|
| `needs-you` | deliver | critical | resident | yes |
| `finished` | deliver | normal | expires | yes |
| `fyi` | **refuse** | — | — | **no, on any platform** |

A refusal is a correct outcome rather than a fault, and it is not a diagnostic line. The two delivered classes differ on Linux in the argument list itself;
on macOS and Windows they differ only in the two lines of text, because neither platform's
call has a parameter for urgency or persistence. That difference is recorded per platform
below rather than papered over, because it is the single most important thing a developer
on those platforms should know before relying on the toast.

---

## 2. Linux (`notify-send`)

Reproduce a block by hand, from any directory:

```sh
notify-send --app-name=agent-ping --urgency=critical --expire-time=0 --hint=boolean:resident:true -- agent-ping 'A session is blocked and needs a decision from you.'
```

Reproduce a finished turn:

```sh
notify-send --app-name=agent-ping --urgency=normal --expire-time=5000 -- agent-ping 'A session finished after working.'
```

An `fyi` has no command, by design. There is nothing to type.

**Covered by the automated tests here:** the exact argument array per class, a real process
receiving a hostile title and body with no shell expansion, a real non-zero exit recorded
as `command-failed` with the tool's own sentence, a real hung process killed at the bound,
a missing tool reported as `command-not-found`, and the installed `notify-send`'s own
parser accepting and rejecting the option set. See `tests/notify/linux.test.ts`.

**Only NT-4 can confirm:** whether a real desktop honours the resident hint and the toast
actually stays on screen (PRD 16 Open Question 2), and which hints were required.

---

## 3. macOS (`osascript`, notification centre)

Reproduce a block by hand:

```sh
osascript -e 'on run argv' -e 'display notification ((item 2 of argv) as text) with title ((item 1 of argv) as text)' -e 'end run' -- agent-ping 'A session is blocked and needs a decision from you.'
```

Reproduce a finished turn — the same command with `normal` urgency not expressible, so only
the sentence differs:

```sh
osascript -e 'on run argv' -e 'display notification ((item 2 of argv) as text) with title ((item 1 of argv) as text)' -e 'end run' -- agent-ping 'A session finished after working.'
```

The two lines are the two arguments after `--`. They are never interpolated into the
script, so there is no AppleScript string literal to break out of.

**What this platform's call cannot do, and what is used instead**

| Missing | Consequence | What carries it instead |
|---|---|---|
| Persistence (no "stay on screen") | A `needs-you` banner is not requested to persist. It is not faked with a re-fire, because a repeat timer is forbidden (NT-FR-08) | The tray badge and the dashboard (NT-3) |
| Urgency | No critical/normal distinction in the banner | The badge count |
| Activation | Clicking the banner does not open the dashboard | The tray icon, which resolves the deep link (NT-FR-07) |
| Application identity | The banner is attributed by macOS to the calling process, so it may not appear under the name `agent-ping` | Not worked around here; NT-5 records what it appears as |

**Covered by the automated tests here:** the exact argument array per class, that the
script is a fixed constant and the two lines are discrete arguments after `--` (asserted
with a title built to be hostile), the `fyi` refusal with no process started, the absence
of any sound-capable argument *including* the `sound name` parameter that
`display notification` does offer, and every failure path with a closed reason. See
`tests/notify/macos.test.ts`.

**Only NT-5 can confirm, on a Mac:** that a banner appears at all; whether the two classes
are distinguishable; the application name the banner carries; whether macOS asks for any
permission on first use (a first-run Automation or Notifications prompt would be a real
observation to record); and whether the 1.5 s bound is enough on a real machine.

---

## 4. Windows (PowerShell toast)

Reproduce a block by hand. The product passes the script base64-encoded, so the command it
runs is:

```powershell
powershell.exe -NoProfile -NonInteractive -EncodedCommand <base64 of the script below>
```

The script that base64 decodes to (UTF-16LE), which is what to paste into a PowerShell
prompt to reproduce the same toast by hand:

```powershell
$ErrorActionPreference = 'Stop';try {[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]|Out-Null;[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType=WindowsRuntime]|Out-Null;$payload='<toast><visual><binding template="ToastGeneric"><text>agent-ping</text><text>A session is blocked and needs a decision from you.</text></binding></visual></toast>';$toast=[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType=WindowsRuntime]::new($payload);[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]::CreateToastNotifier('PowerShell').Show($toast);}catch{[Console]::Error.WriteLine($_.Exception.Message);exit 1}
```

Reproduce a finished turn, whose payload carries the other sentence and is otherwise
identical:

```powershell
$ErrorActionPreference = 'Stop';try {[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]|Out-Null;[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType=WindowsRuntime]|Out-Null;$payload='<toast><visual><binding template="ToastGeneric"><text>agent-ping</text><text>A session finished after working.</text></binding></visual></toast>';$toast=[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType=WindowsRuntime]::new($payload);[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]::CreateToastNotifier('PowerShell').Show($toast);}catch{[Console]::Error.WriteLine($_.Exception.Message);exit 1}
```

**Why the script is base64, and what that costs.** On Windows, Node serialises the argument
array into a command line string and the child parses it again with its own rules. Passing
the script with `-Command` would put a title through PowerShell's parser, where `$`, `;`,
a backtick or a quote would be interpreted rather than shown. `-EncodedCommand` takes one
base64 argument that neither layer can reinterpret. The cost is legibility, which is paid
back three ways: the encoder is a named function, the script is a named builder, and
`tests/notify/windows.test.ts` decodes the argument a real process received and asserts the
script text inside it.

**Why the script ends in a `catch` that exits 1.** A PowerShell script that hits an error
still exits zero unless it says otherwise, so a toast that never appeared could be reported
as delivered. `$ErrorActionPreference = 'Stop'`, the `try`, the write to stderr and
`exit 1` are what make "delivered" mean the notification call really returned (APX-FR-02).

**What is assumed on this platform, and is not verified here**

| Assumption | Why it is an assumption | What NT-5 must observe |
|---|---|---|
| `CreateToastNotifier('PowerShell')` resolves to a registered application identity | A `powershell.exe` process has no identity of its own; `PowerShell` is the shortcut Windows registers for Windows PowerShell | Whether the toast appears, and under what name |
| A toast the shell silently drops is indistinguishable from a delivered one | The process cannot report what the shell did with the call | Whether a delivery recorded as `delivered` also produced a visible toast |
| `powershell.exe` is Windows PowerShell 5.1, which still projects WinRT types | PowerShell 7 (`pwsh.exe`) removed that projection, which is why the tool is named `powershell.exe` and not `pwsh.exe` | Whether the projection resolves |
| The default PowerShell apartment is STA, which the WinRT call needs | Not set explicitly, to keep the argument list to the flags every version accepts | Whether the call succeeds without `-STA` |
| `ToastGeneric` needs Windows 10 1709 or later | An older machine rejects the template | Whether the template is accepted |
| 8 s is a long enough bound for a real cold start of `powershell.exe` | Cannot be measured from Linux | The observed start-up time, and whether 2 s (the hub's own call bound) is ever exceeded |

**Covered by the automated tests here:** the exact argument array; the exact decoded script
text for each class, including its `$ErrorActionPreference`, `try`, stderr write and
`exit 1`; that the payload crosses as one base64 argument; that XML metacharacters and
control characters in a hostile title are escaped rather than injected; the `fyi` refusal
with no process started; the absence of `<audio>` and of any sound-capable argument; and
every failure path with a closed reason. See `tests/notify/windows.test.ts`.

---

## 5. What all three paths deliberately do not do

- **No sound** (APX-CON-04). No audio argument, no `<audio>` element, no `sound name`
  parameter, no bell, and no field on the request that could carry one. A test sweeps
  every argument and every generated script against sound-capable spellings on all three
  platforms. What this cannot prevent is the *user's own* configured system sound on their
  machine; NT-4 and NT-5 observe that, this repository cannot.
- **No repeat timer** (NT-FR-08). One request, one process, one attempt. A delivery that
  fails is reported once, and the block stays stored and pending. A missing toast is never
  a lost block, and it is never re-fired to hide the gap.
- **No dismiss, snooze or mute affordance.** Not in the tray (NT-3), not in a toast, not in
  a runbook example. The tray menu is exactly open-dashboard and quit.
- **No telemetry, no remote anything** (APX-CON-12). Every command is local.
- **No shell.** Every invocation is a file and an argument list. On macOS the two lines are
  argv elements; on Linux they are the last two arguments after `--`; on Windows they are
  one base64 argument that no parser reinterprets.

---

## 6. If something is wrong on one platform

1. `npm run doctor` (once packaging ships) or read the hub's health route: it carries the
   delivery status, the last failure's reason and the notifier availability. A
   `command-not-found` means the tool is not on PATH; `command-unusable` means it is there
   and refused; `not-wired` means the platform has no notifier at all (NT-FR-09, IO-2).
2. The event is still in the dashboard and still pending. Nobody was told, and nothing was
   lost: the block is durable and returns after a restart.
3. Reproduce it by hand from the command above on that platform, and record what you saw in
   that platform's review file. Do not paper over it in code - NT-4 and NT-5 exist to
   record required changes.
