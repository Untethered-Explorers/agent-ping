Posting audit report via stdout...
# Skill Audit Report

**Generated:** 2026-09-26
**Audited by:** `skill-review`
**Skills audited:** 7

---

## Summary Scores

| Skill | Context economy | Gotchas coverage | Procedural clarity | Progressive disclosure | Calibration | Validation | Overall |
|-------|---|---|---|---|---|---|---------|
| `pixijs` | 3 | 3 | 3 | 3 | 2 | 2 | 2.7 |
| `canvas-dom-mirror` | 3 | 3 | 3 | 3 | 2 | 2 | 2.7 |
| `harness-signal-mapping` | 3 | 3 | 3 | 3 | 3 | 3 | 3 |
| `content-free-schema-guard` | 3 | 3 | 3 | 3 | 2 | 2 | 2.7 |
| `loopback-api-security` | 3 | 3 | 3 | 3 | 3 | 2 | 2.8 |
| `live-verification-script` | 3 | 2 | 3 | 3 | 2 | 3 | 2.7 |
| `create-project-documentation` | 3 | 3 | 3 | 3 | 3 | 2 | 2.8 |

**Score interpretation:**
- 2.5–3.0: Strong - follows best practices well
- 1.5–2.4: Adequate - works but has improvement opportunities
- 1.0–1.4: Needs work - significant gaps against best practices

---

### `pixijs`
**Overall score:** 2.7 🟢 (strong)
**Path:** `/home/mcfuzzysquirrel/Projects/agent-ping/.opencode/skills/pixijs/SKILL.md`
**Reviewer-style proxy:** 2 (proxy)
**Strengths:**
- Strong context economy
- Strong gotchas coverage
- Strong procedural clarity
- Strong progressive disclosure
**Improvement opportunities:**
- Improve calibration
- Improve validation
**Suggested changes:**
1. Add exact commands for fragile/destructive operations and escape-hatch alternatives for flexible operations
2. Expand `## Validation` with more checkboxes and/or a self-contained validation script

---

### `canvas-dom-mirror`
**Overall score:** 2.7 🟢 (strong)
**Path:** `/home/mcfuzzysquirrel/Projects/agent-ping/.opencode/skills/canvas-dom-mirror/SKILL.md`
**Reviewer-style proxy:** 2 (proxy)
**Strengths:**
- Strong context economy
- Strong gotchas coverage
- Strong procedural clarity
- Strong progressive disclosure
**Improvement opportunities:**
- Improve calibration
- Improve validation
**Suggested changes:**
1. Add exact commands for fragile/destructive operations and escape-hatch alternatives for flexible operations
2. Expand `## Validation` with more checkboxes and/or a self-contained validation script

---

### `harness-signal-mapping`
**Overall score:** 3 🟢 (strong)
**Path:** `/home/mcfuzzysquirrel/Projects/agent-ping/.opencode/skills/harness-signal-mapping/SKILL.md`
**Reviewer-style proxy:** 3 (proxy)
**Strengths:**
- Strong context economy
- Strong gotchas coverage
- Strong procedural clarity
- Strong progressive disclosure
- Strong calibration
- Strong validation
**Improvement opportunities:** None - all axes scored 3

---

### `content-free-schema-guard`
**Overall score:** 2.7 🟢 (strong)
**Path:** `/home/mcfuzzysquirrel/Projects/agent-ping/.opencode/skills/content-free-schema-guard/SKILL.md`
**Reviewer-style proxy:** 2 (proxy)
**Strengths:**
- Strong context economy
- Strong gotchas coverage
- Strong procedural clarity
- Strong progressive disclosure
**Improvement opportunities:**
- Improve calibration
- Improve validation
**Suggested changes:**
1. Add exact commands for fragile/destructive operations and escape-hatch alternatives for flexible operations
2. Expand `## Validation` with more checkboxes and/or a self-contained validation script

---

