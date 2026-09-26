# Human Review: Review the static prototype as a design artefact

Reviewer: Doug McCusker
Reviewed at: 2026-09-26T13:03:33.377Z
Decision: Approved

## Review notes

## Journey performed

The prototype was opened as a built page and the primary journey was completed
end to end on the running prototype, not on a description of it.

Rows inspected: all three mock rows, across both repository groups.

| Group header     | Row                        | State    | Status line shown                        |
|------------------|----------------------------|----------|------------------------------------------|
| `agent-ping`     | `confirm the ack flow`     | Blocked  | waiting on your decision to continue     |
| `agent-ping`     | `add the ingest route`     | Finished | changes are ready, nothing else is needed |
| `knowledge-dungeon` | `render the session list` | Running  | working through the queued items         |

How the blocked repository was identified: the blocked row is the one carrying
the stop icon and the word "Blocked" under the group headed `agent-ping`, so the
blocked repository is `agent-ping`. The identification was read from the icon
and the text label, not from the accent colour.

Hover: the full repository path was revealed on hover and remained visible for
roughly one to two seconds while the pointer was held over the group header.

Keyboard path actually taken, from a fresh page load with the pointer unused:

- `Tab` reached the blocked row directly, which is the first row in visual order.
- `ArrowDown` / `ArrowUp` moved focus between rows in visual order.
- A second `Tab` left the row list rather than walking to the next row, so the
  list is a single tab stop and the roving tabindex behaves as intended.
- Focusing a row revealed the full repository path, exactly as hover did, so a
  keyboard user receives the same identity detail a pointer user receives.
- `Enter` and `Space` on the focused row produced no change that could be seen
  on the page.

DOM mirror verified directly in the browser:

    [...document.querySelectorAll('[data-mirror-row]')]
      .map(r => [r.dataset.mirrorRow, r.dataset.mirrorStateLabel, r.dataset.mirrorActivations])

returned three rows carrying their state labels, so the hidden mirror is present
in the built page and matches the three canvas rows. This is the only way the
mirror could be observed: it is hidden by clipping to a 1px box, so nothing about
it is visible on the page and it is not discoverable by ordinary inspection.

## Verdicts

**Density: pass.** Three rows across two groups read comfortably. Nothing felt
crowded, and the group headers separate cleanly from the rows beneath them. This
answers the prototype's stated purpose: the floor case is not tight, so the real
list has room.

**Urgency legible without colour: pass.** Blocked, Finished and Running remain
distinguishable from the icon shape plus the text label alone. A monochrome or
colour-blind reading loses nothing, and the blocked row is still the first thing
found when scanning.

**Keyboard usability: pass with required changes.** Traversal itself is correct
and was pleasant to use: the list is one tab stop, arrows walk rows in visual
order, and focus reveals the full path. The gap is feedback, not navigation. A
row's focused state and a row's activated state are both invisible on the
surface. Neither state is painted by the scene, and the only element that carries
them is the 1px clipped mirror, so a sighted keyboard user has no confirmation of
where focus is or that activation did anything. This is exactly the dead end
DP-FR-04 and the canvas-plus-mirror constraint exist to prevent: the information
reaches assistive technology, but not the person looking at the page.

## Live Dashboard may proceed on this design

Yes, subject to the required changes below. The layout, density, grouping,
non-colour state encoding and keyboard traversal are settled by this review and
should not be reopened. The two changes are additions to the row's visible
state, not a redesign, and both belong in LD-1 through LD-4 rather than in a
second pass over the prototype.

## Required changes

1. Paint a visible focus indicator on the canvas for the focused row. The scene
   has no focus paint path at all: `src/dashboard/prototype/scene.ts` contains no
   focus or activation drawing, and the surface currently changes only by
   revealing the repository path. LD must paint a persistent focus treatment
   (ring or row highlight) that is not colour-only, and it must survive a
   re-render under the focused row, matching the mirror's identity-keyed focus
   retention. The keyboard controller already supplies the identity
   (`onFocusRow(sessionId)` and `focusedSessionId`), so this is a missing render
   path, not a missing mechanism.

2. Paint a visible activated state on the canvas. Activation is currently
   recorded and never shown: `onActivate` in
   `src/dashboard/prototype/main.ts` assigns `activatedSessionId` and nothing
   else, and the class the mirror receives, `is-activated`
   (`MIRROR_ACTIVATED_CLASS` in `src/dashboard/a11y/dom-mirror.ts`), carries no
   styling and sits inside a clipped element. Pressing `Enter` on a row is
   currently a silent no-op for anyone not using DevTools. LD must repaint the
   row into an activated state so the acknowledgement reaction has a visible
   affordance.

3. Give the DOM mirror a documented inspection affordance. The mirror is correct
   but invisible and undiscoverable: it is hidden by clipping, its state classes
   have no styles, and locating it required a hand-written console query. LD
   should ship a debug flag that un-clips the mirror so a future reviewer can
   verify the accessible twin without reconstructing the query, and so the
   classes that tests assert are the same ones a human can see.

## Notes and what this review did not cover

- Reduced motion was not exercised. The `prefers-reduced-motion` path is
  implemented and unit-tested, but no OS-level preference was set during this
  review, so it is not attested here.
- Text contrast was judged by eye against the dark surface, not measured against
  the WCAG 2.1 AA ratio. No measured contrast figure is claimed.
- Pointer behaviour was exercised only as far as the hover reveal; click
  activation on a static row is not implemented at this stage by design.
- Window resize behaviour was not exercised.
- The headless-browser observations recorded in DP-2 and DP-3 remain the only
  automated evidence for hover; this review adds the human judgement those tasks
  explicitly could not make.
