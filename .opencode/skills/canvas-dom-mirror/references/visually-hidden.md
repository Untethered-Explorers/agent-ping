# Visually hidden but focusable

> Load when writing the mirror's hiding CSS, setting up the jsdom environment for a mirror
> test, or debugging why mirror entries exist in the DOM but are not reachable by keyboard.

The requirement is *visually hidden but focusable*. Most "hidden" CSS breaks one half of it.

## What breaks

| Approach | Invisible | Focusable | In accessibility tree |
|----------|-----------|------------|----------------------|
| `display: none` | yes | **no** | no |
| `visibility: hidden` | yes | **no** | no |
| `hidden` attribute | yes | **no** | no |
| `opacity: 0` | yes | yes | yes, but text still occupies layout |
| `width/height: 0` + `overflow: hidden` | yes | yes | yes, but focus ring is unrenderable |
| clip-rect pattern | yes | yes | yes |
| off-screen positioning | no (scrolls) | yes | yes |

`display: none` and `visibility: hidden` are the two that produce a green test and a broken
product: a DOM assertion such as `container.querySelectorAll('[role="option"]').length === 3`
passes, while nothing is focusable and a screen reader sees nothing.

## The pattern

```css
.dashboard-mirror {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
```

`clip` plus `clip-path: inset(50%)` covers engines that dropped one of the two. The container
stays in the accessibility tree, entries stay focusable, and a forced-colors or high-contrast
mode still renders a focus indicator because the element is not `display: none`.

Entries inside need no extra CSS. Do not re-apply `clip` per entry; a 1px-clipped child of a
clipped parent is fine and adding it makes focus rings unrenderable in forced-colors mode.

## jsdom notes

jsdom applies the stylesheet only if the rule is loaded. Two consequences for tests:

- `element.focus()` works on an element whose computed `display` is `none` in jsdom, because
  jsdom does not implement layout or focusability from computed style. A test that calls
  `focus()` and asserts `document.activeElement` will therefore pass even with broken CSS.
  Assert the applied rule instead: read the stylesheet text, or assert `getComputedStyle` on
  the container when the stylesheet is injected in the test.
- To make the assertion meaningful, assert the container is not `display: none` and not
  `visibility: hidden` in addition to asserting the entry count and the focus result.

## Off-screen alternative

When the project prefers moving the mirror off-screen over clipping, use
`position: absolute; left: -9999px` and give the container `width`/`height` so the page does
not gain scroll extent. Do not combine off-screen positioning with `overflow: hidden` on a
shared ancestor: the ancestor clips the focus ring, and a focused entry that renders nothing
reads as a broken page to a sighted keyboard user.

## Assertion to copy

```ts
const container = document.querySelector('.dashboard-mirror');
const style = getComputedStyle(container);
expect(style.display).not.toBe('none');
expect(style.visibility).not.toBe('hidden');

const entries = container.querySelectorAll('[role="option"]');
const rows = buildRowModel(state);
expect(entries).toHaveLength(rows.filter((r) => r.visible).length);
expect([...entries].map((e) => e.getAttribute('data-session-id')))
  .toEqual(rows.filter((r) => r.visible).map((r) => r.sessionId));
```

Comparing against `buildRowModel` rather than a hardcoded list is what catches the mirror and
the canvas diverging.
