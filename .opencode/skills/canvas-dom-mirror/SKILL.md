---
name: canvas-dom-mirror
description: "Build and test a PixiJS canvas surface paired with a visually hidden but focusable DOM mirror of every visible row. Covers one focusable entry per row in canvas order, icon-plus-text state so nothing is colour-only, identity-keyed focus retention when a live update re-renders underneath, and reduced motion for feed-triggered transitions. Use when adding or changing a canvas surface, a row list, a dashboard mirror, keyboard traversal, state encoding, or any accessibility requirement for a canvas-rendered view in agent-ping."
---

# Skill: Canvas DOM Mirror

A PixiJS canvas is invisible to assistive technology. Every canvas-rendered view in
agent-ping therefore ships a visually hidden but focusable DOM mirror holding one entry per
visible row, in the same order as the canvas, plus a keyboard controller and a motion module.
Build the mirror and the canvas from one shared row model so they cannot drift.

Load `references/visually-hidden.md` before writing the hiding CSS or the jsdom setup; the
naive hiding approaches break focusability or drop the subtree from the accessibility tree.

---

## Process

### Step 1: Derive one shared row model

Do not build rows independently for the canvas and the mirror. Produce a single ordered array
of row descriptors, each with a stable `key`, a `state`, a `label`, a `repoShortName`, a
`repoFullPath` and a `sessionId`, and feed both renderers from it.

- `key` is the session identifier, never the array index. Index keys shift when a row is
  inserted and silently move focus to the wrong row.
- The repository primary label is the short name. The full path rides along for hover and
  focus reveal and must never become the label.
- Group headers are repository short names; a repository with two sessions yields one header
  and two rows, in that order.

**Output:** an ordered, keyed row model the canvas, the mirror and the keyboard controller all
read from.

### Step 2: Build the mirror

Render one focusable element per visible row inside a visually hidden container, in the same
order as the row model. Each entry carries an accessible name, its state as text, its
repository grouping and its pending state.

- Keep the mirror and the canvas in one mount function so a row can never exist in one and not
  the other. Mount both from the surface entry point and list that file as a task output.
- Do not use PixiJS's built-in accessibility system as the mirror. If you are considering it then
  use this one instead: it does not produce one focusable entry per visible row in canvas
  order, it carries none of this project's state, grouping or pending semantics, and it gives
  you no identity-keyed focus retention.
- Roving `tabindex` is the correct default: the first entry has `tabindex="0"` and the rest
  `-1`, with arrows moving focus. Do not make every row a tab stop; a list of 30 tab stops is
  unusable and fails the "operable by keyboard" requirement in practice.

**Output:** `src/dashboard/a11y/dom-mirror.ts` exposing a builder and an update function.

### Step 3: Encode state without colour

Every state must be distinguishable by an icon plus a text label. Four states exist: blocked,
finished, running and information-only, and the visual treatment stays stable across all four.

Load `references/state-encoding.md` for the per-state icon and label table, the non-colour
signal list, and the AA contrast check to run against the live theme's real background tokens.

**Output:** a state encoder where no state is distinguishable by colour alone, asserted by a
test that renders all states and checks each produced both an icon and a text label.

### Step 4: Add keyboard traversal

Walk rows in visual order, report activation for the focused row, and make activation
observable rather than implied.

- Arrow keys move focus, `Enter` and `Space` activate, `Home` and `End` jump to the ends.
- Activation must be observable: emit through a callback the surface wires to its real
  behaviour, not a log line.
- Tab leaves the row list entirely; it must not walk every row.

**Output:** `src/dashboard/a11y/keyboard-nav.ts` with the traversal order and activation hook.

### Step 5: Retain focus across a live update

A live update that re-renders the list must not steal focus. This is the fragile part and the
reason this pattern is packaged.

1. Before the update, read the focused entry's row `key`.
2. Re-render the mirror from the new row model.
3. After the update, if that `key` is still present, restore focus to its entry; if it is gone,
   move focus to the nearest surviving row rather than dropping focus to the document body.
4. Assert the surviving-entry case in a test that dispatches an update for a *different* row
   while one row is focused.

