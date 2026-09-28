# Cross-Platform Development

## Purpose

This project supports **Linux, macOS and Windows**. The `os` field in `package.json` is
the authoritative statement of that contract.

The machine a change is authored on is not necessarily a machine it will run on. Every
observation in this repository so far came from one Linux desktop, and the state of that
is recorded in [Known gaps](user-guide.md#known-gaps) and
[`docs/reviews/deferred-gates.md`](reviews/deferred-gates.md). The goal is therefore not
"works on my machine" but the removal of accidental platform assumptions from the
implementation, so that a claim about macOS or Windows rests on code and a contract
rather than on an untested guess.

This guide is the deep reference for the short rules in [`AGENTS.md`](../AGENTS.md). The
per-platform autostart unit table and the state directory layout are **not** restated
here; [the administrator guide](admin-guide.md) owns them.

---

## 1. The core principle

> **The developer's operating system is an implementation detail, not a project
> requirement.**

When an OS-specific failure appears, do not immediately add a workaround for the other
operating system. Ask first:

1. Why is this operation platform-specific at all?
2. Is there a platform-neutral API in the runtime?
3. Can the platform-dependent behaviour be isolated behind one module that owns it?
4. Is the platform dependency actually required?

Prefer:

```text
application / runtime API
        ↓
one module that owns the platform branch
        ↓
OS
```

over:

```text
application
        ↓
shell command string
        ↓
OS-specific behaviour
```

A file this product writes is the sharpest case. agent-ping generates three autostart
units, and each is read by a different interpreter: a systemd user unit, a launchd
property list, and a `cmd.exe` batch file. There is no single syntax that is correct for
all three, so the correct move is one module per platform that emits the bytes that
platform's own interpreter expects — not a shared template with a conditional inside it.

---

## 2. Filesystem and paths

### One resolution point

Every path this product writes resolves through `src/storage/paths.ts`, and nowhere
else. That module is the single answer to "where does state live", which is what lets a
test, a package and a verification script never disagree.

`resolveStateDir` takes `env` and `platform` as **parameters** rather than reading
ambient process state, so a test can drive the Linux, macOS and Windows branches on any
machine. When you add a platform branch, keep that shape: the branch is selected by an
argument, and the caller supplies the value.

### Do not hard-code paths

Do not assume any of these exist:

```text
/tmp
/home/user
/Users/user
C:\Users\user
C:\Program Files
%APPDATA%
~/Library
```

Use the platform-aware APIs for temporary directories, home directories, application
data, configuration directories and executable locations, and `node:path` for joining and
normalizing. `path.join` and `path.resolve` handle the separator; concatenating with `/`
or `\` does not.

`os.tmpdir()` plus `fs.mkdtempSync` is the pattern for scratch space. `mkdtempSync`
rather than a fixed name, because a fixed name collides between two concurrent runs and
survives nothing if a previous run crashed.

### Paths are opaque

A path may contain spaces, Unicode, apostrophes, parentheses, brackets or shell
metacharacters. This is not a hypothetical: the state directory, the autostart unit
directory and the opencode configuration root are all under a user's home directory, and
home directories on all three platforms routinely contain at least one of those.

Quote a path for the interpreter that will read it, and note that the two shell
families escape differently. `cmdQuote` in `src/cli/autostart/windows.ts` exists because
a batch file expands `%VAR%` before `cmd` ever sees the line, so a POSIX-style single
quote is not enough there.

### Case sensitivity, reserved names and drive letters

Do not assume `src/Foo.ts` and `src/foo.ts` are the same file. Do not assume a path
starts with `/`: Windows paths may be drive-rooted (`C:\...`) or UNC (`\\server\share\...`).
Do not create a file or directory named `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9` or
`LPT1`–`LPT9`; Windows reserves them and a collision there is a hard failure rather than
a surprise.

### A deliberate exception

A module that generates a file *for another* platform may use that platform's `path`
flavour on purpose. `src/cli/autostart/windows.ts` calls `path.win32.join` while running
on Linux, because the unit it is describing belongs to Windows and the separators in it
must be the ones Windows expects. The exception is narrow and the reason is always
visible in the call; everywhere else, use the ambient platform.

---

## 3. Shells and command execution

### There is no universal shell

Bash, Zsh, `cmd.exe` and PowerShell are different languages that happen to share a
prompt. Never write shell syntax into a shared configuration file, a generated unit or a
generated script unless the shell is explicitly part of that file's contract. In this
repository each of the three autostart units *is* such a contract, which is why each one
lives in its own module.

### Prefer the runtime API

Use the filesystem, process, HTTP and JSON APIs rather than invoking `mkdir`, `rm`, `cp`,
`mv`, `cat`, `grep`, `sed`, `awk`, `find`, `chmod` or `which`. Most of those either do not
exist on Windows or behave differently there.

### Spawn an executable, not a command string

Pass an executable plus an argument array:

```text
spawnSync(binary, ['--version'], { encoding: 'utf8' })
```

Never build a string for a shell to parse:

```text
'tool ' + path + ' --output ' + output
```

The array form removes the entire quoting and escaping problem, and it is what every
spawn site in `scripts/` and `src/` already does. `process.execPath` is the portable way
to name the current Node binary; `node` on `PATH` is an assumption.

---

## 4. Environment variables

Do not embed shell-specific environment syntax in application logic. `: $HOME`,
`${HOME}`, `%USERPROFILE%` and `$env:USERPROFILE` each mean something to a different
interpreter and nothing to the rest.

Read variables through `process.env` or an injected `env` object, and do not assume any
of `HOME`, `USER`, `USERPROFILE`, `PATH`, `SHELL`, `PWD` or `TMPDIR` is present or means
the same thing everywhere. `HOME` in particular is commonly absent on Windows outside a
developer shell, which is why `os.homedir()` is the right call for "where is this user's
home directory" and `env.HOME` is only correct inside a Linux-specific code path.

agent-ping's own variable is `AGENT_PING_STATE_DIR`, deliberately named in the project's
namespace rather than a platform's, so it means the same thing everywhere. A test sets
it to redirect the whole product at a temporary directory.

---

## 5. Temporary files and directories

`/tmp` is not the temporary directory. Use `os.tmpdir()` and `fs.mkdtempSync`, and
create it before writing into it.

Also consider cleanup, concurrent execution, filename collisions, permissions, locked
files, and antivirus or file-indexing interference on Windows — a real hazard for a
desktop application that writes a database and then a log beside it.

---

## 6. File permissions

`chmod` is a no-op for access control on Windows, and a filesystem without POSIX modes
is an ordinary condition rather than an error.

A `chmod` that the platform refuses is therefore expected and survivable. `ensureStateDir`
and `ensureOwnerOnlyFile` in `src/storage/paths.ts` show the shape: create the path, try
to tighten its mode, and treat a refusal as a fact about the filesystem rather than a
failure. The `mkdir` is fatal when it fails, because nothing downstream can open a
database inside a directory that does not exist.

Two consequences specific to this repository:

- `writeFileSync`'s `mode` option is filtered through the process umask, so it cannot be
  relied on for an exact mode. `ensureOwnerOnlyFile` creates the file and chmods it
  afterwards, which is why the database lands at `0o600` rather than at whatever the
  umask produced.
- Do not rely on the executable bit to make a script runnable. Every script here is
  invoked as `node scripts/<name>.mjs` from an npm script, never as `./script.mjs`.

---

## 7. Symlinks

Do not assume symbolic links can be created, resolved, modified or committed. Windows
permissions and developer-mode configuration both affect creation.

The one place this product creates a symlink is the systemd `default.target.wants`
entry, and that is correct: it is a Linux-only fact about a Linux-only unit, in the
module that owns Linux. A symlink is not a general-purpose substitute for a copy across
platforms; prefer explicit configuration or a copy when the link is not the convention the
platform already uses.

`symlinkSync` also refuses an existing path, which is why the replace is a two-step
remove-then-create rather than a single call.

---

## 8. Line endings and encoding

Do not assume LF. Support CRLF where a file is read back, and never write a test that
fails merely because a checked-out file has different line endings.

`.gitattributes` is the mechanism that makes this a repository-wide decision rather than
a per-clone surprise: it pins `text=auto` for source and explicit `eol=lf` for the files
where CRLF would break something, and it marks the generated configuration files as
literal so a `.bat` or `.cmd` unit is never rewritten by checkout.

Be careful when generating scripts, generating configuration, comparing files, parsing
text, or taking snapshots — an autostart unit is compared byte for byte in tests, and a
line-ending difference between two platforms is a test failure that says nothing about
the product.

Use explicit encodings when reading and writing files. Do not assume terminal encoding or
locale behaviour, and test paths and content containing Unicode.

---

## 9. Process management

Do not assume Unix signal semantics. `SIGTERM`, `SIGINT` and `SIGKILL` are not delivered
the same way on Windows, `Ctrl+C` reaches a process tree differently, and a parent
crashing does not necessarily reap its children.

For anything that starts a child process, answer explicitly:

1. How is it started, and with which executable and argument array?
2. How is it monitored?
3. How is it stopped, and does that work on Windows?
4. What happens if the parent crashes first?
5. Is the child detached, and is that deliberate?

`spawnSync` with an argument array and no `shell` option is the pattern used throughout
this repository; it avoids the shell entirely and therefore avoids the whole class of
quoting and signal problems.

### Signals are not deliverable on Windows

The one place in this repository where a platform difference changes a *guarantee*
rather than a spelling. `child.kill('SIGTERM')` raises SIGTERM in the child on Linux and
macOS, the child's handler runs, and the hub performs its ordered close. On Windows
`child.kill()` is `TerminateProcess` for every signal name: nothing is delivered, no
handler runs, and the process ends where it stands. Node accepts the spelling
`'SIGTERM'` there and performs the same unconditional terminate, so writing the name
does not make the request graceful.

So `SHUTDOWN_SIGNALS` in `src/hub/lifecycle.ts` is a Unix courtesy, and the guarantee
this product actually makes is the other one: a hub ended abruptly is reclaimed by the
runtime-file liveness check, and that is the path Windows always takes.

Two rules follow for anything added here:

- A test whose subject is the shutdown runs only where a signal is deliverable, and says
  why. A test whose subject is something else — a replay count, a delivery verdict —
  ends its hub with a method that claims nothing about how, rather than asserting an
  exit code that only one platform can produce.
- Do not "fix" this by adding a shutdown route. The write surface is a closed union of
  one route (ADR-002), and a second one is a decision for a human to accept in writing,
  not a portability patch.

---

## 10. Networking

Do not assume a particular interface, a particular port, or that `localhost` resolves the
same way everywhere. Do not write a test that requires a specific IP address or network
interface.

Prefer `127.0.0.1` explicitly over a hostname, dynamic ports for tests, and explicit host
configuration. agent-ping's loopback boundary — binding `127.0.0.1`, rejecting a
non-loopback remote address — is a security property, not just a networking convenience,
and a change that makes the bind address configurable must not be able to widen it.

---

## 11. Locale, timezone and dates

Tests must not depend on the developer's locale, timezone, date format, decimal separator
or language. `toLocaleString()`, `toLocaleDateString()` and a bare `new Date().toString()`
are all ambient.

Avoid parsing human-readable command output. Prefer machine-readable formats — JSON, ISO
8601, a structured API response — and say explicitly whether a stored timestamp is UTC,
local time, or offset-aware, because a bare epoch number is the one form that cannot be
misread.

---

## 12. Terminal and output

Do not assume ANSI colour, Unicode box drawing, a particular terminal width, cursor
control, an interactive stdin, or clipboard access. A CLI must degrade cleanly when
stdout is a pipe or a file, which is how its output is captured in this repository's
verification scripts.

Emit machine-readable output where a script consumes it, and keep human formatting on a
separate flag or stream, so a consumer never has to parse a coloured string.

---

## 13. Architecture and native dependencies

Do not assume the developer's CPU architecture is the target's. `x64` and `arm64` are
both in play on macOS in particular, and both are in play for a desktop application
shipped as a package.

This repository declares **no** `cpu` constraint in `package.json`, so every native or
prebuilt dependency must resolve on every supported platform and architecture:

- `electron` is a prebuilt runtime, resolved per platform by npm's optional dependencies.
- `better-sqlite3` is a native module and the one dependency that will actually need a
  working prebuilt binary or a toolchain for the target.

Before adding a dependency, determine whether it needs a compiler, system headers, an
SDK, or a platform-specific binary, and prefer a dependency that ships supported
prebuilds for all three platforms.

---

## 14. Installation and setup

Installation is where an OS assumption becomes a user-visible failure, so it gets its
own review. The surfaces are `agent-ping install`, `uninstall`, `status` and `doctor`, the
per-platform autostart units, the npm `files` allowlist and the `prepack` guard. The
per-platform unit table and the state layout are documented in
[the administrator guide](admin-guide.md) and are not duplicated here.

The properties that hold on every platform, and that a change must not break:

- **User-scoped only.** No `sudo`, no system unit, no machine-wide change, no registry
  key, nothing elevated. Everything is written under the installing user's own account.
- **Idempotent and reversible.** Running `install` twice changes nothing the second time;
  `uninstall` removes what `install` wrote and keeps the database.
- **Owner-only.** Every file this product writes is user-owned, and tightening a mode is
  best effort.
- **No platform-notification permission.** The card and the tray icon are drawn by
  agent-ping itself ([ADR-012](adr/ADR-012-surface-is-rendered-by-agent-ping.md)), so
  there is no per-platform permission to request and no per-platform service to
  configure.

---

## 15. Testing strategy

### Portable unit tests

A unit test must not depend on OS-specific behaviour. Where a branch is genuinely
platform-dependent, inject the platform rather than reading `process.platform`, and inject
`env` rather than mutating `process.env`. `resolveStateDir` is the reference shape.

### Platform-specific tests

Explicitly validate what really differs: the bytes of each autostart unit, the state
directory layout on each platform, the quoting of each interpreter. A test that asserts
Linux paths are correct says nothing about the Windows unit, and a test that only ever
runs on the author's machine cannot be evidence for a platform claim.

### Scripts and automation

The scripts under `scripts/` drive real software: a real opencode session, a real service
manager, a real browser, a real display. They are Node ES modules for the portability
reasons above, they create scratch directories with `mkdtempSync` under `os.tmpdir()`,
and they report a missing external tool by name rather than skipping quietly.

They do not spawn tools through `node_modules/.bin`. On Windows that directory holds a
generated `.cmd` batch shim, and Node refuses to spawn a `.cmd` without a shell — so
every build and test entry point went through `scripts/lib/node-tool.mjs`, which reads
the tool's own `bin` field out of its `package.json` and runs that file with
`process.execPath`. An executable plus an argument array, no shell, identical on all
three platforms. npm itself is the one exception, because under an npm script
`npm_execpath` names the running npm's JavaScript entry and needs no lookup at all.

A missing harness, a missing browser or a missing service manager is a **failure**, not a
skip. A verification script that can report success without having exercised anything is
worse than no script, because it converts an unverified claim into a documented one.

### What the current evidence covers

A GitHub Actions matrix runs `typecheck`, `lint`, the whole Vitest suite, the build and
the prepack guard on `ubuntu-latest`, `macos-latest` and `windows-latest`
(`.github/workflows/ci.yml`). A green cell means the portable half of the contract
holds on that OS: the path resolution, the envelope, the store, the classifier, the
loopback boundary, the CLI, and the bytes of all three autostart units.

A green cell is **not** a claim that the product has been observed on macOS or Windows.
Everything that needs a display, a status area or a service manager is still Linux-only:

- `scripts/verify-autostart-linux.mjs` needs a real `systemd --user` manager. A hosted
  runner has none, so it stays a manual gate on a Linux desktop.
- `scripts/verify-notification-surface.mjs` and `npm run test:e2e` need a real display
  and are not in the matrix.

So the register of what is still owed is unchanged:
[`docs/reviews/deferred-gates.md`](reviews/deferred-gates.md). The matrix narrows what
is *unverified*, it does not discharge anything.

---

## 16. Audit checklist

Run this before declaring work complete.

### Filesystem

- [ ] No hard-coded OS paths
- [ ] No manual path separator or string concatenation
- [ ] No case-sensitivity, drive-letter or reserved-filename assumptions
- [ ] No symlink or executable-bit assumption outside the platform's own convention
- [ ] Temporary directories come from `os.tmpdir()` and `mkdtempSync`

### Shell and processes

- [ ] No accidental Bash, `cmd.exe` or PowerShell dependency in shared configuration
- [ ] No shell command string where an executable plus argument array exists
- [ ] No shell syntax written into a file another interpreter will read
- [ ] Paths quoted for the interpreter that reads them

### Environment

- [ ] Environment variables read through the runtime or injected `env`
- [ ] No assumed home, config, temporary, PATH or username
- [ ] `chmod` failure treated as survivable

### Runtime

- [ ] Process startup, monitoring and shutdown portable
- [ ] Loopback bind and port selection explicit
- [ ] Locale, timezone and terminal capabilities not assumed

### Dependencies and packaging

- [ ] `better-sqlite3` and `electron` resolve per platform and architecture
- [ ] Native and prebuilt requirements identified before a dependency is added
- [ ] Install, uninstall, status and doctor reviewed for all three platforms
- [ ] Autostart units still user-scoped, idempotent, reversible and owner-only

### Running a tool the repository depends on

- [ ] No `.bin` shim is spawned; the tool is resolved through `scripts/lib/node-tool.mjs`
- [ ] No bare `npm` is spawned; `npmTool()` is used instead
- [ ] Every child process is an executable plus an argument array, never a command string
- [ ] A tool that is not installed is reported as absent, not as a spawn failure

### Testing

- [ ] Tests independent of the developer's OS, shell, locale, timezone and home directory
- [ ] Platform branches driven through injected parameters
- [ ] POSIX-only assertions guarded rather than deleted, so they still run where they apply
- [ ] Tests that need a delivered signal confined to a host that delivers them
- [ ] Tests that only need a process gone do not assert an exit code
- [ ] The CI matrix green on all three platforms
- [ ] Claims about macOS and Windows backed by something stronger than a Linux run
