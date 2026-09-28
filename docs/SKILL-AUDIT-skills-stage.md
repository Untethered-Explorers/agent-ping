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

---

# Second attempt: handoff revision `b0c8142` (2026-09-28, headless)

**Mode:** `headless`. **Runner / model:** `opencode` / `opencode/space-bunny-free`, authorized
by the invocation recorded in `docs/authoring-state.json`.
**Stage input fingerprint** (recomputed with the launcher's own
`stageInputFingerprint(repo, "skills", ".opencode")`):
`0fb142e25d33c4db7c6fe22b627d5ac9a4bd7d02870b38ed95d4d8ba58ae89e8` — **identical to the
recorded value**, so the team stage and the handoff were not touched and remain current.
**Stage output fingerprint** over the 7 planned outputs:
`f2c4cc14bb8789711c3cbc5f114493a760192629bdc0af5019f06315f5628556`.

## Per-candidate decisions

| Candidate | Action | Stage decision | Package state |
|-----------|--------|----------------|---------------|
| `pixijs` | reuse | reuse, untouched | global router + 25 topics still resolve and win; the project-local delegation stub is left byte-for-byte alone |
| `canvas-dom-mirror` | create | reuse, unchanged | satisfies its responsibility and the gate |
| `harness-signal-mapping` | create | reuse, unchanged | satisfies its responsibility and the gate |
| `content-free-schema-guard` | create | reuse, unchanged | satisfies its responsibility and the gate |
| `loopback-api-security` | create | reuse, unchanged | satisfies its responsibility and the gate |
| `live-verification-script` | create | **extend** | gained Step 8 (seam closure), 5 gotchas, 4 validation checks, and `references/seam-closure.md` |
| `seam-closure-verification` | extend | **extend** into `live-verification-script`, per the handoff's own reason; see "second launcher defect" below for why a routing entry also exists | `.opencode/skills/seam-closure-verification/SKILL.md`, 69 lines, no guidance of its own |
| `create-project-documentation` | extend | **extend** | gained the closed-gate-register artefact, `references/gate-register.md`, 5 gotchas, 1 validation check, and the never-author-a-verdict rule restated for registers |
| `human-review-gate` | omit | **honored; no package written** | the register that keeps an unperformed gate from reading as a pass lives in `create-project-documentation`, exactly as the omit reason states |

Files touched: 2 modified `SKILL.md`, 2 new reference files, 1 new routing package, this
artifact. `docs/SKILL-CANDIDATES.json` untouched (`git diff --stat` empty). No
`docs/EXECUTION-MANIFEST.json` creation or replacement; no compiler- or engine-owned artefact
touched.

## What the two extends now say

**`live-verification-script` Step 8 — close the seam, do not substitute for it.** Names the
task's declared outputs and writes the seam table (seam, owning task, existence assertion) before
any script code; asserts each seam at the artefact — built file, document fetched over a real
socket, the option carrying the channel, the port the route calls — never through a mock; treats
an unowned seam as a finding rather than something to build inside the verification task; turns a
substituted seam into a bug report naming each missing product seam and its owner, with a
non-zero exit; re-runs against the shipped build with every substitute deleted and asserted gone
*at source level*; declares the evidence summary as a task output rather than a by-product; and
covers a deferral record as a seam in its own right (no adapter module exists, the decision's
evidence digests still hold, every claim the record makes is present in its own text). The
`NT-6`/`NT-7`/`NT-8`/`NT-9` incident, `NT-FR-12`, `NS-4`, `CP-FR-07` and `OA-5` are the worked
examples.

**`create-project-documentation` — closed-gate registers.** A fourth evidence artefact, loaded
from `references/gate-register.md`: the third column distinguishing *a reviewable thing nobody
reviewed* from *a review of software that did not exist yet*; the rule that a register states
what is owed and never a verdict; recording a withdrawn platform path by leaving its evidence
file on disk; and stating the discharge procedure after checking what the engine can actually
re-open, because an engine that cannot re-open a completed gate leaves that procedure to the
reader. Modelled on `docs/reviews/deferred-gates.md` and its `OA-6`/`LD-5`/`IO-5` rows.

## Gates run, and their exit codes

All with the launcher's own checkers and the launcher's own arguments.

```bash
node .../forge-build-agent-team/scripts/validate-frontmatter.mjs --repo . --harness-root .opencode \
  --skills-only --skill-file <each of the 7 planned outputs>          # exit 0
node .../forge-build-agent-team/scripts/validate-team.mjs --repo . --harness-root .opencode \
  --skills-only --fail-structural --min-axis 2 --fail-axis-below \
  --skill-file <each of the 7 planned outputs>                         # exit 0
cd .opencode/skills/skill-review && npm run skill-review -- \
  --files <live-verification-script> <seam-closure-verification> <create-project-documentation> \
  --provider stdout --min-score 2 --fail-below --min-axis 2 --fail-axis-below --fail-structural
                                                                          # exit 0
```

