# Deferred human gates: what this project owes

**Read this before trusting `docs/WORKFLOW-STATE.json`.** That file records `OA-6`, `LD-5`
and `IO-5` as `complete`. They are complete as *attested decisions*. None of the three
reviews was performed.

This page exists because closing a gate is silent. The engine marks a human-review task
complete the moment a valid attestation exists, and from that moment nothing in the engine
will ever prompt for the review again. Without this register, the only trace would be
`complete` in a status file, which reads as a pass.

| Gate | Attested decision | The subject existed? | What is owed | Runbook |
| --- | --- | --- | --- | --- |
| `OA-6` | deferral | **yes** — the adapter is built and NS-4 drove the shipped build on a real display | three claims only a person can settle (§ below) | [`docs/runbooks/oa-6-opencode-adapter-review.md`](../runbooks/oa-6-opencode-adapter-review.md) |
| `LD-5` | **not reviewable** | **no** — `LD-2`, `LD-3`, `LD-4` were pending when the gate closed | a mouse, keyboard-only and screen-reader journey, plus a density judgement | [`docs/runbooks/ld-5-dashboard-review.md`](../runbooks/ld-5-dashboard-review.md) |
| `IO-5` | **not reviewable** | **no** — `IO-1`–`IO-4` were pending; `src/cli` did not exist | a clean install, four deliberate breakages, an uninstall | [`docs/runbooks/io-5-operations-review.md`](../runbooks/io-5-operations-review.md) |

The distinction in the third column is the whole point. `OA-6` is a review that was
available and not taken. `LD-5` and `IO-5` are reviews of software that had not been
written, and the tasks that write it ran *after* their gate closed.

## The three distinct reasons, in one line each

- **`OA-6` — a reviewable thing, not reviewed.** The work exists and two instruments
  measure most of it. Three claims remain: that answering a *real* permission clears the
  card with no second card; that the tray icon mounts and carries its number; and that a
  person can read the card. NS-4 cannot observe the tray (a `StatusNotifierItem` is not an
  X window) and deliberately does not read the card's contents (that would mean injecting
  code into the renderer). Estimated residual human time: **about five minutes**.
- **`LD-5` — a review owed on work not yet built.** Acknowledgement, deep-link focus,
  terminal handoff and history are all `LD-3`; the keyboard and screen-reader surface is
  `LD-2`. No criterion could be exercised.
- **`IO-5` — a review owed on work not yet built.** `install`, `status`, `doctor` and
  `uninstall` are all `IO-2`. The very first criterion, install from a clean state, was
  impossible.

## What is *not* owed, so nobody reopens a settled gate

These were reviewed and the findings are recorded. Do not re-open them:

- `DP-4` — the dashboard design, approved, evidence in
  `docs/reviews/dashboard-design.json`.
- `HC-7` — the hub's loopback security boundary, approved, evidence in
  `docs/reviews/hub-core.json`.
- `CP-3` — **deferral**, and a genuinely reviewed one. It was a decision made against two
  captured traces from a real Copilot CLI 1.0.88, recorded in
  `docs/reviews/CP-3-console-review.md`, and `CP-4` turned it into a runbook and a test.
  It is the precedent for the `OA-6` record, and unlike `OA-6` its subject existed to be
  decided about.

## One known evidence gap, unrelated to the three gates

`OA-5` declared only `scripts/verify-opencode-live.mjs` and its test as outputs, so
`docs/reviews/opencode-live-evidence.json` was never committed. The real-binary journeys
ran, and no summary was retained. Re-running the script and committing the file needs no
human and would restore the missing half of the end-to-end evidence. It is the cheapest
outstanding item on this page.

## Issue log

For feedback gathered while reading the product before the reviews above happen. Add a row
per issue; do not fix them here — each needs a decision, and some will need a task.

| Date | Gate or surface | Issue | Severity | Disposition |
| --- | --- | --- | --- | --- |
| — | — | _nothing recorded yet_ | — | — |

## How to discharge a debt

The engine cannot re-open a completed gate. `reset-changed` only touches tasks listed in
`manifest.reconciliation.changedTaskIds`, and it is for contracts that changed, not reviews
that were skipped. So each of these needs **new work** raised as tasks, and the manifest
recompiled:

1. Run the gate's runbook.
2. Record the result in the same file this register points at, replacing the
   "not reviewable" decision with a real verdict — and keeping the residual list, updating
   it rather than deleting it.
3. Raise the follow-up task(s) in the owning feature document, recompile, and let the
   engine run them.
4. Remove the row from the table above when the new gate is genuinely attested, and note
   the date here.

**A gate is not discharged by a later passing test.** `LD-4` will drive a browser through
the dashboard journey and `IO-4` will script autostart on Linux; neither is the human
judgement their gates exist for, and neither should be cited as closing `LD-5` or `IO-5`.
