# Human Review: Decide whether a Copilot adapter is authorised

Reviewer: Doug McCusker
Reviewed at: 2026-09-27T16:55:00.000Z
Task: CP-3
Evidence read: `docs/research/copilot-acp-probe.md`, built by CP-1 (`probe-copilot-acp`) and
CP-2 (`probe-copilot-hooks`) from two machine-written captures of **Copilot CLI 1.0.88** run on
this machine on 2026-09-27. The underlying capture files are
`docs/research/copilot-acp-capture.json` and `docs/research/copilot-hooks-capture.json`, both
named in the report, so any claim below can be re-checked against a capture rather than taken
on trust.

**This decision was made against the captured report, not against documentation.** The
documented trigger list is in the report as §2 and is explicitly labelled documented rather
than observed; the claims below cite §3 to §10, which are the observed sections.

---

## Decision: **deferral**

**v1 ships opencode only. No Copilot adapter is authorised, and no heuristic is authorised
either.** This is the PRD's own stated default for Open Question 12 — *"v1 ships opencode only
unless the spike proves the signals exist"* — and the spike did not prove them in the shape this
product needs.

One signal was genuinely proven and is worth recording as such, because it is the reason this
is a deferral rather than a rejection of the harness:

> **The ACP permission signal is `observed`.** §5 records
> `session/request_permission` with 1 request and options
> `[["allow_once","allow_always","reject_once"]]`, captured over ACP on stdio. The report is
> explicit that this is an agent-to-client *request* the client must answer, and that it is
> stronger than the `permissionRequest` hook, which merely runs a command before the
> permission service.

So the `needs-you` class has a real ACP signal. The deferral is not because Copilot cannot
report a block.

---

## Why deferral, claim by claim, against captured evidence

### Claim 1: the `finished` class has no signal an attaching adapter can rely on

§4 records the ACP idle-equivalent as `not-triggered`: *"no notification method or
`sessionUpdate` variant the CLI emitted matched an idle marker"*, and the report notes the
search is re-checkable because the emitted set is in the capture. The turn boundary is instead
`stopReason` on the **response to `session/prompt`** — a response to a request, not a
notification.

The consequence the probe does not resolve: agent-ping would be **attaching** to a session the
developer is driving, not issuing its prompts. Whether an attaching client observes the prompt
responses for prompts a human issued is not something this capture answers, and it is the whole
question for the `finished` class. §6 makes the related point about `sessionEnd.reason`: it
arrives once, at the end, and says nothing about the turn that just completed, so it is not a
substitute.

### Claim 2: the documented idle hook type is `unclear`, and §9 forbids mapping on it

§4 records the `notification` hook's `agent_idle` type as `unclear`, not `absent`, because it is
documented as a **background** agent waiting on `write_agent` and the driven session started no
subagent. §9 defines the ladder and is explicit about the consequence:

> *"A gate reading this report should refuse any mapping built on an `unclear` state."*

The only per-turn signal actually observed is the `agentStop` **hook** (`stopReason:
["end_turn"]`, 1 invocation) — a hook, not an ACP notification, and §1 records that hooks are
one command process per invocation with the payload on stdin, with nothing in the capture
showing a long-lived process handed events.

### Claim 3: the quietness gate is the least-proven part, and it is the part that matters most

§10 records that `errorOccurred`, `notification`, `postToolUseFailure`, `preCompact`,
`subagentStart` and `subagentStop` **all never fired**, each because the driven session caused
none of them. So the work-detection that agent-ping's `fyi`/idle-after-nothing suppression
depends on — the rule that stops a greeting-and-close from producing a card, and the one
ADR-004 names as the cost of the loudness policy — was not exercised on this harness at all.

Deferring on a weak block signal alone would be defensible. Deferring because the **noise
gate** is unproven is the stronger reason, and it is the reason that would still apply if the
permission signal were perfect.

### Claim 4: the one architectural finding is favourable, and is not a reason to build now

§8's measured matrix: a **user-level** hook file fired 8 times in ACP mode as well as 8 times
in `copilot -p`, while a **repository-level** hook fired 8 times in `copilot -p` and **0
times** in ACP mode in the same workspace. That suits agent-ping's single global install
(ADR-006) and argues against anything per-repository. The report declines to choose between
"ACP mode ignores repository hooks" and "something about this workspace prevented it", and
records only the narrower claim: no repository-level payload was observed in ACP mode in this
run.

