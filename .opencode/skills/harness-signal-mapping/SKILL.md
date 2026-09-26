---
name: harness-signal-mapping
description: "Translate one harness's event names, ACP notifications and hook payloads into agent-ping's shared normalized envelope. Covers the table-driven class and subtype mapping, the per-turn work-signal accumulator that separates real work from a greeting-and-close, dedupe keys shared between pushed and polled signals, and documented degradation when a signal is missing. Use when adding a harness adapter, adding a signal to an existing adapter, wiring the polling fallback, or when a class, subtype or dedupe key must match across two harnesses."
---

# Skill: Harness Signal Mapping

Every harness adapter translates its own vocabulary into one normalized envelope, and the hub
classifies that envelope. The translation is written at least three times - the domain
classifier, the opencode adapter, and the Copilot adapter - so the mapping must be
table-driven and the tables must agree with each other and with the domain classifier.

No harness-specific path may bypass the hub's classification, pending and delivery rules. A
Copilot envelope is stored and classified exactly like an opencode envelope.

---

## Process

### Step 1: Enumerate the harness's real signals before writing any mapping

Read the harness's own documentation and types, then list the signals you will actually map
and where each one was observed. Do not map from memory and do not map from a name that looks
plausible.

- Record for each signal: its literal name, the payload fields you rely on, and the evidence
  that it fires.
- Distinguish a signal that is *absent* from one that is *untriggered*. An absent signal is a
  capability the harness does not expose; an untriggered signal fired and carried no payload.
  They degrade differently and must be recorded differently.
- When a signal's existence is unresolved upstream, resolve it with a probe against the real
  binary and write the verbatim capture to a report, not a summary. A later reader must be
  able to re-check the conclusion.

Load `references/probe-and-degrade.md` when a signal is unconfirmed, when a harness documents no
equivalent, or when you must decide between a heuristic and a deferral.

**Output:** a written signal inventory with evidence status per signal.

### Step 2: Map every signal to exactly one class, in one table

Classes are `needs-you`, `finished` and `fyi`. `fyi` carries a subtype of `error`, `retry`,
`long-tool-call`, `compaction` or `token-burn`. A signal maps to one class or to nothing; it
never maps to two.

- Put the mapping in an exported table, not in a chain of `if` statements. A table is the only
  form that can be asserted exhaustively.
- Signals that produce no event are mapped explicitly to `null`, with the reason recorded. An
  unmapped signal is an accident; a deliberately suppressed one is a decision.
- The domain classifier is the authority. If an adapter's table disagrees with the classifier,
  the classifier wins and the adapter is wrong.

Load `references/mapping-tables.md` for the opencode signal table, the ACP notification table,
and the shared dedupe-key derivation.

**Output:** an exported per-harness mapping table plus a table-driven test over it.

### Step 3: Implement the idle gate with a per-turn work-signal accumulator

This is what separates "finished real work" from "opened, greeted and closed", and it is the
single easiest thing to get subtly wrong.

- Track per turn whether the turn performed at least one tool call, file edit or todo update.
- Report that signal with every idle transition.
- An idle transition whose turn recorded no work produces **no event at all** - not a
  `finished` event, not an `fyi` event.
- Reset the accumulator at the turn boundary. A later empty turn must not be credited with
  earlier work, and two idle transitions separated by a resume must produce two distinct
  finished events.
- Both a modern status transition and a deprecated idle event naming the same transition must
  produce **one** envelope, not two. Map them to the same dedupe key.

**Output:** `src/plugin/opencode/work-signal.ts` with a reset at the turn boundary, plus a test
that crosses a turn boundary.

### Step 4: Derive dedupe keys that hold across pushed and polled signals

A dedupe key is what makes ingest idempotent under replay, so it must be identical whichever way
the signal arrived.

- Derive it from stable identity, never from arrival order, a timestamp of observation, or a
  counter. A key containing a receive-time component changes on replay and defeats the dedupe.
- One block, one key. A repeated permission ask for the same session and block identifier must
  yield the same key, so the second ask produces no second event.
- One idle transition, one key, so the same transition seen by both push and poll collapses.
- The polling fallback reuses these keys exactly. A separate key scheme for polled signals
  produces duplicate events and a double badge increment for one block.

**Output:** one key derivation shared by the pushed and polled paths, asserted by a test that
feeds both and expects one stored event.

### Step 5: Deliver through the existing transport

- Read the live port from the hub's runtime file; never assume the default port.
- Attach the per-install shared token.
- Fire and forget with a short bounded timeout and no retry loop. A busy or wedged hub must
  never slow a calling session.
- Never throw back into the harness. Catch everything.
- When the hub is unreachable, write a breadcrumb through the harness's own structured logging
  client naming the service, the session and the event type, so the failure is visible in the
  harness's interface rather than swallowed.

