# Focus retention across a live update

> Load when an update path rebuilds the mirror, when focus is observed jumping to the document
> body after an incoming event, or when a deep-linked row loses its highlight after a later
> update.

The live dashboard re-renders whenever the hub pushes state. A re-render destroys the focused
element, and the browser moves focus to `document.body`, not to a neighbour. The developer
loses their place mid-decision, which is exactly the moment agent-ping exists to protect.

## The rule

Focus is addressed by **row identity** (session identifier), never by DOM node, array index or
position in the previous render.

```ts
export function applyUpdate(container: HTMLElement, next: Row[]): void {
  const focusedKey = focusedSessionId(container);
  render(container, next);
  if (focusedKey === null) return;
  restoreFocus(container, focusedKey, next);
}
```

## restoreFocus

Three outcomes, all deliberate:

1. **The key is still present.** Focus its entry. This is the common case and the one the test
   must cover.
2. **The key is gone.** Focus the nearest surviving row by previous position, so the developer
   stays inside the list instead of being dropped at the top of the document. Clamp to the
   first or last entry when the list empties on one side.
3. **The list is now empty.** Leave focus on the container, not on `body`, so the next update
   has something to restore into and so focus is not lost to the browser chrome.

Never call `blur()`. Never re-append a stale node to keep focus alive; the node's content is
already wrong.

## Roving tabindex after a re-render

`tabindex="0"` must follow the focused entry. A re-render that resets every entry to `-1` and
leaves the first at `0` makes the list unreachable by Tab even though focus retention worked.
Recompute the roving index from the post-render focus position.

## Interaction with deep links

A deep link focuses and highlights one session (LD-FR-06). That focus is a row identity like
any other, so the same retention path covers it: a later update for an unrelated session must
leave the deep-linked row focused and highlighted. A deep link that highlights by index loses
its target as soon as one row is inserted above it.

## What to assert

Three tests, in jsdom, against the mounted surface:

```ts
// 1. Focus survives an update for a different row.
entries[3].focus();
applyUpdate(container, rowsWithNewEventForRow0);
expect(document.activeElement?.getAttribute('data-session-id')).toBe(rows[3].sessionId);

// 2. Focus is not dropped to the body when the focused row disappears.
entries[0].focus();
applyUpdate(container, rowsWithoutRow0);
expect(document.activeElement).not.toBe(document.body);
expect(document.activeElement).not.toBeNull();

// 3. The focused row keeps its highlight class after the update.
expect(document.activeElement?.classList.contains('is-highlighted')).toBe(true);
```

Test 1 alone passes against an implementation that hardcodes "always focus index 0", because
row 0 arriving is exactly the case that looks correct. Test 2 is what separates real retention
from a coincidence, so keep it.

## Failure signatures

| Symptom | Cause |
|---------|-------|
| Focus lands on `body` after every update | The update path never calls `restoreFocus` |
| Focus jumps to the first row | Focus restored by index, not by key |
| Focus moves to a different session after an insert | Index-keyed list; key on `sessionId` |
| Deep link highlights the wrong row | Highlight or focus stored as a position |
| List unreachable by Tab after an update | Roving `tabindex` not recomputed post-render |