Only the affected handoff candidate files were passed to `skill-review`; the bootstrapped
`forge-*` tooling skills were not rescanned as if they were newly generated project skills.
Every `name` in frontmatter parses to exactly its parent directory name, with no wrapping quote
characters (`validate-frontmatter.mjs` parses all 7 cleanly). Every backticked `references/…`
target in all three touched packages exists on disk; one dangling bare reference written into
`seam-closure-verification` during drafting was found by a link sweep and removed before the
gate ran.

## Heuristic scores, kept separate from behavioral evidence

`skill-review` rubric output for the three changed files:

| Skill | Context | Gotchas | Procedural | Progressive | Calibration | Validation | Overall |
|-------|---------|---------|-----------|-------------|-------------|-----------|---------|
| `live-verification-script` | 3 | 2 | 3 | 3 | 3 | 3 | 2.8 |
| `seam-closure-verification` | 3 | 3 | 3 | 2 | 2 | 3 | 2.7 |
| `create-project-documentation` | 3 | 3 | 3 | 3 | 3 | 2 | 2.8 |

Measured independently of the rubric: 15 gotcha items, 17 validation checks and 8 numbered steps
in `live-verification-script`; 18 / 15 / 0 in `create-project-documentation`; 3 / 4 / 3 in
`seam-closure-verification`; zero missing references in all three.

**The one axis reading below its neighbors is a rubric artifact, not a content gap.**
`quality-rubric.mjs`'s `sectionContent` ends the section at `(?=^#{2,}\s|\Z)` while the regex is
built with the `i` flag. In JavaScript `\Z` is not an end-of-input anchor — it is a literal `Z` —
and `i` makes it match a lowercase `z` too. So `scoreGotchasCoverage` truncates the `## Gotchas`
section at the **first `z` in the section body**, and counts only the dash-items before it. In
`live-verification-script` that is the `z` of "non-zero exit" in the first gotcha, which is why
15 items score as 1. This also means the "improve gotchas coverage" advice in the 2026-09-26
report above is partly an artifact for every package it names. The one-line fix belongs in the
tooling repo: `(?=^#{2,}\s|\n?(?![\s\S]))` or `(?=^#{2,}\s$(?!\n))`. Deliberately **not**
worked around here — no wording was bent to move a number.

`seam-closure-verification` scores 2 on progressive disclosure for a truthful reason: it has no
`references/` directory of its own, because it is a router with no content to disclose. Giving it
one to raise the number would be the wrong fix.

## Two launcher defects, recorded not hidden

Both are in `mcfuzzy-agent-forge` `scripts/forge-launcher` (`validateAuthoringOutputs`); both
reproduce against the **installed** launcher, `forge-launcher@1.0.0-beta.5`, which is symlinked
to that checkout.

**1. The `reuse` filter is fixed in source but not in the built `dist`.** `scripts/launcher.ts`
now filters `action === "create" || action === "extend"`, but `dist/launcher.js:453` — the file
the CLI actually executes — still filters `action !== "omit"`:

```js
const planned = candidates.candidates.filter((candidate) => candidate.action !== "omit");
```

So the `pixijs` stub the first attempt added is still load-bearing for the running binary, even
though the source no longer requires it. Rebuild `dist` and the stub becomes unnecessary. It was
left in place because the running binary needs it, and because the residual risk recorded above
is now measured rather than hypothetical: the harness resolves the **global**
`~/.agents/skills/pixijs/SKILL.md` in preference to the project-local stub, so nothing is
shadowed today.

**2. An `extend` candidate's name is assumed to be its package's directory.** The same function
maps every planned candidate to `skills/<candidate.name>/SKILL.md`. Candidate
`seam-closure-verification` is named for the *capability* being added, and its own reason says it
is "an extension of `live-verification-script`, not a separate package" — a shape the schema
cannot express. Without a package at that path the stage fails with:

```
error: Planned project skill is missing or empty: .opencode/skills/seam-closure-verification/SKILL.md
```

**Interim resolution chosen, following the precedent set above:** a 69-line routing entry at that
path. It carries no seam rule, no example and no assertion list; it names the host package, its
Step 8 and its reference file, and states in its own body that the handoff calls it an extension
rather than a package and that the file exists only because the launcher maps candidate names to
paths. The substantive guidance lives once, in `live-verification-script`, so the two cannot
drift. The handoff was not modified.

**The fix belongs in the tooling repo:** let a candidate carry the package it modifies, or resolve
`extend` by matching the host package named in `reason` instead of by candidate name. The
launcher's stub runner already skips `omit` and `reuse`; it needs the same notion of "a planned
candidate that names a capability rather than a package".

**Not done, deliberately:** `docs/authoring-state.json` was not hand-edited to say `complete`.
The launcher owns that file, computes both fingerprints with its own algorithm, and derives
`outputs` itself; an earlier hand-written record was silently overwritten by the launcher. The
fingerprints above were computed with the launcher's own `authoring-state.ts` so that the record
it writes can be checked against them.