A favourable architecture finding is a reason to revisit, not a reason to ship an adapter whose
`finished` and noise paths are unproven.

---

## Which signal would map to which class, had an adapter been authorised

Recorded because CP-FR-04 requires the mapping to be stated either way, and because a later
reader must be able to see exactly which claim was withheld.

| Class | Candidate signal on Copilot CLI 1.0.88 | State | Would have been usable? |
|---|---|---|---|
| `needs-you` | ACP `session/request_permission` | `observed` (§5) | **Yes.** An agent-to-client request carrying a decision; the client must answer or the tool does not run |
| `finished` | `stopReason` on the `session/prompt` response | `observed` in the capture, but as a response not a notification (§4) | **Unresolved.** Whether an attaching client sees responses to prompts a human issued is not captured |
| `finished` (alternative) | `agentStop` hook with `stopReason: ["end_turn"]` | `observed` (§4) | Only via the hook surface, one process per invocation, with no long-lived process evidenced (§1) |
| `finished` (documented) | `notification` / `agent_idle` | **`unclear`** (§4, §10) | **No.** §9 forbids a mapping built on `unclear` |
| `fyi` (error, retry, long tool, compaction) | `errorOccurred`, `preCompact`, `postToolUseFailure` | **never fired** (§10) | **No.** Nothing captured |
| idle-after-nothing suppression | work detection across all of the above | **never exercised** (§10) | **No.** This is the quietness gate |

**What would have been reported when the expected signal did not arrive.** Had an adapter been
authorised, the degradation would have had to be an explicit reported state and not a silent
absence: a Copilot session that is open and producing no permission request and no turn boundary
would be surfaced as a distinct condition in `doctor` and in the runbook, because a block the
product cannot see is indistinguishable from a session with nothing to report. That obligation
is recorded here so a future adapter inherits it rather than reinventing it — and it is part of
why the deferral is not simply "the harness is quiet until proven otherwise".

---

## Residual risk of choosing deferral, including what a user misses

- **A developer who works in Copilot gets nothing from agent-ping at all in v1.** Their blocked
  sessions are invisible to this product. This is the whole cost, and it is a real one.
- **A block in a Copilot session is not merely un-notified, it is un-recorded.** Nothing enters
  the content-free log, so there is no history row and no `fyi` entry either. The dashboard
  cannot show what it never received.
- **Multi-harness coverage is one harness.** The PRD's success metrics are about sessions being
  caught; for a Copilot user that metric reads zero.
- **The risk of *not* deferring is larger and is the reason for the choice.** Authorising a
  `finished` class driven by prompt responses the adapter may not see, with an unexercised
  noise gate, produces exactly the failure this product exists to avoid: a card for a greeting,
  or silence for a real block, on a harness where neither can be checked. A wrong `needs-you`
  signal is the class the user cannot afford to get wrong.
- **The favourable §8 finding may age badly.** It is a single version on a single machine. A
  future reader should re-probe rather than inherit it, and the deferral record CP-4 produces
  should say so.

---

## What would have to change to revisit this

1. A capture that records a **per-turn boundary an attaching client actually receives** for a
   session a human is driving, so the `finished` class has a shape that does not depend on the
   adapter issuing the prompts. Without that, an adapter would be driving the developer's
   session, which ADR-001 rules out.
2. A capture that **exercises** the work-detection signals — a session that runs a tool, then
   errors, then compacts — so the idle-after-nothing suppression and the `fyi` class can be
   mapped to something observed rather than to something that merely stayed quiet.
3. A subagent run, so the `notification` / `agent_idle` type moves off `unclear` and becomes
   either `observed` or `not-triggered`. §9 permits a mapping on the latter with a stated
   degradation; it forbids one on the former state it is in now.
4. A re-probe of the §8 hook-loading matrix, since it is one version on one machine and is the
   load-bearing architectural fact if a hook-based signal is ever used.

**v1 ships opencode only.**

## What this task did not do

No code was changed. No adapter was written, and none is authorised. The probe report is
untouched: this decision reads it and adds nothing to it, so the evidence a later reader
re-checks is exactly the evidence this decision was made from.
