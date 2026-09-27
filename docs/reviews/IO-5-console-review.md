# Human Review: the install and diagnostic experience

Reviewer: Doug McCusker
Reviewed at: 2026-09-27T21:40:00.000Z
Task: IO-5
Decision: **not reviewable — the subject does not exist yet. The review is owed.**

---

## Decision: this is not a deferral of a reviewable thing

**At the moment this record was written, the commands this gate reviews did not exist.**
There is no `agent-ping` on this machine, no `install`, no `doctor`, no `uninstall`, and no
autostart unit. `package.json` carries no `bin` entry and `src/cli` does not exist. This
gate is being closed against work that has not been written.

As with `LD-5`, the timing is the substance of the problem: closing this gate now marks it
complete, and the four tasks that build the subject — `IO-1`, `IO-2`, `IO-3`, `IO-4` — run
**after** this point. The gate will read "complete" while `doctor` does not yet exist, and
nothing in the engine will re-open it.

## State of the subject at decision time

| Task | State | What it will provide |
| --- | --- | --- |
| `IO-1` | pending | `package.json` packaging metadata, `scripts/prepack-check.mjs`, a test that the build artefacts are present. Explicitly **no CLI commands and no autostart** |
| `IO-2` | pending | `src/cli/index.ts`, `install.ts`, `doctor.ts`, `status.ts`, and their tests. This is the task that creates every command `IO-5` runs |
| `IO-3` | pending | Autostart units for Linux, macOS and Windows, idempotent and reversible |
| `IO-4` | pending | `scripts/verify-autostart-linux.mjs` — login, restart and pending survival on Linux. Explicitly **no human judgement** |
| `NS-4` | complete | The notification surface, and the manual commands in `docs/runbooks/notification-surface.md` §2 that the surface breakage must use |

So of the four acceptance criteria below, **none could be exercised.** The very first
criterion — install from a clean state — is impossible: there is nothing to install.

Note the record's own dependency line lists `NT-4` and `NT-5`, which no longer exist; the
compiled manifest resolves it to `IO-4` and `NS-4`. The feature document's task table has
not been reconciled with that. It is recorded here rather than fixed, because editing
`docs/features/install-autostart-and-operations.md` moves the authoring fingerprints and
belongs in its own pass.

## The review that is owed

1. **Clean-state install, and survival without a manual step.** Install the package
   globally, start an ordinary `opencode` session, and confirm the hub is running with no
   manual step after the next login or restart of the session environment. **State the
   platform.** This is the criterion that decides whether the product is usable by someone
   who has just rebooted, which is the entire promise of `IO-FR-*`'s install story.
2. **Four deliberate breakages, one at a time, each with what `doctor` said.** For each,
   record three things: what it printed, whether the remedy was **actionable**, and whether
   the exit code was non-zero.
   - the hub stopped
   - the port occupied
   - the plugin file removed
   - the notification surface made un-mountable by taking its card document out of the
     build, using the manual commands in `docs/runbooks/notification-surface.md` §2

   **The surface breakage matters more than the other three**, and the contract says so. The
   requirement is that `doctor` reports a surface that cannot create a window as a
   *distinct* failure, with a remedy that names the real cause — not a remedy telling the
   developer to reinstall something that is already installed. A generic "run doctor again"
   or a reinstall suggestion fails this criterion even though the command exits non-zero.
3. **Uninstall leaves nothing but the database.** Uninstall, and confirm what remains. The
   allowed remainder is the database, and nothing else — no state directory, no autostart
   unit, no plugin file, no logs.
4. **Per-platform honesty.** Record that the surface is **one** code path and that only the
   window manager differs, and then name exactly which platforms were actually available to
   observe from the machine used. `APX-CON-06` is explicit that **no macOS or Windows claim
   may be made from a Linux machine**, and this repository has never run on either. The
   criterion's own wording is the point: report what was not observable rather than
   reporting a pass for it.

## What the constraints require that a test cannot

`IO-5` carries `APX-CON-06`, and the third acceptance criterion exists because the second
is easy to fake. A green test suite proves `doctor` returns the right code for a given
condition. It does not prove that:

- the remedy a developer reads is one they can act on,
- the exit code distinguishes "broken" from "not installed" in a way a script respects,
- a real reboot leaves the hub running, and
- nothing survives an uninstall that a user did not expect to survive.

Every one of those is a judgement about a human being stuck at 2am, which is the situation
`IO-US-02` is written for.

## Residual risk, including what a user is not told

**A developer following the README today has no install command to run, and will find
that out by failing.** The README says so in an `> [!IMPORTANT]` block, which is honest, but
the honest statement and a working experience are different things.

Two narrower risks, both consequences of closing a gate before its subject exists:

- Nobody has seen what `doctor` actually prints for a real fault. Its messages are unit
  tested for a correct code and exit status; whether they are *useful to a human* at 2am is
  the untested part, and it is the part `IO-5` exists to test.
- Nobody has confirmed a reboot leaves the hub up. `IO-4` will script it on Linux, and
  `IO-3` will make the units idempotent and reversible, but neither is the observation.

## What this decision does not change

- No acceptance criterion was deleted, weakened, or marked met. All four stand, unmet.
- Platform support is still Linux, macOS and Windows in v1, served by one surface
  implementation. Nothing here narrows that, and nothing here claims a second of it has run.
- No code was changed, and none of the four pending tasks was re-scoped to make closing
  this gate easier.

## What would have to change to revisit

Run `docs/runbooks/io-5-operations-review.md` after `IO-4` completes, then re-open this
gate as new work. `docs/reviews/deferred-gates.md` tracks the obligation.

## What this task did not do

- Nothing was installed, started, broken, diagnosed or uninstalled.
- No `doctor` output was read, because `doctor` does not exist.
- No judgement was formed about remedy quality, exit codes, reboot survival or what an
  uninstall leaves behind.
- No platform claim was made for macOS or Windows, or for Linux.
- No code was changed.
