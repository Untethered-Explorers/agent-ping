# Runbook: reviewing IO-5, the install and diagnostic experience

> **Status: this review is owed, not done.** The gate was closed before its subject existed
> — `IO-1` through `IO-4` were still pending, and `src/cli` did not exist, when `IO-5` was
> attested. See [`docs/reviews/IO-5-console-review.md`](../reviews/IO-5-console-review.md)
> for why, and [`docs/reviews/deferred-gates.md`](../reviews/deferred-gates.md) for the
> debt register.
>
> **This file is the standing procedure for when `IO-4` has completed.**
>
> **Do not change code in this task.** `IO-5`'s contract forbids it. List required changes
> as an explicit list; that is the deliverable.

## 0. Why this gate cannot be automated, and what can

`IO-5` judges whether a diagnostic is *useful to a person who is stuck*. A test asserts
that `doctor` returns the right code for a given condition and exits non-zero. It cannot
assert that the remedy printed is one the reader can act on, that a reboot left the hub
running, or that nothing survived an uninstall that the user did not expect to survive.
That is the situation `IO-US-02` is written for — *"so that I learn what is wrong instead
of guessing"* — and it is a judgement, not an assertion.

Already covered, so you do not rebuild it:

| Covered by | What it proves |
| --- | --- |
| `IO-1`, complete | The package publishes, the files allowlist is right, and a prepack check fails when a build artefact is missing |
| `IO-2`, complete | The four subcommands, driven through the command entry point, unit-tested including the failure exits |
| `IO-3`, complete | Autostart units per platform, idempotent and reversible, against a temporary home |
| `IO-4` (pending) | `scripts/verify-autostart-linux.mjs` — login, restart and pending survival on Linux |
| `OA-5`, complete | The real `opencode` binary reaching a real permission decision against a real hub |
| `NS-4`, complete | The notification surface, and the manual commands in `docs/runbooks/notification-surface.md` §2 |

## 1. Before you start

- **A clean state.** "Clean" for this review means: no global `agent-ping`, no state
  directory, no autostart unit, no plugin file in opencode's global plugin directory. If you
  have been developing against this repository, that is not the state you are in, and
  §2 tells you how to get there and how to prove you got it.
- The repository built: `npm run build`, then `npm test` green.
- **Record the platform and desktop environment precisely** — OS and version, desktop
  environment or window manager, and whether a reboot is something you can actually do
  during this review. Criterion 4 depends on knowing what you could and could not observe.
- Read the state directory location before you delete anything. `IO-FR-07` resolves it
  through an overridable platform directory, and the uninstall check in §5 is only
  meaningful if you know what "everything except the database" is.

## 2. Get to a clean state, and prove it

```bash
# What is currently installed, if anything. Do this BEFORE removing it, and keep the output.
which agent-ping || echo "not on PATH"
ls -la "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/" 2>/dev/null
systemctl --user list-unit-files 2>/dev/null | grep -i agent-ping || echo "no user unit"
```

Remove all of it, then **prove the removal** rather than assuming it — each of those three
commands must now report nothing. Record what you removed; that list is the baseline the
§5 uninstall check is measured against.

If the product's own `uninstall` already exists at this point, prefer it, and note that you
used it — that is a data point about `IO-5` itself.

## 3. The install journey

```bash
agent-ping install
```

`IO-FR-02` requires this to write the global plugin, enable autostart for the platform,
verify hub health, and **print exactly what it changed**. So record:

- What it printed, verbatim. Then check it against what actually changed — the plugin file,
  the autostart unit, the state directory. **A command that claims less than it did is a
  finding**, and so is one that claims more.
- Did the hub come up? `agent-ping status` reports pending count, most recent event time,
  uptime and active session count, and per `IO-FR-05` **says so plainly when the hub is not
  running**. Check that it does say so, by looking at what it prints when the hub is down
  in §4.
- **Run `agent-ping install` a second time.** `IO-FR-08` requires it to be safe, to report
  that nothing changed, and to detect a version mismatch between the installed plugin and
  the package. All three, or it is a finding.
- Start an ordinary `opencode` session and confirm the hub is running with **no manual
  step** — no environment variable you had to set, no terminal you had to keep open, no
  command you had to remember.

