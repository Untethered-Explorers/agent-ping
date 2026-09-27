# Feature: Copilot CLI ACP Spike

## Traceability

| Canonical ID | Owner / Source Link | Relationship |
|--------------|---------------------|--------------|
| APX-CON-09 | [Vision](../PRD.md#17. Traceability Matrix) | participates |
| APX-CON-13 | [Vision](../PRD.md#17. Traceability Matrix) | participates |
| CP-FR-01 | This feature | owns |
| CP-FR-02 | This feature | owns |
| CP-FR-03 | This feature | owns |
| CP-FR-04 | This feature | owns |
| CP-FR-05 | This feature | owns |
| CP-FR-06 | This feature | owns |

**PRD:** [docs/PRD.md](../PRD.md)

---

## 1. Feature Overview

**Feature Name:** Copilot CLI ACP Spike
**ID Prefix:** CP
**Summary:** A short, honest investigation of whether GitHub Copilot CLI can report the two signals agent-ping depends on, a recorded gate decision, and then either a second adapter or an explicit deferral, so that the uncertain part of the product is settled by evidence rather than by hope.
**Dependencies:** Hub Core and Delivery Policy
**Priority:** Should

---

## 2. User Stories

| ID | As a... | I want to... | So that... | Priority |
|----|---------|-------------|-----------|----------|
| CP-US-01 | implementer | know whether Copilot can report idle and permission signals | so that I do not build an adapter on a guess | Should |
| CP-US-02 | developer | have the same three-class behaviour on both harnesses I use | so that switching harnesses does not change what notifies me | Should |
| CP-US-03 | implementer | have a recorded decision when the answer is no | so that deferral is a decision rather than an omission | Should |

---

## 3. Functional Requirements

```forge-requirement
{"id":"CP-FR-01","kind":"requirement","text":"A probe launches the real Copilot CLI in ACP mode, performs the initialize handshake, subscribes to notifications and records the negotiated protocol version, the agent capabilities, the authentication methods and every notification type actually observed."}
```

```forge-requirement
{"id":"CP-FR-02","kind":"requirement","text":"A second probe enumerates the documented Copilot CLI hook triggers and captures their real payloads, and records explicitly whether any idle or permission equivalent exists and what a session-end reason can express."}
```

```forge-requirement
{"id":"CP-FR-03","kind":"requirement","text":"Both probes write one report artifact containing the verbatim captured evidence, timestamps and the exact CLI version, so a later reader can re-check the conclusion rather than trust it."}
```

```forge-requirement
{"id":"CP-FR-04","kind":"requirement","text":"A recorded gate decision states whether a Copilot adapter is authorised, and if so exactly which signals map to which classes and how a missed signal is reported; if not, it states that v1 ships opencode only."}
```

```forge-requirement
{"id":"CP-FR-05","kind":"requirement","text":"If authorised, the adapter maps ACP notifications and hooks onto the same normalized envelope as the opencode adapter, deduplicates against polled state, and degrades to the documented heuristic rather than failing silently."}
```

```forge-requirement
{"id":"CP-FR-06","kind":"requirement","text":"No harness-specific path may bypass the hub's classification, pending and delivery rules; a Copilot event is stored and classified exactly like an opencode event."}
```

**Priority:** every requirement in this feature is Should, because this feature is the evidence-gated part of v1 and a deferral is a legitimate outcome.

---

## 4. UI / Interaction Design

None. The only outputs are a report artifact and a decision record, plus, if authorised, an adapter that produces no interface of its own.

---

## 5. Implementation Tasks

Task review table, kept outside the phase contracts as authoring evidence.

| ID | Observable outcome | Owner | Prerequisite interface | Output and test files | Acceptance to check | Exclusions |
|----|--------------------|-------|------------------------|-----------------------|--------------------|------------|
| CP-1 | The real ACP surface is captured verbatim | connector-engineer | DP-1 scripts, Copilot CLI on PATH | scripts/probe-copilot-acp.mjs, tests/scripts/probe-copilot-acp.test.ts | probe logic test plus a real run | No adapter code |
| CP-2 | The hook surface is captured and written into one report | connector-engineer | CP-1 | scripts/probe-copilot-hooks.mjs, docs/research/copilot-acp-probe.md | report completeness test | No adapter code |
| CP-3 | A human records the go, no-go or heuristic decision | human reviewer | CP-1, CP-2 | docs/reviews/copilot-gate.json | recorded decision with evidence cited | No code changes |
| CP-4 | The authorised adapter or the deferral record exists | connector-engineer | CP-3 | src/plugin/copilot/index.ts, src/plugin/copilot/translate.ts, tests/plugin/copilot-translate.test.ts, docs/runbooks/copilot-support.md | translation tests, or a recorded deferral | No change to hub rules |

### Phase 1: Probes

```forge-task
{
  "id": "CP-1",
  "title": "Probe the real Copilot ACP surface",
  "description": "Write a probe that exercises the real Copilot CLI rather than a stub. Launch it in ACP mode over standard input and output, perform the initialize handshake, record the negotiated protocol version, the advertised agent capabilities and the authentication methods, subscribe to notifications, drive one short session that asks for a tool, and record every notification type and field actually observed, verbatim. Probe the permission path specifically and record whether a permission request is emitted at all, since that is the open question the whole feature exists to answer. Record the exact CLI version and the timestamps. Write the captured evidence to the report artifact and fail loudly, with a non-zero exit, when the binary is missing or the handshake does not complete, so absence of evidence is never reported as a negative finding. Cover the probe's own parsing and recording logic with a test over a captured transcript. Exclude any adapter code.",
  "ownerAgent": "connector-engineer",
  "dependencies": ["DP-1"],
  "expectedOutputs": ["scripts/probe-copilot-acp.mjs", "tests/scripts/probe-copilot-acp.test.ts"],
  "validationCommands": ["npm test -- tests/scripts/probe-copilot-acp.test.ts", "npm run typecheck"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/copilot-cli-acp-spike.md#CP-FR-01", "docs/features/copilot-cli-acp-spike.md#CP-FR-03"],
    "acceptanceCriteria": [
      "A test asserts the probe records the negotiated protocol version, capabilities and auth methods from a captured transcript",
      "A test asserts a missing binary or a failed handshake exits non-zero rather than writing an empty report",
      "A test asserts permission-related notifications are recorded distinctly from ordinary session updates",
      "The probe writes the exact CLI version and timestamps into the report artifact"
    ],
    "constraints": ["Never fabricate external API contracts", "Never invent passing results, tool availability, deployed resources, human review or compliance"],
    "constraintRefs": ["docs/PRD.md#APX-CON-13"],
    "references": ["docs/PRD.md#5. Research Findings", "docs/features/copilot-cli-acp-spike.md#6. Testing Strategy", "docs/PRD.md#16. Open Questions"]
  }
}
```

```forge-task
{
  "id": "CP-2",
  "title": "Probe the Copilot hook surface and write the report",
  "description": "Write the second probe covering the hook surface, and consolidate both probes into one report artifact. Enumerate the documented Copilot CLI hook triggers, run a real session with each relevant hook enabled, capture their real payloads, and record explicitly whether any idle or permission equivalent exists and what values a session-end reason can take. Write a single report under the research directory containing the verbatim captured evidence from both probes, the timestamps and the exact CLI version, with an explicit statement of what was not observed. Make the report honest about the difference between a signal that is absent, a signal that was not triggered during the probe, and a signal whose meaning is unclear. Add a test asserting the report contains the required sections and that a missing capture is reported as not observed rather than omitted. Exclude any adapter code and any decision.",
  "ownerAgent": "connector-engineer",
  "dependencies": ["CP-1"],
  "expectedOutputs": ["scripts/probe-copilot-hooks.mjs", "docs/research/copilot-acp-probe.md"],
  "validationCommands": ["npm run typecheck"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/copilot-cli-acp-spike.md#CP-FR-02", "docs/features/copilot-cli-acp-spike.md#CP-FR-03"],
    "acceptanceCriteria": [
      "The report states the documented hook triggers, the captured payloads, and explicitly whether an idle or permission equivalent exists",
      "The report distinguishes a signal that is absent from one that was not triggered and from one whose meaning is unclear",
      "The report records the exact CLI version and the timestamps of both probe runs"
    ],
    "constraints": ["Never fabricate external API contracts"],
    "constraintRefs": ["docs/PRD.md#APX-CON-13"],
    "references": ["docs/PRD.md#5. Research Findings", "docs/features/copilot-cli-acp-spike.md#3. Functional Requirements", "docs/PRD.md#16. Open Questions"]
  }
}
```

### Phase 2: Gate decision and authorised outcome

```forge-task
{
  "id": "CP-3",
  "title": "Decide whether a Copilot adapter is authorised",
  "description": "Human gate on the spike evidence. Read the probe report at docs/research/copilot-acp-probe.md and decide one of three outcomes, citing the specific captured evidence for each claim: authorise a full adapter, authorise a documented heuristic for the needs-you class only, or defer Copilot to a later version. State exactly which observed signal maps to which class, what happens when the expected signal does not arrive, and how a missed block would be reported rather than hidden. If the decision is deferral, state plainly that v1 ships opencode only and what would have to change to revisit it. Record the decision, the evidence and the residual risk in the review file, and do not change code in this task.",
  "dependencies": ["CP-1", "CP-2"],
  "expectedOutputs": [],
  "validationCommands": [],
  "contract": {
    "version": 2,
    "kind": "human-review",
    "requirements": [],
    "requirementRefs": ["docs/features/copilot-cli-acp-spike.md#CP-FR-04", "docs/features/copilot-cli-acp-spike.md#CP-FR-03"],
    "acceptanceCriteria": [
      "The reviewer recorded exactly one of full adapter, heuristic-only or deferral, citing captured evidence for each claim",
      "The reviewer stated which signal maps to which class and what is reported when the expected signal does not arrive",
      "The reviewer recorded the residual risk of the chosen option, including what a user would miss",
      "The reviewer confirmed the decision was made against the captured report and not against documentation alone"
    ],
    "constraints": ["A subjective judgement never stands alone; it must rest on the captured evidence in the report"],
    "constraintRefs": ["docs/PRD.md#APX-CON-13"],
    "reviewFile": "docs/reviews/copilot-gate.json",
    "references": ["docs/features/copilot-cli-acp-spike.md#3. Functional Requirements", "docs/PRD.md#16. Open Questions"]
  }
}
```

```forge-task
{
  "id": "CP-4",
  "title": "Build the authorised Copilot adapter or record the deferral",
  "description": "Implement exactly what the gate decision authorised, and nothing more. Read the decision recorded in docs/reviews/copilot-gate.json and the evidence in docs/research/copilot-acp-probe.md before writing any code. If the decision was full adapter or heuristic-only, translate the ACP notifications and hook payloads named in the decision into the same normalized envelope the opencode adapter produces, using the same dedupe keys, and deliver it to the hub through the existing transport so classification, pending state and delivery stay in one place. Implement the documented degradation for a signal that does not arrive, so a Copilot block that cannot be detected is reported rather than silently absent, and cover it with a test that exercises the missing-signal path. If the decision was deferral, produce the deferral record instead: a runbook stating that Copilot is not supported in v1, which signals were missing, and what would have to change, with no adapter code. Exclude any change to the hub's rules, the notification surface or the dashboard.",
  "ownerAgent": "connector-engineer",
  "dependencies": ["CP-3"],
  "expectedOutputs": ["src/plugin/copilot/index.ts", "src/plugin/copilot/translate.ts", "tests/plugin/copilot-translate.test.ts", "docs/runbooks/copilot-support.md"],
  "validationCommands": ["npm test -- tests/plugin/copilot-translate.test.ts", "npm run typecheck"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/copilot-cli-acp-spike.md#CP-FR-05", "docs/features/copilot-cli-acp-spike.md#CP-FR-06"],
    "acceptanceCriteria": [
      "A table-driven test asserts each signal named in the gate decision maps to the class the decision assigned, and no other mapping exists",
      "A test asserts the missing-signal path produces the documented degradation rather than silence",
      "A test asserts a Copilot envelope is stored and classified by the same hub path as an opencode envelope, with no harness-specific branch",
      "The runbook states the supported Copilot surface, or states the deferral with the missing signals and what would change it"
    ],
    "constraints": ["No harness-specific path may bypass the hub's classification, pending and delivery rules", "Identity is the repository short name"],
    "constraintRefs": ["docs/PRD.md#APX-CON-13", "docs/PRD.md#APX-CON-09"],
    "references": ["docs/features/copilot-cli-acp-spike.md#3. Functional Requirements", "docs/features/copilot-cli-acp-spike.md#8. Open Questions"]
  }
}
```

---

## 6. Testing Strategy

| Level | Scope | Approach |
|-------|-------|----------|
| Unit | Probe parsing and recording | A captured transcript fed to the probe's own logic |
| Live | ACP handshake, notifications, hooks | The real Copilot CLI binary on the authoring machine |
| Integration | Envelope translation | Table-driven mapping decided by the gate, with a missing-signal case |
| Manual | Whether the answer is good enough | Human gate citing captured evidence rather than documentation |

Key test scenarios:

1. The probe records protocol version, capabilities and auth methods from a real handshake.
2. A missing binary or failed handshake exits non-zero instead of writing an empty report.
3. The report distinguishes absent, untriggered and unclear signals.
4. The missing-signal path produces the documented degradation rather than silence.
5. A deferral decision produces a runbook and no adapter code.

---

## 7. Acceptance Criteria

1. Both probes run against the real binary and their verbatim evidence is in one report with the CLI version and timestamps.
2. The report explicitly answers whether an idle and a permission signal exist for Copilot.
3. A recorded gate decision exists that cites evidence and states the residual risk.
4. The authorised outcome exists as either a tested adapter with a documented degradation path or a deferral record.
5. No Copilot-specific path alters the hub's classification, pending or delivery rules.

---

## 8. Open Questions

**All four are answered by the captured probe, and the answers decided the feature.** The
gate recorded **deferral**: v1 ships opencode only. The decision and its evidence are
[docs/reviews/CP-3-console-review.md](../reviews/CP-3-console-review.md); CP-4 turns it into
the deferral record a user reads. The answers, with the state each signal carries in the
probe's own vocabulary, are:

| # | Question | Answered by the capture | State |
|---|----------|-------------------------|-------|
| 1 | Does ACP mode emit a permission request from Copilot CLI? | Yes. `session/request_permission`, an agent-to-client request carrying `[["allow_once","allow_always","reject_once"]]` | `observed` |
| 2 | Can a session-end reason stand in for idle? | No. `sessionEnd.reason` arrived once, at the end, and says nothing about the turn that completed. The per-turn boundary is `stopReason` on the `session/prompt` response, which is a response to a request rather than a notification - and whether an attaching client sees responses to prompts a human issued is not captured | `not-triggered` as a notification |
| 3 | Should heuristic detection be shipped at all if it can miss blocks? | No, not on this evidence. The `notification` hook's `agent_idle` type is `unclear` because the driven session started no subagent, and the probe's own rule refuses a mapping built on `unclear`. The work-detection the idle-after-nothing suppression depends on never fired at all | `unclear` |
| 4 | Does Copilot CLI load hooks per repository, which would break the global-install promise? | A repository-level hook fired 8 times in `copilot -p` and 0 times in ACP mode in the same workspace, while a user-level hook fired in both. A global install is therefore the shape that suits this harness; a per-repository one cannot be relied on. This is one version on one machine and a future reader should re-probe rather than inherit it | `observed` for user-level, `not-triggered` for repository-level in ACP mode |
