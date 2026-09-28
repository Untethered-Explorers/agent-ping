# Runbook: GitHub Copilot CLI support in v1 — the deferral

> **The answer, in one line: v1 ships opencode only. Copilot CLI is not supported, there is no
> adapter, there is no heuristic, and there is nothing to install to make it work.**

This file is the deferral record CP-4 is required to produce, because the human gate in
[docs/reviews/CP-3-console-review.md](../reviews/CP-3-console-review.md) recorded **deferral**
rather than an authorised adapter. It is written so that a developer who works in Copilot finds
out here, rather than by waiting for a card that will never arrive, and so that whoever revisits
the decision inherits the evidence instead of guessing at it.

It keeps the property the other runbook in this directory has: **it says what was observed and
what was not.**

---

## 0. The verification state, stated plainly

| Claim | State | Where it is proven |
| --- | --- | --- |
| A Copilot adapter ships in v1 | **NO — deferred by a recorded human gate** | `docs/reviews/CP-3-console-review.md` §"Decision: **deferral**" |
| A heuristic `needs-you` signal ships for Copilot | **NO — no heuristic was authorised either** | same, §"Decision": *"No Copilot adapter is authorised, and no heuristic is authorised either"* |
| The ACP permission signal exists on Copilot CLI 1.0.88 | **`observed`** | `docs/research/copilot-acp-probe.md` §5: `session/request_permission`, 1 request, options `[["allow_once","allow_always","reject_once"]]` |
| A dedicated idle signal exists on the ACP wire | **not observed; the turn boundary is a response, not a notification** | probe report §4 |
| The per-turn `finished` signal is available to an *attaching* adapter | **unresolved** — not captured | gate review §Claim 1 |
| The work-detection the quietness gate depends on works on this harness | **never exercised** | probe report §10: six documented events never fired |
| A user-level Copilot hook file loads in ACP mode | **`observed` at 1.0.88, one machine, one run** | probe report §8 |
| The opencode adapter is unaffected by this decision | **unchanged; no `src/` file was edited by CP-4** | `tests/plugin/copilot-translate.test.ts` |
| Whether a Copilot block would be *reported* if a block cannot be detected | **not applicable in v1 — there is no adapter, so there is nothing to report; see §6** | this file, §6 |

## 1. The decision, and the evidence it is bound to

| Field | Value |
| --- | --- |
| Decision | **deferral** — v1 ships opencode only |
| Reviewer | Doug McCusker |
| Reviewed at | 2026-09-27T16:55:00.000Z |
| Machine-readable record | `docs/reviews/copilot-gate.json` (`"decision": "approved"` — that is the *gate task* being approved; the authorised outcome is the **deferral** recorded in the review file it names) |
| Console review | `docs/reviews/CP-3-console-review.md` |
| Evidence read | `docs/research/copilot-acp-probe.md` |

The gate binds its decision to two files by SHA-256, and both digests still matched the files on
disk when this record was written (checked with `sha256sum`):

| Evidence file | SHA-256 named by the gate | Matched at CP-4 |
| --- | --- | --- |
| `docs/reviews/CP-3-console-review.md` | `fe5a96f7…99e620` | yes |
| `docs/research/copilot-acp-probe.md` | `eb9007e1…ce22e6b2` | yes |

**The decision was made against the captured report, not against documentation.** The documented
hook-trigger list in the probe report is labelled documented; the claims the gate rests on are the
observed ones. `tests/plugin/copilot-translate.test.ts` re-checks both digests, so regenerating the
probe report without re-binding the decision fails a test rather than passing quietly.

## 2. What a Copilot developer actually gets in v1: nothing

Stated without softening, because this is the whole cost of the decision:

- **No card.** No `needs-you` card, no `finished` card, no `fyi`.
- **No history row.** A block in a Copilot session is not merely un-notified — it is **un-recorded**.
  Nothing enters the content-free durable log, so there is no row to find later either.
- **No badge, no tray count, no deep link.** The pending set is built from stored events, and
  nothing is stored.