Load `references/focus-retention.md` when an update path rebuilds the mirror, when focus is
observed jumping to the body, or when a deep-linked row loses its highlight after a later
update.

**Output:** an update path that preserves focus by row identity, covered by a jsdom test.

### Step 6: Honour reduced motion, including feed-triggered transitions

Read the reduced-motion preference in the path that reacts to incoming state, not only at
mount. A newly arrived blocked row is the case that matters: the prototype's mount-time check
passes while the live page still animates a row in from the right.

- Reduced motion suppresses non-essential movement only. State changes stay visible, and a
  newly arrived row still appears with its icon and label.
- Transition suppression must cover both canvas and mirror. The canvas is where the movement
  is; the mirror is where the assertion goes.
- Assert that a newly arrived blocked row produces no movement when reduced motion is
  requested.

**Output:** `src/dashboard/theme/motion.ts` consulted by the update path, with a test.

### Step 7: Validate against the acceptance criteria

Run the commands in `## Validation`. Both the static and the live surface need their own test
path; a passing static test says nothing about the live one.

**Output:** green `npm test` on the named paths plus a clean `npm run typecheck`.

---

## Gotchas

- **`display: none`, `visibility: hidden` and the `hidden` attribute all break the mirror.**
  The first two make entries unfocusable or drop the subtree from the accessibility tree, which
  fails "visually hidden but focusable" while still passing a DOM-assertion test that only
  checks the elements exist. Use the clip-rect pattern; see `references/visually-hidden.md`.

- **Focus is lost to the document body on every re-render.** Re-rendering the mirror destroys
  the focused element, and browsers move focus to `body` rather than to a neighbour. Assert
  `document.activeElement` after an update, not just that the update applied.

- **An index-keyed list moves focus to the wrong row.** With `key={index}`, inserting a row at
  the top makes the browser reuse the previous node for a different session, so the developer
  reads the wrong repository's state. Key on session identifier.

- **A mirror ordered differently from the canvas is a silent failure.** Screen-reader order and
  visual order diverging produces no error and no failed assertion unless the test compares the
  two orders. Assert mirror order against the row model, not against a hardcoded list.

- **PixiJS's built-in accessibility system is not this requirement.** It looks like the answer
  and it is not: it does not produce one focusable entry per visible row in canvas order and
  carries none of the state, grouping or pending semantics the mirror requires.

- **Contrast checked against a token name instead of the rendered background passes while being
  wrong.** AA must be computed against the colour actually painted behind the text, including
  the row background for that state.

- **Reduced motion checked only at mount.** The mount-time assertion passes and the live feed
  still animates in a newly arrived blocked row. Test the update path.

- **Colour-only state survives a restyle.** A row that once had an icon and a label loses the
  label in a later restyle and becomes colour-only again with no failing test. Assert icon plus
  label on every state in the shared test, not on the states being redesigned.

---

## Validation

Run from the repository root. The static and live surfaces have separate test paths; run both.

```bash
npm test -- tests/dashboard/dom-mirror.test.ts tests/dashboard/keyboard-nav.test.ts
npm test -- tests/dashboard/live-dom-mirror.test.ts
npm run typecheck
```

Confirm each item:

- [ ] A jsdom test mounts the surface and asserts the hidden mirror contains one focusable entry
      per visible row, in the same order as the row model, with the same repository grouping
- [ ] Each mirror entry exposes an accessible name, its state as text, and its repository
      grouping
- [ ] Every state renders both an icon and a text label, asserted across all four states
- [ ] Keyboard traversal visits rows in visual order and reports activation for the focused row
- [ ] The focused row keeps focus when a live update arrives for a different row
- [ ] A newly arrived blocked row produces no movement when reduced motion is requested
- [ ] The mirror's computed style is not `display: none` and not `visibility: hidden`
- [ ] Text contrast is computed against the painted background for each state and meets AA
- [ ] No row's accessible name is a filesystem path; the full path is hover and focus detail only

If a test fails, fix the implementation rather than relaxing the assertion. The specific
remedy per symptom: focus on `body` after an update means Step 5 did not run on that path;
entries present but unfocusable means the hiding CSS is one of the two broken patterns above;
mirror order mismatched means two renderers are sorting independently instead of reading one
row model.