**Output:** delivery through the shared transport, with the unreachable-hub breadcrumb covered
by a test.

### Step 6: Prove the mapping against the real harness

Unit tests over a table do not prove the harness emits what the table claims. Write a live
script that drives a real session and asserts the envelopes the hub actually received.

- Assert the positive path: a session that reaches a permission decision and then goes idle
  produces a needs-you envelope, a resolution, and exactly one finished envelope with the
  correct repository short name.
- Assert the negative path: a session that opens, greets and closes produces no finished
  envelope.
- Assert the failure path: a hub that is not running produces a breadcrumb rather than a
  silent drop.
- A missing signal must be **reported**, not treated as an empty result. If the polled
  response has an unexpected shape, then report it as a contract change and fail, because an
  empty result hides it behind a session that merely looks idle.
- If an idle transition reports no work, then emit no event at all, because a `finished` or
  `fyi` event for a greeting-and-close turn is a false positive the developer cannot
  distinguish from a real one.
- If an adapter's table and the domain classifier disagree, then fix the adapter table,
  because widening the classifier to accommodate one harness re-opens the rules for every
  harness at once.

Load `references/probe-and-degrade.md` for the three-state degradation table and the wording to
use when reporting a missing signal.

**Output:** a live verification script and its own test against a stub harness.

---

## Gotchas

- **The dedicated permission hook does not fire upstream.** For opencode, `permission.ask` is
  reported as never firing; permission asks are observable only through the generic `event`
  hook. Mapping the dedicated hook produces a build that passes its table test and silently
  never reports a single block.

- **Mapping a modern and a deprecated event to different keys double-counts.** A status
  transition and the deprecated idle event describing the same transition must resolve to one
  envelope. Two keys means two finished events, two badge increments and a confusing history.

- **A work-signal accumulator that never resets credits the wrong turn.** A user who greets,
  closes, reopens and greets again gets a spurious `finished` for the second turn. The reset at
  the turn boundary is the whole point of the accumulator.

- **A dedupe key containing a receive timestamp defeats replay idempotency.** Re-posting the
  same envelope then stores a second event. Derive the key from session identity plus the
  transition or block identifier only.

- **Separate key schemes for pushed and polled signals double every event.** A session that
  both pushes and is polled must collapse to one event. The polling path reuses the pushed
  path's keys, not a parallel derivation.

- **An absent signal treated as an untriggered one hides a real capability gap.** An absent
  signal has no event name to map and must degrade visibly; an untriggered signal fired and
  carried nothing. Collapsing the two makes a heuristic look like a proven mapping.

- **An unexpected polled-response shape silently becomes an empty result.** Parsing
  defensively without reporting turns a contract change into "the session looks idle". Report
  the shape mismatch as a failure.

- **Logging through `console` instead of the harness logging client makes breadcrumbs
  invisible to the developer.** The whole point of the breadcrumb is that it appears in the
  harness's own interface.

- **Letting a transport failure propagate into the harness breaks the user's session.** Every
  failure is caught at the boundary and turned into a breadcrumb.

---

## Validation

Run from the repository root.

```bash
npm test -- tests/plugin/opencode-translate.test.ts tests/plugin/opencode-work-signal.test.ts
npm test -- tests/plugin/poll-fallback.test.ts
npm test -- tests/domain/classify.test.ts
npm test -- tests/scripts/verify-opencode-live.mjs
npm run typecheck
```

Confirm each item:

- [ ] A table-driven test asserts every documented harness event name maps to its expected
      class, subtype and dedupe key, and that no event maps to two classes
- [ ] The table and the domain classifier agree; a disagreement fails the build rather than
      being resolved silently in the adapter's favour
- [ ] A signal deliberately producing no event is mapped explicitly with a recorded reason
- [ ] The deprecated idle event and the status transition produce one envelope rather than two
- [ ] A turn with a tool call, file edit or todo update reports work; a turn with none reports
      no work; the accumulator resets at the turn boundary
- [ ] Two idle transitions separated by a resume produce two finished events; a repeated
      permission ask for one block produces one dedupe key
- [ ] A state already delivered by push is not delivered again by polling
- [ ] An unexpected polled-response shape is reported as a failure rather than an empty result
- [ ] The envelope type has no field able to hold prompt, response or tool output text
- [ ] Logging goes through the harness logging client with this product's service name and
      never writes to the console
- [ ] A transport failure never propagates an exception out of the plugin hook, and a refused
      connection writes a breadcrumb with service, session and event type
- [ ] Every signal in the inventory has an evidence status: observed, absent or unresolved, with
      unresolved signals carrying a probe report and a recorded gate decision

If a test fails, fix the mapping rather than the assertion. The symptom tells you which step
slipped: a duplicated event means the dedupe key is unstable; a missing `finished` means the
work-signal reset or the idle gate is wrong; a silent drop on an unreachable hub means the
breadcrumb path was skipped.
