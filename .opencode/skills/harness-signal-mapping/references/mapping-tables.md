# Mapping tables

> Load when building a per-harness translation table, adding a signal to an existing table, or
> resolving a disagreement between an adapter's table and the domain classifier.

Tables are the only assertable form of a mapping. A chain of `if` statements cannot be checked
exhaustively, so an unmapped signal in one is invisible.

## opencode signals

Observed on the `event` hook. `class: null` means the signal deliberately produces no event.

| Signal | Class | Subtype | Dedupe key part | Note |
|--------|-------|---------|------------------|------|
| `session.status` -> idle after work | `finished` | - | session + idle transition | Modern form |
| `session.idle` | `finished` | - | session + idle transition | Deprecated; must resolve to the *same* key as the row above |
| `permission.asked` | `needs-you` | - | session + block id | The dedicated `permission.ask` hook never fires upstream |
| `permission.replied` | - | - | - | Resolves the pending item; not itself a class event |
| `session.error` | `fyi` | `error` | session + error identity | |
| compaction | `fyi` | `compaction` | session + compaction identity | |
| `message.updated` | `fyi` | `token-burn` | session + update identity | Carries the burn signal; never the message text |
| `tool.execute.before` / `tool.execute.after` | `fyi` | `long-tool-call` | session + tool call id | Only when the call exceeds the long threshold |
| `todo.updated` | `fyi` | `retry` | session + todo identity | Only for a retry-shaped update |
| idle with no work in turn | - | - | - | **No event at all** |

`permission.replied` mapping to no class is deliberate: it clears a pending item through the
pending lifecycle. Do not invent a class for it, and do not let it create a new event.

## ACP notifications and Copilot hooks

Copilot CLI speaks ACP natively over newline-delimited JSON-RPC on stdio. The documented hook
triggers are `sessionStart`, `sessionEnd`, `userPromptSubmitted`, `preToolUse`, `postToolUse`
and `errorOccurred`.

| Signal | Class | Subtype | Evidence status |
|--------|-------|---------|-----------------|
| `session/request_permission` | `needs-you` | - | Unresolved upstream; see `probe-and-degrade.md` |
| `session/update` idle marker | `finished` | - | Harness-specific; the ACP idle marker, not a session-end hook |
| `errorOccurred` | `fyi` | `error` | Observed |
| `postToolUse` past threshold | `fyi` | `long-tool-call` | Observed |
| `sessionEnd` reason | `fyi` or `finished` | - | Depends on the reason the hook reports |

The Copilot mapping is bound to whatever the probe report and the recorded gate decision
actually observed. If a signal is unresolved, the table entry is a placeholder that fails
loudly until the probe reports, not a guess that ships.

## Dedupe key derivation

One derivation, used by every path including the polling fallback.

```ts
// Stable identity only. No receive timestamp, no counter, no arrival order.
const dedupeKey = (e: SignalEnvelope): string =>
  [e.harness, e.sessionId, e.transitionId].join(':');
```

- `transitionId` is the block identifier for a needs-you signal and the idle-transition
  identifier for a finished signal.
- A repeated permission ask for the same block produces the same `transitionId`, so the same
  key, so one event.
- Two idle transitions separated by a resume have different `transitionId` values, so two
  events.
- Push and poll must both compute the key through this function. A second derivation is a
  duplicate-event bug waiting for a session that both pushes and is polled.

## Keeping adapter and classifier in agreement

The domain classifier is the authority. A build-time test must fail when an adapter table names
a class the classifier would not produce for that signal:

```ts
it('every adapter mapping agrees with the classifier', () => {
  for (const row of ADAPTER_TABLE) {
    const { klass, subtype } = classify(row.signal);
    expect(row.class).toBe(klass);
    expect(row.subtype).toBe(subtype);
  }
});
```

When they disagree, fix the adapter table. Widening the classifier to accommodate one adapter
re-opens the classification rules for every harness at once.

## Table shape

```ts
export interface SignalMapping {
  signal: string;
  class: 'needs-you' | 'finished' | 'fyi' | null;
  subtype?: 'error' | 'retry' | 'long-tool-call' | 'compaction' | 'token-burn';
  dedupePart: 'block' | 'idle-transition' | 'none';
  evidence: 'observed' | 'absent' | 'unresolved';
  suppressedBecause?: string;
}

export const OPENCODE_TABLE: readonly SignalMapping[] = [ /* ... */ ];
```

`evidence` and `suppressedBecause` are part of the row, not comments beside it, so the
exhaustive test can assert that every suppression has a reason and every unresolved signal has
a probe report.
