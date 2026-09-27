# State encoding without colour

> Load when adding or renaming a row state, wiring a new state into a canvas row, choosing
> contrast tokens, or when a review finds a state distinguishable only by colour.

Urgency is never encoded by colour alone. Every state carries an icon plus a text label, and
the visual treatment is stable across all four states so a change in state reads as a change of
signal rather than a restyle.

## The four states

| Class | Icon | Text label | Leaves the dashboard | Badge |
|-------|------|------------|---------------------|-------|
| needs-you | filled pause or hand glyph | "Needs you" | yes, one card | yes |
| finished | check glyph | "Finished" | yes, self-expiring card | no |
| running | hollow ring or chevron | "Running" | no | no |
| fyi | dot or info glyph | the subtype in words | no | no |

"Leaves the dashboard" means the state produces a card this product renders in its own
window. It does not mean a platform notification service is involved: since ADR-012 there
is no `notify-send`, no notification centre and no per-platform path, so a state that
leaves the dashboard behaves identically on every platform. A renderer for the card
reads this same table rather than inventing its own vocabulary.

`fyi` carries a subtype - error, retry, long-tool-call, compaction, token-burn - and the label
is the subtype in words, not the literal string "fyi". A screen-reader user gets
"Long tool call", not "FYI".

Two things follow from the class policy and belong in the encoder, not in a caller:

- `fyi` is dashboard-only. It must never produce a card or a badge change.
- Information-only rows are visually quieter than needs-you rows without relying on hue alone;
  the icon glyph and the label text carry the difference.

## Non-colour signals

State is legible if **any two** of these hold. Aim for all of them.

- Icon glyph shape
- Text label
- Position within the row
- Border treatment
- Presence of the pending marker

A row that differs from its neighbours only in background colour fails even at perfect
contrast, because roughly 1 in 12 men cannot separate it.

## Contrast

AA is 4.5:1 for normal text and 3:1 for large text and for non-text indicators such as the
pending marker. Compute against the colour actually painted behind the text:

1. Resolve the row's background for that state, including any hover or selected override.
2. Resolve the label colour for that state.
3. Compute the ratio on the pair. Not the token name against another token name.
4. Check the pending marker and icon glyphs at 3:1 against the same background.

A common failure is verifying the label against the base surface token while the row paints a
state-specific background over it. Assert on the pair, per state.

## Encoder shape

Keep the table the single source; both renderers read it.

```ts
export const STATE_ENCODING = {
  'needs-you': { icon: 'pause-filled', label: 'Needs you', leavesDashboard: true, badge: true },
  finished:   { icon: 'check',        label: 'Finished',  leavesDashboard: true, badge: false },
  running:    { icon: 'ring-hollow',  label: 'Running',   leavesDashboard: false, badge: false },
  fyi:        { icon: 'info-dot',     label: subtypeLabel, leavesDashboard: false, badge: false },
} as const;
```

If a renderer needs a colour for a state, read it from the same table so a state cannot gain
an icon in one renderer and not the other.

## Test to copy

```ts
it('encodes every state with an icon and a text label', () => {
  for (const state of Object.keys(STATE_ENCODING)) {
    const row = renderRow(fixtureFor(state));
    expect(row.querySelector('[data-state-icon]')).not.toBeNull();
    expect(row.querySelector('[data-state-label]')?.textContent?.trim()).not.toBe('');
  }
});

it('fyi never leaves the dashboard', () => {
  expect(STATE_ENCODING.fyi.leavesDashboard).toBe(false);
  expect(STATE_ENCODING['needs-you'].leavesDashboard).toBe(true);
});
```

Iterating the table, not a handpicked list, is what catches a fifth state added later without
an encoding.