### `loopback-api-security`
**Overall score:** 2.8 🟢 (strong)
**Path:** `/home/mcfuzzysquirrel/Projects/agent-ping/.opencode/skills/loopback-api-security/SKILL.md`
**Reviewer-style proxy:** 3 (proxy)
**Strengths:**
- Strong context economy
- Strong gotchas coverage
- Strong procedural clarity
- Strong progressive disclosure
- Strong calibration
**Improvement opportunities:**
- Improve validation
**Suggested changes:**
1. Expand `## Validation` with more checkboxes and/or a self-contained validation script

---

### `live-verification-script`
**Overall score:** 2.7 🟢 (strong)
**Path:** `/home/mcfuzzysquirrel/Projects/agent-ping/.opencode/skills/live-verification-script/SKILL.md`
**Reviewer-style proxy:** 2 (proxy)
**Strengths:**
- Strong context economy
- Strong procedural clarity
- Strong progressive disclosure
- Strong validation
**Improvement opportunities:**
- Improve gotchas coverage
- Improve calibration
**Suggested changes:**
1. Expand `## Gotchas` with more specific, project-relevant items - not generic advice
2. Add exact commands for fragile/destructive operations and escape-hatch alternatives for flexible operations

---

### `create-project-documentation`
**Overall score:** 2.8 🟢 (strong)
**Path:** `/home/mcfuzzysquirrel/Projects/agent-ping/.opencode/skills/create-project-documentation/SKILL.md`
**Reviewer-style proxy:** 2 (proxy)
**Strengths:**
- Strong context economy
- Strong gotchas coverage
- Strong procedural clarity
- Strong progressive disclosure
- Strong calibration
**Improvement opportunities:**
- Improve validation
**Suggested changes:**
1. Expand `## Validation` with more checkboxes and/or a self-contained validation script

---

## Next Steps

Review the suggested changes above. Fix structural issues first, then tackle the lowest-scoring axes.


---

# Launcher conflict and resolution (added after the first stage attempt failed)

The launcher's `validateAuthoringOutputs` (mcfuzzy-agent-forge `scripts/launcher.ts:565`) filters
planned candidates with `action !== "omit"`, so it validates `reuse` exactly as it validates
`create` and requires a project-local file:

```
error: Planned project skill is missing or empty: .opencode/skills/pixijs/SKILL.md
```

That is unsatisfiable for this handoff: the `pixijs` candidate is `reuse` precisely because its
packages are installed globally and must not be duplicated into the repository, where they would
drift from the pinned version.

**This is a launcher defect, not a handoff defect.** The same file contradicts itself — the stub
runner at `launcher.ts:773` correctly skips both actions:

```ts
if (candidate.action === "omit" || candidate.action === "reuse") continue;
```

Any project whose team reuses a global or upstream skill therefore fails its skills stage. The
one-line fix is to make line 565 match line 773; that remains outstanding in the tooling repo.

**Interim resolution chosen:** add `.opencode/skills/pixijs/SKILL.md` as a pure delegation stub.
It contains no PixiJS API guidance — only routing to the 25 global packages, plus a full topic map
in `references/topic-map.md`. It duplicates nothing, so it cannot drift, and it keeps the handoff's
`action: "reuse"` and its recorded reason intact. The handoff was not modified.

Residual risk, recorded not hidden: a project-local `pixijs` may shadow the global router in
harness resolution order. If the global packages stop resolving, check shadowing before suspecting
a broken global install. This is stated as a gotcha inside the stub itself.

**Verified after the change, using the launcher's own checkers and arguments:**

- All 7 planned outputs exist and are non-empty.
- `validate-frontmatter.mjs --skills-only` over all 7: exit 0.
- `validate-team.mjs --skills-only --fail-structural --min-axis 2 --fail-axis-below` over all 7: exit 0.
- The stage's own `skill-review` gate over all 7: exit 0, no structural issues.

**Not done, deliberately:** `docs/authoring-state.json` was not hand-edited to say `complete`.
The launcher owns that file, computes both fingerprints with its own algorithm, and derives
`outputs` itself; an earlier hand-written record was silently overwritten by the launcher. The
`complete` status must come from `forge-launcher draft-skills`, which re-validates and writes it.