Then the criterion that actually decides usability: **log out and back in, or restart the
session environment, and confirm the hub came up on its own.** `IO-FR-06` requires a
user-level unit that needs no root. If you cannot reboot during this review, write
*"reboot survival not observed on this machine; criterion 1 partly unverified"* rather than
inferring it from the unit existing.

## 4. The four deliberate breakages

One at a time. Between each, **restore the previous state** so you are never diagnosing two
faults at once — and say in your notes that you did.

For every breakage, record three things, all three required:

1. **What `doctor` printed**, verbatim.
2. **Whether the remedy was actionable** — could you have fixed it from that text alone,
   without reading the source or searching the web?
3. **The exit code.**

```bash
agent-ping doctor; echo "exit=$?"
```

`IO-FR-04` requires `doctor` to check the runtime version, database path and writability,
port availability, plugin presence and version, autostart state, notification-surface
availability and tray availability, printing **one actionable remedy per failure** and
exiting non-zero when any check fails. Check each of those seven appears.

| # | Breakage | How | The thing to watch |
| --- | --- | --- | --- |
| 1 | Hub stopped | stop the hub process | `status` must say plainly that it is not running (`IO-FR-05`) |
| 2 | Port occupied | occupy the hub's port with anything | The remedy must name the port and what holds it, not "port unavailable" |
| 3 | Plugin file removed | delete the installed plugin file | Must be distinguished from "plugin is the wrong version" |
| 4 | **Surface un-mountable** | take the card document out of the build, per `docs/runbooks/notification-surface.md` §2 | **The one that matters most — see below** |

### Breakage 4 is the crux, and it is the one to spend your time on

`IO-FR-04` and `IO-2`'s own description are both explicit:

> Surface availability means the host can actually create its window on this machine, which
> is a different question from whether Electron is installed, and the remedy must name the
> difference rather than telling the developer to reinstall something that is already
> present.

So the pass fails if `doctor` reports an un-mountable surface with a remedy that says
*reinstall*, *reinstall Electron*, or anything else that addresses a problem the developer
does not have. A correct exit code and a generic remedy is still a failure — this is the
whole reason the criterion singles this breakage out.

Record: what the check is called, what it said, what it told you to do, and whether that
was right. If `doctor` cannot distinguish "the host cannot create a window here" from
"Electron is missing", that is the headline finding of this review.