- **No entry in the dashboard at all.** It cannot show what it never received.

So: if you work in Copilot CLI, agent-ping will be silent about your sessions for the whole of v1,
and the silence is not a malfunction. It is the recorded decision. If you need agent-ping to work,
run your sessions in opencode, which is fully supported.

The dashboard's success metrics read zero for a Copilot user, and that is a real cost, not a bug
to be filed.

## 3. Which signals were missing, and what state each one carries

Reproduced from the gate review so this file stands alone. `observed` means the probe captured a
real invocation or notification; `not-triggered` means the surface ran and the signal stayed
silent; `unclear` means the probe has no usable evidence either way. **`absent` never appears,
because a black-box probe cannot prove a capability does not exist** (probe report §9).

| Class | Candidate signal on Copilot CLI 1.0.88 | State | Usable? |
| --- | --- | --- | --- |
| `needs-you` | ACP `session/request_permission` | `observed` (§5) | **The signal is real.** Not usable by an attaching adapter, because the only client position that sees it is one issuing the prompts — and agent-ping is a sidecar that must never own the developer's session (ADR-001, APX-CON-03). |
| `finished` | `stopReason` on the `session/prompt` response | observed in the capture, **as a response not a notification** (§4) | **No.** Whether an attaching client observes the prompt responses for prompts *a human* issued is not captured, and it is the whole question for this class. |
| `finished` (alternative) | `agentStop` hook, `stopReason: ["end_turn"]` | `observed` (§4) | **No.** A hook is one command process per invocation with the payload on stdin; nothing in the capture shows a long-lived process handed events, so it is not a push path. |
| `finished` (documented) | `notification` / `agent_idle` | **`unclear`** (§4, §10) | **No.** It is documented as a *background* agent waiting on `write_agent`; the driven session started no subagent. The probe's own rule (§9) forbids a mapping built on `unclear`. |
| `fyi` (error, retry, long tool, compaction) | `errorOccurred`, `preCompact`, `postToolUseFailure` | **never fired** — the state the probe recorded for each of the three is `not-triggered`, not `unclear` (§2, §10) | **No.** Nothing was captured. |
| idle-after-nothing suppression | work detection across all of the above | **never exercised** — every signal it depends on is `not-triggered` above, and the rule itself was never run on this harness (§10) | **No.** This is the quietness gate. |

### The load-bearing reason is the last row

`needs-you` has a proven signal. The reason this is a deferral is that the **noise gate was never
exercised on this harness** — the rule that stops a greeting-and-close from producing a card. That
reason would still hold even if the permission signal were perfect, and a wrong `needs-you` is the
one signal a user cannot afford to get wrong.

## 4. Why this is a deferral and not a rejection of the harness

Three things were genuinely favourable, and a future reader should not lose them:

1. **The ACP permission signal is real and strong.** It is an agent-to-client *request* carrying a
   decision: the client must answer it or the tool does not run. That is a better signal than the
   `permissionRequest` hook, which merely runs a command before the permission service.
2. **A user-level hook file loads in ACP mode.** §8 measured it: 8 invocations at user level in
   both modes, against 0 for a repository-level hook in ACP mode in the same workspace. That suits
   agent-ping's single global install (ADR-006) and argues against anything per-repository.
3. **The harness is a candidate, not a dead end.** It is one capture behind, and the gate names
   exactly what would close the gap (§7).

A favourable architecture finding is a reason to revisit, not a reason to ship an adapter whose
`finished` and noise paths are unproven.

## 5. What the code does about this today

The deferral is not only a document. It is already enforced in the classifier, by the domain
owner, and it was enforced *before* this decision existed:

- **`src/domain/classify.ts` carries two `unresolved` rows for `copilot-cli`:**
  `session/request_permission` and `session/update`. Each one **throws** a `ClassificationError`
  with code `unresolved-signal` and a `blockedBy` sentence naming the missing gate, instead of
  classifying. The row is there "so that an adapter reporting it fails with a named gate instead of
  a silent drop".
