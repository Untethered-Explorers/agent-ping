---
name: pixijs
description: "Project entry point for PixiJS 8 work in agent-ping. The authoritative per-topic guidance is the globally installed pixijs router and its 25 topic packages; load this file only to find which global package to use, because this repository deliberately keeps no PixiJS API guidance of its own."
---

# Skill: PixiJS (project delegation)

PixiJS guidance for this project is maintained **globally**, in the `pixijs` router and its 25
topic packages under the user's global skills directory. This file exists only to route you to
the right one. It deliberately contains no PixiJS API guidance, because a copy here would drift
from the pinned version.

## Process

### Step 1: Resolve the global router

Load the global `pixijs` router first; it names the correct topic package for the mechanic at
hand. If the router is unavailable, then load the matching `pixijs-*` package directly from the
global skills directory.

### Step 2: Pick the topic package

| Mechanic | Global package |
|----------|----------------|
| Application setup, async `app.init`, resize, teardown | `pixijs-application` |
| Containers, transforms, render order, bounds | `pixijs-scene-container` |
| Graphics shapes, fills, strokes, holes | `pixijs-scene-graphics` |
| Text, `TextStyle`, layout, wrapping | `pixijs-scene-text` |
| Ticker, delta time, render loop | `pixijs-ticker` |
| Profiling, destroy patterns, texture GC | `pixijs-performance` |
| Build setup, Vite, project scaffolding | `pixijs-create` |
| Upgrading from v7, breaking changes | `pixijs-migration-v8` |

Load `references/topic-map.md` for the full 25-package surface, including assets, blend modes,
colour, events, filters, math, meshes, particles and environments.

### Step 3: Delegate, and do not reconstruct

Follow the global package's guidance for the mechanic you need. If the global packages are
missing, then say so plainly and stop. Reconstructing upstream API guidance from memory is the
failure this delegation exists to prevent, and a wrong reconstruction here is worse than no
answer because it looks authoritative.

**This project's own dashboard requirements are not PixiJS questions.** Canvas-versus-DOM
accessibility, one focusable mirror entry per visible row, state encoding, keyboard traversal,
focus retention and reduced motion are specified in the `canvas-dom-mirror` skill. Load that
skill for those, not a global PixiJS package.

## Gotchas

- **Do not copy PixiJS guidance into this file.** Guidance duplicated here drifts from the pinned version. That is exactly what this delegation avoids, and this file must stay a router.

- **A project-local `pixijs` may shadow the global router.** If the global packages stop resolving while this file is present, then shadowing is the first thing to check, not a broken global install.

- **PixiJS's built-in accessibility system does not satisfy this project's requirement.** It is not a substitute for the DOM mirror, and reaching for it when the accessibility task calls for something else is a misroute. Use `canvas-dom-mirror`.

## Validation

- [ ] The global router resolves: `ls ~/.agents/skills/pixijs/SKILL.md` exits 0
- [ ] The topic package for the mechanic at hand resolves under the global skills directory
- [ ] No PixiJS API guidance was added to this file; it routes only

```bash
ls ~/.agents/skills/pixijs/SKILL.md && ls -d ~/.agents/skills/pixijs-*
```

If the global router does not resolve, then this project has no PixiJS guidance available. Say
so and stop, rather than writing the guidance here.