Note also that `doctor` is **report-only by decision** (Open Question 3: *"a tool that fixes
things silently is harder to trust"*). Do not record "it did not fix my problem" as a
defect. Record whether it *told* you how, which is the requirement.

## 5. Uninstall

```bash
agent-ping uninstall
```

Then confirm what remains. `IO-FR-03` requires the plugin removed, autostart disabled, and
**the database left in place unless a purge flag is passed** (Open Question 4: purge is
explicit, so a mistaken uninstall is recoverable). So:

- The database is still there. Check it.
- The plugin file is gone. Check it.
- The autostart unit is gone, with no duplicate or disabled leftover. Check it.
- **Nothing else.** No logs, no state directory beyond the database, no runtime file, no
  token. `IO-FR-09` writes a bounded local log — find it and confirm whether it was removed
  or deliberately kept, and whether that matches what the command said it did.

Then optionally `agent-ping uninstall --purge` (confirm the flag from `--help`; the exact
spelling is `IO-2`'s to define) and confirm the database goes too.

## 6. Per-platform honesty, and what you must not claim

`APX-CON-06` is the constraint, and it is unusually direct: *"no macOS or Windows claim is
made from a Linux machine."*

State plainly that the notification surface is **one** code path across all three platforms
and that only the window manager differs. Then name, explicitly, **which platforms were
actually available to you**. If you reviewed on Linux, the record says Linux, and macOS and
Windows are named as not observed. This repository has never run on either.

**A platform you did not observe gets no verdict.** Not "presumed working", not "should be
fine since the code is shared". Criterion 4's own wording demands exactly this: *report what
was not observable rather than reporting a pass for it.*

## 7. What this runbook cannot tell you yet

`IO-1`, `IO-2` and `IO-3` exist; `IO-4` does not. Confirm from `agent-ping --help`
before relying on any line above, and update this section rather than trusting it.

**Already answered by `IO-2`, and re-checkable from `--help`:**

- **The exact flag spellings** — `--purge` (with `uninstall`), `--force` (with `install`,
  which is the version-mismatch override), `--verbose` (the `IO-FR-09` mirror). A flag
  given to the wrong command is refused with exit 2 rather than ignored.
- **`doctor`'s actual check names**, in the order it prints them: `runtime`, `database`,
  `port`, `plugin`, `autostart`, `notification surface`, `tray`. Two of them are
  `unknown` rather than `ok` or `fail` when no hub is running — a check that could not be
  evaluated has not found a fault, and it does not change the exit code.
- **What `uninstall` removes and what it keeps**: the plugin file, the autostart unit and
  the bounded local log go; the database stays; the runtime file and the write token are
  kept while a hub is running, and the output says so.

**Answered by `IO-3`, and checkable yourself on the machine you are reviewing:**

- **The autostart unit names** per platform, and where the platform state directory resolves
  to on yours:
  `$XDG_CONFIG_HOME/systemd/user/agent-ping.service` (or `~/.config/...`) on Linux,
  `~/Library/LaunchAgents/local.agent-ping.hub.plist` on macOS, and
  `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\agent-ping.cmd` on Windows.
  On Linux the unit is only *enabled* when the `default.target.wants` symlink beside it
  is present, which is what `doctor`'s `autostart` check reads.
- **Whether a real login actually starts the hub.** The units are implemented and
  unit-tested against a temporary home, but no live service manager has run them here:
  `IO-4`'s script is the evidence for Linux and a human gate is the only possible
  evidence for macOS and Windows. Do not record a login as working on the strength of
  the unit file alone.
- **What `IO-4`'s script already covers on Linux**, so you do not repeat it — and so you
  know which of your observations are the only evidence for macOS or Windows.

## 8. Record the verdict

Write `docs/reviews/IO-5-console-review.md`. It currently holds the "not reviewable"
decision and the list of owed criteria — **replace the decision, keep the owed list and
update it.** A verdict that deletes the residual rather than resolving it is the failure
mode this project has hit before.

```markdown
## Verdict
<approved / not approved, one sentence>

## Required changes
Explicit list. Each: what, where, why it blocks. Listing is the deliverable; fixing is out
of scope for this task.

## Conditions
Platform and version, desktop environment, clean-state baseline, whether a reboot was
possible, screen/session environment.

## Install
<what it printed, what actually changed, second-run behaviour, version-mismatch detection>

## Breakages
One block per breakage: what doctor printed, whether the remedy was actionable, exit code.
Breakage 4 called out separately, with the remedy quoted.

## Uninstall
<what remained, what was removed, purge behaviour>

## Platforms
Observed: <…>. Not observed: <…>. No pass is claimed for the latter.

## Residuals
<what remains unverified, if anything>
```

Then attest, from the CLI. **Not** the console's approve form: it regenerates
`docs/reviews/IO-5-console-review.md` from a single notes field and would overwrite
everything above.

```bash
cd .opencode/skills/forge-workflow-engine
npm run workflow-engine -- approve-task IO-5 \
  --repo /path/to/agent-ping \
  --reviewer "Your Name" \
  --evidence docs/reviews/IO-5-console-review.md \
  --confirm-human-review
```

Then remove `IO-5`'s row from `docs/reviews/deferred-gates.md` and date it.

## 9. The traps

- **Reviewing on top of an existing dev install.** §2 exists because a dirty baseline makes
  the uninstall check meaningless — you will not know what you left behind.
- **Breaking two things at once.** Restore between breakages, and say that you did.
- **Accepting a non-zero exit as a pass.** Criterion 2 is the exit code *and* the remedy.
  A correct code with a useless remedy fails.
- **Expecting `doctor` to fix things.** It reports by decision. Judge what it *said*.
- **Treating the surface breakage like the other three.** It is the one the criterion
  singles out, and the one where a generic remedy hides a real distinction.
- **Claiming macOS or Windows from Linux.** `APX-CON-06` forbids it in the requirement, and
  criterion 4's wording exists because this is the easiest false pass in the whole project.
- **Inferring reboot survival from a unit file existing.** That is `IO-3`'s test, not this
  criterion. If you did not reboot, say so.
- **Fixing what you find.** `IO-5` forbids code changes. The list is the deliverable.
- **Attesting, then tidying the review file.** The gate re-hashes its evidence on every
  check; editing after attesting silently invalidates it.
