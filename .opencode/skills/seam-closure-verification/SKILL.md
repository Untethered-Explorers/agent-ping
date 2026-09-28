---
name: seam-closure-verification
description: "Route seam-closure work to the live-verification-script skill, which owns it. Use when a task depends on an artefact another task was supposed to produce, when a verification script had to substitute for a product capability, or when a path that was once proved with a substitute must be re-proved against the shipped build. This package contains no guidance of its own by design."
---

# Skill: Seam-Closure Verification (project delegation)

The seam-closure discipline for this project lives in **`live-verification-script`**, in its
Step 8 and in the reference file that sits beside that package's own `SKILL.md`. This file
routes you there and deliberately carries no guidance of its own, so the two cannot drift apart.

The handoff that planned this work (`docs/SKILL-CANDIDATES.json`, candidate
`seam-closure-verification`, action `extend`) recorded that this is an *extension of*
`live-verification-script` and **not a separate package**. It is a capability being added, named
so the capability is reviewable. The file you are reading exists only because the launcher's
output check maps every planned candidate name to a path under `.opencode/skills/`; see the
note in the stage evidence at `docs/SKILL-AUDIT-skills-stage.md`.

## Process

### Step 1: Load the host package

Load the `live-verification-script` skill. Its `description` already carries the seam trigger, so
it is reachable directly; this name is an alias, not a second copy.

### Step 2: Read the two places that matter

1. `live-verification-script` SKILL.md, **Step 8: Close the seam, do not substitute for it** — the
   rules, in order.
2. `live-verification-script/references/seam-closure.md` — the seam table format, the
   artefact-level existence assertions, the missing-seam bug-report shape, the shipped-build
   re-proof, and the two easy-to-miss seams: an undeclared evidence output, and a deferral record
   that must assert its own claims.

### Step 3: Do not add guidance here

If a seam rule needs to change, then change it in the host package. Then delete whatever was
added here. Two copies of this discipline would immediately diverge, and the divergent one is the
one an agent would load.

## Gotchas

- **Do not put seam guidance in this file.** The handoff says this is an extension, not a
  package. Guidance added here drifts from the host package with no signal, because nothing
  compares the two.

- **Do not read this file as the start of the procedure.** It has no rules in it. Load the host
  package or you will conclude, correctly, that you have been told nothing.

- **A stub is not a licence to mark the stage green by name.** The launcher's existence check
  passes on a non-empty file; it does not check that guidance is present. The stage evidence file
  is what records that this package is a routing entry, and it must keep saying so.

## Validation

- [ ] `live-verification-script/SKILL.md` has a `## Gotchas` and a `## Validation` section, and
      Step 8 exists in it
- [ ] `live-verification-script/references/seam-closure.md` exists
- [ ] This file contains no seam rule, no example, and no assertion list
- [ ] `docs/SKILL-AUDIT-skills-stage.md` still describes this file as a routing entry

```bash
rg -c "Step 8" .opencode/skills/live-verification-script/SKILL.md
test -f .opencode/skills/live-verification-script/references/seam-closure.md
```

If the host package ever loses Step 8 or its reference, then this router points at nothing. That
is the failure to report, not one to paper over by writing the rules here.
