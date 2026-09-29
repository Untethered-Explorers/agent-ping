# The three-platform matrix: what it found, and what it still owes

**This page is the record of the first honest look at this repository on anything other
than Linux.** `package.json` has declared `"os": ["darwin", "linux", "win32"]` since the
package was written, and until `.github/workflows/ci.yml` existed nothing checked it. The
declaration was a manifest line; this is what the code actually does on three operating
systems.

> For the product, read the [user guide](../user-guide.md) and the
> [administrator guide](../admin-guide.md) first. For the rules a change has to follow, see
> [the cross-platform guide](../cross-platform.md). This page is neither of those: it is
> what the matrix found, what was fixed, and the named remainder.

**It is not a claim that the product works on macOS or Windows.** Two of the three
platforms pass the portable suite. Nothing in this repository has run the *product* — a
hub, a card, a tray, a login — on anything but one Linux desktop, and that has not
changed. See [Known gaps](../user-guide.md#known-gaps) and
[`deferred-gates.md`](deferred-gates.md).

## What the matrix runs, and what it deliberately does not

`.github/workflows/ci.yml`, on `ubuntu-latest`, `macos-latest` and `windows-latest`:
`npm ci` → `typecheck` → `lint` → **`build`** → `test` → `prepack`. The Node version is
read from `engines.node` in `package.json`, so the matrix cannot drift onto a version the
package no longer claims to support.

Three things are **not** in it, and each is a deliberate omission rather than a gap:

| Excluded | Why |
| --- | --- |
| `scripts/verify-autostart-linux.mjs` | needs a real `systemd --user` manager over a session bus; a hosted runner has none |
| `scripts/verify-notification-surface.mjs` | needs a real display and a real status area |
| `npm run test:e2e` (Playwright) | needs a per-OS display decision and a Chromium download per runner image |

A job containing them would be permanently red while proving nothing, and a permanently
red job is how a team learns to ignore red. So a green cell means the **portable half** of
the contract holds on that OS — the state layout, the envelope, the store, the classifier,
the loopback boundary, the CLI, and the bytes of all three autostart units. It narrows
what is unverified. It discharges nothing.

## What it found

Eight defects, each invisible on the platform that wrote the code. Two of them are
user-visible product behaviour; the rest are the suite being unable to observe anything.

| # | Defect | Consequence if shipped |
| --- | --- | --- |
| 1 | `scripts/build.mjs` and `run-tests.mjs` spawned tools through `node_modules/.bin` | On Windows those are `.cmd` shims, which Node refuses to spawn without a shell (`EINVAL` since the CVE-2024-27980 fix). **The build and the test command could not run on Windows at all.** |
| 2 | Five hub fixtures resolved their entry with `pathToFileURL(new URL(...).pathname)` | A double URL conversion. On Windows, `D:\D:\a\…`. Every hub, e2e and RSS fixture died before starting a process, so the lifecycle, delivery, single-instance and footprint assertions all reported *a missing runtime file* — 50 tests, one cause. |
| 3 | `src/storage/paths.ts` `resolveStateDir` joined with the ambient `path` | It takes `platform` as a parameter precisely so a test can drive all three branches, then undid it. Asked for the Linux layout on Windows it answered `\home\dev\.local\state\agent-ping`. |
| 4 | `src/cli/autostart/linux.ts` and `macos.ts` joined with the ambient `path` while `index.ts` created their directories with `path.posix` | The two halves disagreed about which platform the path belonged to. `path.posix.dirname` of a backslashed string returns `"."`, so no directory was created and the unit write failed with ENOENT. `windows.ts` had always used `path.win32` correctly. |
| 5 | `src/plugin/install/global-plugin.ts` `resolveOpencodeConfigDir` joined with the ambient `path` | opencode resolves with `xdg-basedir`, which is POSIX **on Windows too** — which is the whole reason the function has no `%APPDATA%` branch. So on Windows the product named `\Users\dev\.config\opencode`: a real directory, and not the one opencode reads. **A silently ineffective install**, not a crash. |
| 6 | The workflow ran `Test` before `Build` | `verify-opencode-live` starts the *built* product. It passed locally only because a stale `dist/` was lying around. |
| 7 | A `doctor` test asserted the preferred port was named | That only happens when something else holds 43117 — which, on the author's machine, was a leaked probe hub from a day earlier. A green test that depended on leftover state. |
| 8 | Three hubs in `tests/hub/server.test.ts` were never closed | Their SQLite connections were still open when the cleanup hook tried to delete the state directory. An EPERM on Windows; a silent leak everywhere. |

Also fixed, without which none of the above would have been *visible*: `.gitattributes`
(a Windows checkout could rewrite every text file to CRLF, which the byte-for-byte
autostart tests and the prepack guard both read), a POSIX joiner for XDG paths, 11
unguarded POSIX mode assertions, an unquoted path in a generated shell command, three
`process.env.HOME` reads where `os.homedir()` is correct, and a Windows separator
hard-coded into a `PATH` assertion.

### How it narrowed

| Run | ubuntu | macos | windows |
| --- | --- | --- | --- |
| first matrix run | ❌ 6 | ❌ 6 | ❌ 50 |
| after the fixture conversion (defect 2) | ✅ | ✅ | ❌ 38 |
| after the path-flavour fixes (defects 3–5) | ✅ | ✅ | ❌ 45 → 35 |
| after the XDG follow-through | ✅ | ✅ | ❌ 35 |
| after the signal-delivery fix | ✅ | ✅ | ❌ 30 |
| after closing three hub leaks | ✅ | ✅ | ❌ 24 |
| after the NTFS `readlink` fix | ✅ | ✅ | **❌ 22** |

The 38 → 45 step is in the table because it happened: making the *product* return a
correct POSIX path moved the disagreement into thirteen test expectations that had been
wrong in the same way, and the count went up before it came down. Both halves had to be
fixed; fixing only the product looks like a regression.

## What is left, and why it is not twenty-two bugs

**22 failing tests on `windows-latest`.** `ubuntu-latest` and `macos-latest` are green.
They group into four causes, and only the first is one problem.

### 1. The simulated Windows home cannot be written (9)

`tests/cli/autostart.test.ts` drives all three platforms from whichever one it runs on, and
the Windows machine's home is the literal `C:\Users\agent-ping test`. No runner can write
there: on Windows the account does not exist and `C:\Users` needs elevation; on a POSIX
machine the drive prefix is not a path. The product writes nothing, so the assertions see
an empty listing — which the suite reports as *"the enable wrote nothing to look for"*,
a phrase that reads as a product defect and is not one.

**This is one design problem in the test harness, not nine failures.** The fix is to root
the simulated profile inside the run's temporary directory while keeping its Windows shape
— including the space in the name, which is what the `cmd.exe` quoting assertions exist
for. It was attempted twice and reverted both times: on a POSIX host `path.win32.join`
turns the whole path into a single flat filename, which is internally consistent but not
the same tree, and the listing assertions then disagree with themselves. It needs the
harness reworked, not a path swapped.

### 2. Two more unclosed resources (2)

`EPERM` in `tests/plugin/poll-fallback.test.ts` and `tests/cli/install.test.ts` — the same
leak as defect 8, in two other fixtures. `tests/helpers/remove-tree.ts` already retries
for two seconds before giving up, so these are not races.

### 3. A path expectation still carrying a host assumption (5)

`tests/notify/surface-host.test.ts:430` and `surface-channel.test.ts:592` assert
`resolveCardPreloadPath('file:///opt/agent-ping/…')` returns `/opt/agent-ping/…`; on
Windows a file URL converts to `\opt\agent-ping\…`. `tests/plugin/install.test.ts:540` and
two more in `autostart.test.ts` join an expectation with the ambient separator against
entries the product now builds in POSIX. Same class as the eleven that were fixed; these
are the stragglers the sweep in `tests/tooling/fixture-imports.test.ts` does not yet cover.

### 4. Tests that need a real prerequisite (3)

`tests/scripts/probe-copilot-hooks.test.ts` and `probe-copilot-acp.test.ts` drive the real
Copilot CLI probe and expect exit code 5 (a phase passed its deadline). The probe returned
**3**, which is its documented "the binary is missing or unreadable" — correct behaviour on
a Windows runner with no `copilot` installed. The probe is right; the test is asserting an
environment. It needs either a prerequisite check or a stated skip.

`tests/hub/stream.test.ts:1757` expects a measurement fixture labelled
`typescript-source` and did not get one, most likely for the same reason as defect 2.

## One thing that is not on the Windows list, and should not be added to it

`tests/plugin/poll-fallback.test.ts` is **load-sensitive and has been since before this
work**. One of its cases waits a fixed 150 ms and then asserts the poller made more than
one request:

```ts
await new Promise((resolve) => setTimeout(resolve, 150))
expect(opencode.requests.filter((entry) => entry.includes(PERMISSIONS_PATH)).length)
  .toBeGreaterThan(1)
```

The poller's own cadence is `baseDelayMs: 5, maxDelayMs: 10`, so whether two cycles
complete inside 150 ms depends on how much CPU the box has. It passes when the file is run
alone and fails when the whole suite is running 49 workers at once.

Checked against `1e5a320`, the commit before any of this work, in a clean worktree: that
commit fails **6–7 tests** in the full-suite context under load, of which the same
`poll-fallback` family is the largest group. This branch fails **1** of them, and 0 when
not under repeated load. So it is a pre-existing timing bug that this work reduced rather
than caused, and it is not a portability defect — it fails identically on all three
operating systems.

It is recorded here because of what it is a hazard for: a red cell that is red for a reason
unrelated to the cell's platform is exactly how a matrix loses its authority. Whoever
finishes the Windows list should fix this one first, so that the remaining failures are
attributable.

## Two things that are not defects, and should not be "fixed"

Recorded here so nobody spends a cycle on them.

**Signals are not deliverable on Windows.** `child.kill('SIGTERM')` raises the signal on
Linux and macOS and the handler runs. On Windows it is `TerminateProcess` for every signal
name — no delivery, no handler, and Node reports `signal: 'SIGTERM'` anyway, so the
coercion is invisible. The product is correct as written: its guarantee was never "always
stops cleanly" but that a hub ended abruptly is **reclaimed** by the runtime-file liveness
check (`src/hub/runtime-file.ts`, ADR-001), which is the path Windows always takes. The
ordered close is a courtesy a Unix service manager gets; the reclamation is the guarantee.
A graceful Windows stop would need a cross-platform channel — a loopback shutdown route or
a Windows service control handler — and the write surface is a closed union of one route
(ADR-002), so a second one is a decision for a human to accept in writing, not a
portability patch. `src/hub/lifecycle.ts` now says this at `SHUTDOWN_SIGNALS`.

**Windows has no POSIX permission bits.** `statSync().mode & 0o777` reports 0o666 or 0o444
from the read-only attribute, so a `toBe(0o700)` fails against a filesystem behaving
correctly. The guards follow the pattern `tests/storage/eventStore.test.ts` already used,
and the octal assertions were split out of their tests rather than skipping the behaviour
beside them — path resolution, containment, token shape and idempotence are still asserted
on a Windows host. A `chmod` that the platform refuses is best effort by design
(`src/storage/paths.ts`).

## The order to take the rest in

0. **The load-sensitive `poll-fallback` case**, above. Not Windows work, and first anyway:
   a cell that is red for an unrelated reason cannot be read as evidence about Windows.
1. **The simulated Windows home** (cause 1). Nine tests, one design change, and it is the
   precondition for reading the other nine autostart failures honestly.
2. **The two remaining leaks** (cause 2). Small, and the same fix as defect 8.
3. **The three path expectations** (cause 3). Mechanical once cause 1 stops moving the goalposts.
4. **The probe prerequisites** (cause 4). A decision about what those tests are for: they
   test a real-binary probe, so either they require the binary or they state that they
   skip without it.

## Re-measuring

The matrix is the instrument, so the honest thing is to use it rather than to reason about
the remaining 22 by reading the log. Push the branch and read the Windows cell:

```bash
gh run list --branch chore/check-cross-platform --limit 1
gh run view <run-id> --json jobs \
  -q '.jobs[] | .name + ": " + .conclusion'
gh run view <run-id> --log-failed
```

A local run on Linux cannot reproduce any of this, which is the point of the page. Two
things *can* be checked locally, because they simulate platforms rather than running on
them: `tests/cli/autostart.test.ts` and the file-URL guards in
`tests/tooling/fixture-imports.test.ts`.

## Related

- [`docs/cross-platform.md`](../cross-platform.md) — the contract and the rules, including
  the audit checklist
- [`deferred-gates.md`](deferred-gates.md) — the human-review register, which this does not
  touch
- [`docs/reviews/operations.json`](operations.json) — the operations evidence