- **The six documented-hook rows classify to `fyi` or to nothing at all.** No `copilot-cli` row
  maps to `needs-you` or to `finished`.
- **`copilot-cli` is in `KNOWN_HARNESSES`**, so the hub accepts the name without inventing a
  session. A harness whose adapter is deferred is still a harness whose signals must not be
  invented.
- **There is no adapter to produce those envelopes.** `src/plugin/copilot/` does not exist — not
  `translate.ts`, not `index.ts`, nothing. Nothing pushes a Copilot signal, so nothing classifies
  one. The absence is the decision, not an oversight: an unauthorised adapter would be worse than a
  missing one, because it would make a deferred harness look supported.
- **No harness-specific branch exists.** The string `copilot-cli` appears in exactly two files
  under `src/`: `src/domain/classify.ts` and `src/domain/envelope.ts`. It appears nowhere in the
  hub, the notification surface, the tray, storage, the dashboard, or the plugin tree — so no
  Copilot path can bypass classification, pending or delivery (CP-FR-06).
- **The stored row cannot be a Copilot row as opposed to an opencode one.** The `events` table has
  no `harness` column: a stored record carries the class, the subtype, the raw event name, the
  timestamps, the dedupe key and the acknowledgement state, and the harness is reached from the
  session row instead. So the two fyi rows above land through the hub's own
  `createPendingLifecycle(store).record(signal)` — the one call `src/hub/ingest-service.ts` makes —
  as rows that differ only in their raw event name and their namespaced dedupe key, and a repeated
  delivery of either collapses to `already-known` on that same path. There is nothing in the
  stored data for a harness-specific rule to have keyed off.

CP-4 changed **no** file under `src/`.

### Why a test named `copilot-translate` guards a translate module that does not exist

A reader who runs the suite named above will look for `src/plugin/copilot/translate.ts` and not find
it, so this says it plainly rather than leaving it to be inferred:

- That file is what a Copilot adapter's mapping table would be, and `tests/plugin/copilot-translate.test.ts`
  is the table-driven test that would enumerate it. The file is named for the deliverable, and the
  deliverable is **withheld**.
- So the suite asserts the mapping is **empty and stays empty** until a new recorded gate decision
  fills it: that `src/plugin/copilot/` is absent, that no `copilot-cli` row reaches `needs-you` or
  `finished`, that the two ACP signals raise a named error instead of classifying, and that the
  evidence digests the gate bound itself to still match — so the probe report cannot be regenerated
  under a stale decision.
- The withheld mapping itself is §3 above, which CP-FR-04 requires to be stated either way. A
  future gate authorises those rows, or different ones; either way this file and the suite change
  together.

## 6. The missing-signal path, and why there is nothing to degrade

The gate recorded an obligation for whoever builds a future adapter, and quoted it deliberately:

> *"a Copilot session that is open and producing no permission request and no turn boundary would
> be surfaced as a distinct condition in `doctor` and in the runbook, because a block the product
> cannot see is indistinguishable from a session with nothing to report."*

In v1 the honest answer is that **the degradation is this file**. There is no adapter, so no
breadcrumb is written and no envelope is dropped — but the consequence is that agent-ping cannot
tell the difference between "a Copilot session is open and blocked" and "no Copilot session
exists", and it resolves that ambiguity by reporting nothing at all.

Two honest qualifications:

- **`doctor` exists and still does not report this gap.** `src/cli/` is in the tree
  (IO-1 through IO-3 have run; `agent-ping doctor` prints seven checks), so the
  `doctor` half of the gate's obligation is **inherited, not satisfied** — the check
  that would notice an unsupported harness is not one of the seven. This runbook is
  the only place the gap is stated in the product's own documentation today. Nothing
  here claims `doctor` reports Copilot.
- **The gap is not discoverable from the dashboard.** It is discoverable by reading this file. A
  future authorised adapter inherits the obligation to make it visible in the product's own
  interface, not only in documentation.

## 7. What would have to change to revisit this

From the gate review, and required in addition by CP-FR-04 — a new **recorded gate decision**,
not a code change:

