# Feature: Dashboard Design Prototype

## Traceability

| Canonical ID | Owner / Source Link | Relationship |
|--------------|---------------------|--------------|
| APX-US-03 | [Vision](../PRD.md#17. Traceability Matrix) | participates |
| APX-CON-07 | [Vision](../PRD.md#17. Traceability Matrix) | participates |
| APX-CON-05 | [Vision](../PRD.md#17. Traceability Matrix) | participates |
| APX-CON-11 | [Vision](../PRD.md#17. Traceability Matrix) | participates |
| DP-FR-01 | This feature | owns |
| DP-FR-02 | This feature | owns |
| DP-FR-03 | This feature | owns |
| DP-FR-04 | This feature | owns |
| DP-FR-05 | This feature | owns |
| DP-FR-06 | This feature | owns |
| DP-FR-07 | This feature | owns |
| DP-FR-08 | This feature | owns |

**PRD:** [docs/PRD.md](../PRD.md)

---

## 1. Feature Overview

**Feature Name:** Dashboard Design Prototype
**ID Prefix:** DP
**Summary:** A static PixiJS page with three hardcoded mock rows, no hub, no plugin and no network, whose only purpose is to settle the dashboard design in ninety seconds of looking before any connector work begins, and to establish the toolchain and test-runner convention every later feature depends on.
**Dependencies:** None
**Priority:** Must

---

## 2. User Stories

| ID | As a... | I want to... | So that... | Priority |
|----|---------|-------------|-----------|----------|
| DP-US-01 | developer | look at a static page showing three mock sessions grouped by repository | so that I can judge the layout, density and urgency encoding before it is wired to real data | Must |
| DP-US-02 | keyboard or screen reader user | move through the same rows without a mouse | so that the canvas surface is not a dead end | Must |
| DP-US-03 | implementer | run one test command that fails when it selects nothing | so that a green result always means real assertions ran | Must |

---

## 3. Functional Requirements

```forge-requirement
{"id":"DP-FR-01","kind":"requirement","text":"The prototype is fully static: no hub, no plugin, no HTTP request, no filesystem read and no live data. It opens from a built page and renders three hardcoded mock rows."}
```

```forge-requirement
{"id":"DP-FR-02","kind":"requirement","text":"The prototype initialises PixiJS 8 through its asynchronous application init, sizes to its container, and destroys the renderer and its event subscriptions on unload without leaking a ticker or a texture."}
```

```forge-requirement
{"id":"DP-FR-03","kind":"requirement","text":"Rows are grouped under a repository short-name header with the full path available on hover or focus, and urgency is encoded by an icon plus a text label, never by colour alone."}
```

```forge-requirement
{"id":"DP-FR-04","kind":"requirement","text":"The prototype is fully operable by keyboard: rows are focusable in order, activation is observable, and a reduced-motion preference disables non-essential movement."}
```

```forge-requirement
{"id":"DP-FR-05","kind":"requirement","text":"A visually hidden but focusable DOM mirror of every visible row exists alongside the canvas, exposing accessible names, state and repository grouping so the information is available to a screen reader."}
```

```forge-requirement
{"id":"DP-FR-06","kind":"requirement","text":"Mock data lives in one deterministic module shared by the renderer and the tests, with fixed identifiers and timestamps so snapshots and assertions are stable."}
```

```forge-requirement
{"id":"DP-FR-07","kind":"requirement","text":"The project provides one test command that runs a named test path and fails when that path selects zero tests, so an empty selection can never be reported as a pass."}
```

```forge-requirement
{"id":"DP-FR-08","kind":"requirement","text":"The project provides working typecheck, lint and build scripts, and all three pass on the prototype sources."}
```

**Priority:** every requirement in this feature is Must.

---

## 4. UI / Interaction Design

One page, one column, grouped by repository: a muted repository header line with the short name, then one row per session showing a state icon, a short label, an age, and a one-line status. Three mock rows cover the three interesting cases: a blocked session in one repository, a finished session in the same repository, and a running session in a second repository. No chrome, no navigation, no settings. Density is the point of the review: if three rows already feel crowded, the real list will be worse.

Colour is used for grouping only. State is icon plus text, so a monochrome or colour-blind reading loses nothing. The DOM mirror is off-screen but focusable, and focus order matches visual order.

---

## 5. Implementation Tasks

Task review table, kept outside the phase contracts as authoring evidence.

| ID | Outcome | Owner | Needs | Files | Checks | Excluded |
|---|---|---|---|---|---|---|
| DP-1 | `npm test`, `npm run typecheck`, `npm run lint` and `npm run build` exist and a named-path run fails on zero selection | tooling-engineer | Node 22 LTS | package.json, tsconfig.json, vitest.config.ts, eslint.config.js, tests/tooling/runner-convention.test.ts | runner-convention test; typecheck | No product code, no dashboard |
| DP-2 | Built prototype page renders three grouped mock rows | dashboard-engineer | DP-1 scripts, PixiJS 8.21.0 | vite.config.ts, src/dashboard/prototype/index.html, main.ts, scene.ts, mock-data.ts, tests/dashboard/prototype-scene.test.ts | prototype-scene test through the mount entry point; typecheck | No hub, no SSE, no ack |
| DP-3 | Urgency is non-colour-only, keyboard order works, motion respects preference, DOM mirror is mounted | dashboard-engineer | DP-2 mount entry point and mock data | src/dashboard/prototype/main.ts, src/dashboard/a11y/dom-mirror.ts, keyboard-nav.ts, src/dashboard/theme/motion.ts, tests/dashboard/dom-mirror.test.ts, tests/dashboard/keyboard-nav.test.ts | dom-mirror and keyboard-nav tests through the mounted prototype | No live data, no styling beyond contrast and state encoding |
| DP-4 | A human has judged the prototype and recorded verdicts | human reviewer | DP-2, DP-3 | docs/reviews/dashboard-design.json | recorded verdict per criterion plus the journey the reviewer performed | No code changes |

### Phase 1: Toolchain and static prototype

```forge-task
{
  "id": "DP-1",
  "title": "Establish toolchain and test-runner convention",
  "description": "Create the single-package Node 22 and TypeScript project that every later feature builds on. Add npm scripts for build, test, typecheck and lint; configure Vitest so `npm test -- <path>` runs exactly that path and exits non-zero when the path selects zero test files; add a test that asserts this convention by running the runner against a temporary empty selection. Do not write any product code, dashboard or store in this task.",
  "ownerAgent": "tooling-engineer",
  "dependencies": [],
  "expectedOutputs": ["package.json", "tsconfig.json", "vitest.config.ts", "eslint.config.js", "tests/tooling/runner-convention.test.ts"],
  "validationCommands": ["npm test -- tests/tooling/runner-convention.test.ts", "npm run typecheck"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/dashboard-design-prototype.md#DP-FR-07", "docs/features/dashboard-design-prototype.md#DP-FR-08"],
    "acceptanceCriteria": [
      "The runner-convention test proves a named-path run of a path with no tests exits non-zero rather than reporting success",
      "npm run typecheck and npm run lint both succeed on an empty source set",
      "Every script name later features rely on is present in package.json"
    ],
    "constraints": ["Node.js 22 LTS or newer with TypeScript and npm only"],
    "constraintRefs": ["docs/PRD.md#APX-CON-05"],
    "references": ["docs/PRD.md#6.1 Technology Stack", "docs/PRD.md#6.2 Project Structure", "docs/features/dashboard-design-prototype.md#3. Functional Requirements", "docs/IDEA.md#Open Questions"]
  }
}
```

```forge-task
{
  "id": "DP-2",
  "title": "Render the static mock dashboard page",
  "description": "Build the PixiJS 8 prototype as a static page: one exported mount entry point that initialises the application asynchronously, sizes to its container, draws a repository group header with the short name and the full path on hover, and draws session rows carrying a state icon, a text label, an age and a one-line status. Consume the deterministic mock module for exactly three rows across two repositories, one blocked, one finished, one running. Wire the mount entry point into the page HTML as the composition root so a user can open the built page and see the rows. Make no network call and read no file. Exclude live data, acknowledgement and any hub interaction.",
  "ownerAgent": "dashboard-engineer",
  "dependencies": ["DP-1"],
  "expectedOutputs": ["vite.config.ts", "src/dashboard/prototype/index.html", "src/dashboard/prototype/main.ts", "src/dashboard/prototype/scene.ts", "src/dashboard/prototype/mock-data.ts", "tests/dashboard/prototype-scene.test.ts"],
  "validationCommands": ["npm test -- tests/dashboard/prototype-scene.test.ts", "npm run typecheck"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/dashboard-design-prototype.md#DP-FR-01", "docs/features/dashboard-design-prototype.md#DP-FR-02", "docs/features/dashboard-design-prototype.md#DP-FR-03", "docs/features/dashboard-design-prototype.md#DP-FR-06"],
    "acceptanceCriteria": [
      "A test drives the exported mount entry point and asserts the three mock rows render under their repository headers with the expected state labels",
      "A test asserts the mount entry point performs no network request and the prototype page contains no hub URL",
      "A test asserts unload destroys the renderer and removes every registered subscription"
    ],
    "constraints": [],
    "constraintRefs": ["docs/PRD.md#APX-CON-09", "docs/PRD.md#APX-CON-11"],
    "references": ["docs/PRD.md#6.1 Technology Stack", "docs/features/dashboard-design-prototype.md#4. UI / Interaction Design", "docs/IDEA.md#Open Questions"]
  }
}
```

```forge-task
{
  "id": "DP-3",
  "title": "Add non-colour urgency encoding, keyboard order and the DOM mirror",
  "description": "Extend the prototype so state is legible without colour, the page is operable by keyboard alone, and a visually hidden DOM mirror exposes the same information. Add a state encoder that maps each state to an icon and a text label, a focus-order controller that walks rows in visual order and reports activation, a motion module that reads the reduced-motion preference and disables non-essential movement, and a mirror builder that renders an off-screen focusable list of rows with accessible names, state and repository grouping. Mount the mirror and the keyboard controller from the prototype mount entry point and list that file as an output so the wiring is part of this task. Exclude live data and visual restyling beyond state encoding and contrast.",
  "ownerAgent": "dashboard-engineer",
  "dependencies": ["DP-2"],
  "expectedOutputs": ["src/dashboard/prototype/main.ts", "src/dashboard/a11y/dom-mirror.ts", "src/dashboard/a11y/keyboard-nav.ts", "src/dashboard/theme/motion.ts", "tests/dashboard/dom-mirror.test.ts", "tests/dashboard/keyboard-nav.test.ts"],
  "validationCommands": ["npm test -- tests/dashboard/dom-mirror.test.ts tests/dashboard/keyboard-nav.test.ts", "npm run typecheck"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/dashboard-design-prototype.md#DP-FR-04", "docs/features/dashboard-design-prototype.md#DP-FR-05", "docs/features/dashboard-design-prototype.md#DP-FR-03"],
    "acceptanceCriteria": [
      "A jsdom test mounts the prototype and asserts the hidden mirror contains one focusable entry per visible row with the same repository grouping and state text",
      "A jsdom test asserts keyboard traversal visits rows in visual order and reports activation for the focused row",
      "A test asserts the reduced-motion preference suppresses non-essential movement while leaving state changes visible",
      "A test asserts every state renders an icon and a text label so no state is distinguished by colour alone"
    ],
    "constraints": ["Canvas paired with a visually hidden focusable DOM mirror, reduced motion honoured, AA contrast"],
    "constraintRefs": ["docs/PRD.md#APX-CON-07", "docs/PRD.md#APX-CON-09"],
    "references": ["docs/features/dashboard-design-prototype.md#4. UI / Interaction Design", "docs/PRD.md#9. Accessibility", "docs/IDEA.md#Where The Surface Lives"]
  }
}
```

### Phase 2: Design review gate

```forge-task
{
  "id": "DP-4",
  "title": "Review the static prototype as a design artefact",
  "description": "Human review of the built prototype. Build the dashboard, open the prototype page, and judge the design questions that discussion could not settle: layout, density, whether urgency is readable without colour, whether the keyboard path is usable, and whether the mock rows feel crowded. Complete the primary user journey against the running prototype: scan the three mock rows, identify which repository is blocked, and reach the blocked row using only the keyboard. Record the judgement, what was exercised, and any required change in the review file. Do not change code in this task; record the required change instead.",
  "dependencies": ["DP-2", "DP-3"],
  "expectedOutputs": [],
  "validationCommands": [],
  "contract": {
    "version": 2,
    "kind": "human-review",
    "requirements": [],
    "requirementRefs": ["docs/features/dashboard-design-prototype.md#DP-FR-01", "docs/features/dashboard-design-prototype.md#DP-FR-03", "docs/features/dashboard-design-prototype.md#DP-FR-04", "docs/features/dashboard-design-prototype.md#DP-FR-05"],
    "acceptanceCriteria": [
      "The reviewer built the prototype, opened the page and completed the primary journey, stating in the notes which rows were inspected and how the blocked repository was identified",
      "The reviewer recorded a verdict on density, on urgency legibility without colour, and on keyboard usability",
      "The reviewer recorded whether Live Dashboard may proceed on this design, and every required change as an explicit list"
    ],
    "constraints": ["A subjective visual judgement never stands alone; the journey must have been performed on the running page"],
    "constraintRefs": ["docs/PRD.md#APX-CON-07"],
    "reviewFile": "docs/reviews/dashboard-design.json",
    "references": ["docs/features/dashboard-design-prototype.md#4. UI / Interaction Design", "docs/PRD.md#11. Analytics / Success Metrics", "docs/IDEA.md#Open Questions"]
  }
}
```

---

## 6. Testing Strategy

| Level | Scope | Approach |
|-------|-------|----------|
| Tooling | Runner convention | Vitest subprocess assertion that a zero-selection run fails |
| Unit | Scene layout, state encoding, motion preference | Pure functions over the mock module, no canvas required |
| DOM | Mirror contents, keyboard traversal | jsdom, driving the real mount entry point |
| Manual | Density and visual judgement | Human design review gate against the built page |

Key test scenarios:

1. A named-path run against a path with no tests exits non-zero.
2. The mounted prototype exposes one focusable mirror entry per visible row with matching state text.
3. Keyboard traversal reaches the blocked row and reports activation.
4. Reduced-motion preference suppresses non-essential movement.
5. Unload destroys the renderer and leaves no live subscription.

---

## 7. Acceptance Criteria

1. `npm test`, `npm run typecheck`, `npm run lint` and `npm run build` all succeed from a clean checkout.
2. A test proves the runner fails on zero selected tests.
3. The built prototype page shows three mock rows grouped by repository, with no network activity.
4. The page is fully operable by keyboard and its information is available through the DOM mirror.
5. A human review file records the design verdict and the journey the reviewer performed.

---

## 8. Open Questions

| # | Question | Default Assumption |
|---|----------|--------------------|
| 1 | Does the prototype settle the design, or does rejection force a second pass? | Accepted with minor changes; a rejection reopens this feature before Live Dashboard starts |
| 2 | Is the mock data set representative of a busy afternoon? | Three rows across two repositories is the floor; a tenth row is added to the Live Dashboard fixture if the review asks for it |
| 3 | Which visual metaphor carries state without colour? | Icon plus text label, decided in the review rather than assumed here |
