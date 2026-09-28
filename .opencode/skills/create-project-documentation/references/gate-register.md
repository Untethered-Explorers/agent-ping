# Closed-gate register template

> Load when a project gates work on human judgement and its task engine can mark a gate complete
> without anyone having performed the review, or when a platform path has been abandoned rather
> than deferred.

A register is not a review file. It is the page that stops a *closed but unperformed* gate from
reading as a pass.

## Why it is needed

Task engines close a human-review gate the moment a valid attestation exists — a decision, a
timestamp, a file path — and from that moment nothing prompts for the review again. The status
file then says `complete`, which every reader downstream interprets as a pass.

Two things become invisible at once:

- whether the software the gate was about **existed yet** when the gate closed, and
- what is still owed, and how to discharge it.

Both are answersable only by hand, so they have to be written down by hand. If nobody writes
them down, the honest state of the project is permanently misreported.

## Shape

Every `<…>` placeholder below, including the runbook paths, is rewritten with this project's own
gate identifiers and files before the page is written. The shape is the deliverable; the
placeholders are not.

```markdown
# Deferred human gates: what this project owes

**Read this before trusting `<engine state file>`.** That file records `GATE-A`, `GATE-B` and
`GATE-C` as `complete`. They are complete as *attested decisions*. None of the three reviews
was performed.

| Gate | Attested decision | The subject existed? | What is owed | Runbook |
| --- | --- | --- | --- | --- |
| `GATE-A` | deferral | **yes** — the work is built and `<evidence>` drove the shipped build | <what only a person can settle> | [runbook](../runbooks/gate-a-review.md) |
| `GATE-B` | **not reviewable** | **no** — `<tasks that were still pending>` | <the journey that must now be run> | [runbook](../runbooks/gate-b-review.md) |
| `GATE-C` | **not reviewable** | **no** — `<the module did not exist>` | <even the first criterion was impossible> | [runbook](../runbooks/gate-c-review.md) |

## The distinct reasons, one line each

- **`GATE-A` — a reviewable thing, not reviewed.** <what the instruments can and cannot
  measure, and the estimated residual human time>
- **`GATE-B` — a review owed on work not yet built.** <which tasks own the subject>

## What is *not* owed, so nobody reopens a settled gate

- `GATE-X` — <what was reviewed>, <where the evidence is>.

## One known evidence gap

<An item that is not a gate: a declared output that was never committed, with the cost of
fixing it.>

## Issue log

| Date | Gate or surface | Issue | Severity | Disposition |
| --- | --- | --- | --- | --- |
| — | — | _nothing recorded yet_ | — | — |

## How to discharge a debt

<The concrete procedure, because the engine cannot re-open a completed gate.>
```

## Rules

1. **The third column is the whole point.** "Yes" and "no" are different debts. A reviewable
   thing that was not reviewed is a few minutes of a person's attention. A review of software
   that did not exist is a task that has to be raised, compiled and run *first*. Collapsing them
   into one "pending" hides the fact that one of them has no subject yet.
2. **Never write a verdict.** The register states what is owed and who owes it. The verdict
   itself still belongs to a person, exactly as in the review file.
3. **Name what each gate's instruments could not observe, and why.** A verification run that
   deliberately does not read a surface is a reason the gate is still open, not a reason it is
   closed.
4. **List settled gates too, and say do not re-open them.** A register that only records debts
   invites a later reader to re-litigate a decision that was properly made and evidenced.
5. **Record the abandoned path, not only the deferred one.** When a platform path is withdrawn
   rather than deferred — because delivery stopped being per-platform, or because it blocked
   later work — leave its evidence file untouched as the record of the mechanism abandoned, and
   say in the register that the gate is withdrawn and what replaced it. Deleting the file
   destroys the only trace of the decision.
6. **State the discharge procedure, because the mechanism cannot.** Engines generally cannot
   re-open a completed gate, and their task-reconciliation path is for changed contracts, not
   skipped reviews. So each debt needs new work raised as tasks, compiled, and run. Write that
   down where the person discharging it will find it.
7. **Say what does not discharge a debt.** An automated run that happens to cover the same
   surface is not the human judgement the gate exists for, and must not be cited as closing it.
8. **Carry an issue log.** Feedback gathered while reading the product before the reviews happen
   belongs here as a row, unfixed, because each needs a decision.

## Validate

- [ ] Every gate the engine records `complete` but with no human journey is in the table.
- [ ] The "subject existed?" column is filled for every row from the task history, not assumed.
- [ ] Every row with no subject names the tasks that would build it.
- [ ] Every row links to a runbook that states how to perform the review.
- [ ] No row contains an outcome, verdict or judgement attributed to a person who did not give
      one.
- [ ] Settled gates are listed separately with a do-not-reopen note.
- [ ] The discharge procedure matches the engine's actual capabilities, checked against the
      engine's own commands rather than assumed.
- [ ] The register is linked from the documentation index and from wherever the status file is
      read.
