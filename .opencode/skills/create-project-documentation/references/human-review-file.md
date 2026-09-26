# Human review file template

> Load when a project has human review gates, or when creating, validating or reconciling a
> review file.

A review file is evidence that a **person** observed something. Its shape exists so verdicts are
comparable across gates and so an incomplete review is visible.

## The rule that matters most

An agent may create the empty shape, list the acceptance criteria, and check that a completed
file has a verdict for each one. An agent must never write, infer, complete or close a verdict.

A generated verdict is fabricated evidence about a system nobody observed, and it is worse than
a missing review file, because a missing one is at least honest about the gap.

## Shape

```json
{
  "gate": "<gate-identifier>",
  "reviewer": "<name of the person who performed the review>",
  "performedAt": "<ISO 8601 timestamp>",
  "platform": "<the platform the review was performed on>",
  "journeyPerformed": "<what the reviewer actually did, step by step>",
  "verdicts": [
    { "criterion": "<acceptance criterion, verbatim>",
      "outcome": "pass | fail | blocked",
      "evidence": "<what was observed>" },
    { "criterion": "...",
      "outcome": "...",
      "evidence": "..." }
  ],
  "observations": ["<timing, platform quirk, or anything surprising>"],
  "outstanding": ["<what remains unverified, and on which platform>"],
  "residualRisk": "<what a user would miss if this gate is treated as closed>"
}
```

## Rules

1. **One verdict per acceptance criterion, verbatim.** Copy the criterion text exactly rather
   than paraphrasing, so two gates are comparable and a criterion cannot quietly change meaning
   between gates.
2. **`blocked` is a valid outcome** and means the reviewer could not perform the check. It is
   not a soft `pass`, and a gate with a `blocked` verdict is not closed.
3. **The journey is recorded, not summarized away.** A verdict without a journey is an
   assertion. Write what was clicked, typed, waited for and observed.
4. **Timings go in `observations`.** "The toast did not auto-dismiss; observed for 90 seconds"
   is evidence. "Seemed fine" is not.
5. **The platform is recorded on every gate.** A gate that cannot be completed on the authoring
   machine is recorded as outstanding, naming the platform required.
6. **A subjective judgement never stands alone.** It must rest on captured evidence - a
   transcript, a screenshot path, a recorded output, or a probe report.
7. **Outstanding is a first-class field, not an omission.** A gate performed on one platform
   with two platforms in scope states the other two as outstanding.

## Validation of a completed file

Check these; do not fill any of them in.

```bash
jq -e '.verdicts | length > 0' docs/reviews/<gate>.json
jq -r '.verdicts[] | select(.outcome | test("pass|fail|blocked") | not)' docs/reviews/<gate>.json
jq -r '.verdicts[] | select(.evidence == null or .evidence == "")' docs/reviews/<gate>.json
jq -r '.reviewer, .platform, .performedAt' docs/reviews/<gate>.json
```

Then confirm by reading:

- Every acceptance criterion in the owning feature document has exactly one verdict.
- No criterion is missing, and no extra criterion was invented.
- No verdict is authored or edited by an agent. If the file's mtime coincides with an agent
  session that produced no human interaction, treat the verdict as unverified and ask.
- A gate with any `fail` or `blocked` verdict is not reported as complete.

## Reconcile or create

If a review file exists, update it in place and keep prior observations; do not overwrite a
human's record with a regenerated one. If the acceptance criteria changed, keep the old
criteria and their verdicts alongside the new ones rather than remapping verdicts across a
changed criterion.