1. **A capture recording a per-turn boundary an attaching client actually receives**, for a session
   a human is driving, so the `finished` class has a shape that does not depend on the adapter
   issuing the prompts. Without that, an adapter would be driving the developer's session, which
   ADR-001 rules out.
2. **A capture that exercises the work-detection signals** — a session that runs a tool, then
   errors, then compacts — so idle-after-nothing suppression and the `fyi` class map to something
   observed rather than to something that merely stayed quiet.
3. **A subagent run**, so the `notification` / `agent_idle` type moves off `unclear` and becomes
   either `observed` or `not-triggered`. A mapping on `not-triggered` is permitted with a stated
   degradation; a mapping on `unclear` is not.
4. **A re-probe of the hook-loading matrix**, because it is one version on one machine and it is the
   load-bearing architectural fact if a hook-based signal is ever used.

If a later gate authorises an adapter, the work is additive by construction: translate the named
signals into the same normalized envelope, reuse `deriveDedupeKey` and `repoShortNameFromPath`
rather than deriving either again, and deliver through the existing transport so classification,
pending and delivery stay in one place (APX-CON-13). The classifier's `unresolved` rows are the
switch to flip, and they are the domain owner's to change.

## 8. Version binding — re-probe, do not inherit

Every finding here is bound to **GitHub Copilot CLI 1.0.88**, on one machine, on **2026-09-27**,
across two probe runs. The PRD's reference to 1.0.83 is out of date: the permission question was
recorded as unresolved upstream at 1.0.83 and is `observed` at 1.0.88.

- A future Copilot release may add a dedicated idle notification, change the hook payloads, or
  change which hook locations load. The §8 matrix in particular is one run on one machine.
- Re-run `scripts/probe-copilot-acp.mjs` and `scripts/probe-copilot-hooks.mjs` and compare the
  captures before inheriting any claim on this page.
- The probes fail loudly (non-zero exit) when the binary is missing or the handshake does not
  complete, so **a re-probe cannot silently produce an empty report** and a stale claim on this page
  fails a test rather than passing quietly.

## 9. What this runbook does not claim

- It does not claim Copilot CLI **cannot** support agent-ping. It claims v1 does not, and §7 says what would change that.
- It does not claim anything about Copilot CLI versions other than 1.0.88.
- It does not claim anything about the **payloads** of the six documented events that never fired. Their payloads are unobserved, not empty.
- It does not claim a repository-level Copilot hook is never loaded in ACP mode. The capture shows 0 invocations in one run, and the report declines to choose between "ACP mode ignores that location" and "something specific to this run prevented it".
- It does not claim `doctor`, the tray or the dashboard report this gap today. `doctor` exists and does not report it — the seven checks know nothing about Copilot — and the tray and dashboard show only what the store holds.
- It does not claim the `notification` hook cannot carry an idle signal. Its state is `unclear`, which is not the same as absent.
- It contains no claim about a live Copilot session's content, because no conversation content reaches this product or this file (APX-FR-01).

## 10. Provenance

| Artefact | Produced by | Role here |
| --- | --- | --- |
| `docs/research/copilot-acp-capture.json` | `scripts/probe-copilot-acp.mjs` (CP-1) | the ACP wire, verbatim in structure |
| `docs/research/copilot-hooks-capture.json` | `scripts/probe-copilot-hooks.mjs` (CP-2) | the hook payloads, verbatim in structure |
| `docs/research/copilot-acp-probe.md` | CP-2 | the consolidated report, cited above by section |
| `docs/reviews/CP-3-console-review.md` | the human gate (CP-3) | the decision and the residual risk |
| `docs/runbooks/copilot-support.md` | CP-4 | this deferral record |
| `tests/plugin/copilot-translate.test.ts` | CP-4 | asserts the deferral holds: no adapter code, no mapping, the missing-signal path fails loudly, the evidence digests still match |

The decision belongs to the human gate and is not this file's to reinterpret. If a later gate
changes it, this file changes with it, and the test named above is what notices.
