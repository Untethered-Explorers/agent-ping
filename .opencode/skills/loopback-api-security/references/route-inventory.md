# Route inventory and the mutating-set proof

> Load when adding or changing a route, when a read route turns out to need to record
> something, or when the route-enumeration test fails.

## The surface

Exactly one route mutates existing state. `/api/ingest` appends an event, which is a create,
not a change to an existing record; every other write-shaped behaviour is refused.

| Method | Path | Purpose | Mutating |
|--------|------|---------|----------|
| POST | `/api/ingest` | Accept one normalized envelope; validates, dedupes, classifies, answers 202 | Appends an event |
| POST | `/api/ack/:eventId` | Acknowledge one pending item | **Yes, ack only** |
| GET | `/api/sessions` | Session summaries with state and pending counts | No |
| GET | `/api/sessions/:id` | One session summary with its recent events | No |
| GET | `/api/pending` | Unacked needs-you items; the tray badge source of truth | No |
| GET | `/api/events` | Bounded event history for the dashboard history view | No |
| GET | `/api/metrics` | Local counters backing the success bar | No |
| GET | `/api/health` | Hub, database and plugin delivery status | No |
| GET | `/api/stream` | Server-sent state changes with heartbeat and cursor replay | No |
| GET | `/` and assets | The built dashboard | No |

The mutating set the test asserts is exactly `{POST /api/ack/:eventId}` plus the documented
`POST /api/ingest` append.

## What ack may and may not do

May: mark one pending item acknowledged, through the pending lifecycle.

- Unknown identifier answers not-found.
- An already resolved item answers conflict.
- It changes nothing else - not the event class, not the session state, not the counts.

May not: spawn, steer, interrupt, prompt or approve anything inside a harness. There is no
route anywhere in the surface that does this, and the enumeration test asserts that.

## The enumeration test

The proof obligation. It walks the real registry rather than a hand-written list, so a route
added without updating the test still gets caught.

```ts
it('ack is the only route that changes stored state', async () => {
  for (const route of registry.routes()) {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      const before = await counts();
      const res = await request(method, route.pattern, sampleFor(route, method));
      const after = await counts();

      if (route.pattern === '/api/ack/:eventId' && method === 'POST') continue;
      if (route.pattern === '/api/ingest' && method === 'POST') continue;

      expect({ route: route.pattern, method, before, after },
        `${method} ${route.pattern} mutated state`).toEqual({
          route: route.pattern, method, before, after,
        });
      expect(res.status, `${method} ${route.pattern} should be refused`)
        .toMatch(/^(404|405)$/);
    }
  }
});
```

Two details make this test real:

- `registry.routes()` is the server's actual registration list. A hand-written list passes
  forever regardless of what is registered.
- The refused-status assertion catches a route that returns 200 while changing nothing, which
  is how a "harmless" write slips in and later grows a body.

## The no-agent-control assertion

Separate, because it is a promise about intent rather than about state.

```ts
const FORBIDDEN_ACTIONS = /spawn|steer|interrupt|prompt|approve|send|kill|resume|steer/i;

it('no route exposes agent control', () => {
  for (const route of registry.routes()) {
    expect(`${route.method} ${route.pattern} ${route.name}`).not.toMatch(FORBIDDEN_ACTIONS);
  }
});
```

The dashboard is subject to the same rule from the other side: it must contain no control that
sends, interrupts or approves anything in a harness. Handoff exposes the attach command as text
to copy, which is a read, not a control.

## Reads that mutate incidentally

Three counters are incremented from real request paths: dashboard opens when a dashboard client
connects, deep-link opens when a deep link is resolved, and notification deliveries when the
delivery pipeline reports an outcome, plus a pending-count snapshot whenever the pending set
changes.

Two things about the third counter are easy to get wrong. Its persisted name is still
`toast_deliveries`, a deliberate misnomer left in place by ADR-012 so that renaming a stored
counter did not have to happen in the same change as replacing the delivery mechanism. And a
**refused** outcome must never increment it: a class that never renders a card is not a
delivery. The counter that backs the "notification restraint" success metric is only
meaningful if refused and delivered are distinguishable.

These are real writes on read paths, which makes them a genuine tension with "read routes do
not mutate state". Resolve it explicitly rather than by loosening the test:

- Keep counters in a separate table, and have `counts()` in the enumeration test sum only the
  events and pending tables, not counters. State that choice in the test's name or comment.
- Do not add a new incidental write to a read route without extending that separation. A read
  route that starts rewriting a session row breaks the promise the enumeration test enforces.

## Adding a route

1. Decide the class. A read needs no token; a write needs the token and must justify itself
   against the exactly-one-mutating-route promise.
2. Register it, then update the enumeration test's skip list if it is genuinely permitted to
   write. Do not widen the skip list past the ack route and ingest without changing the
   promise, its requirement reference and its test together.
3. Add the refused-method cases. `PUT`, `PATCH` and `DELETE` on the new path must be refused.
4. Re-run the boundary suite. Adding a route without re-running it is how a second mutating
   route appears in a release.
