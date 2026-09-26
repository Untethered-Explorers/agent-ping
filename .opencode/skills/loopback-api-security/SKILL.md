---
name: loopback-api-security
description: "Apply and test agent-ping's loopback-only security boundary. Covers binding 127.0.0.1, rejecting non-loopback remote addresses, requiring the per-install token on the single write route, sending a strict content-security-policy with no permissive cross-origin header, and enumerating registered routes to prove ack is the only mutation. Use when adding a route, changing the server bind, adding a header, wiring the ack write route, or when changing the loopback boundary in agent-ping."
---

# Skill: Loopback API Security

An apparently local daemon on a permissive port is a remote control. agent-ping's boundary has
four independent layers - bind, address check, per-install token on the write route, and a
strict CSP with no permissive cross-origin header - plus one proof obligation: the set of
mutating routes is exactly `{ack}`. Every layer needs a test, because each fails silently on
its own.

---

## Process

### Step 1: Keep the bind address explicit and non-negotiable

- Bind `127.0.0.1` only. Never `0.0.0.0`, never a hostname that resolves wider.
- The port is security-relevant, not incidental. If the default port is taken, then fall back to
  the next free loopback port and record the live port in the runtime file that adapters read. If
  you are tempted to bind wider to avoid a collision, then you have inverted the security
  property to fix an inconvenience - do not.
- Test the fallback by occupying the default port and asserting the next free port is used
  **and recorded**, then released on shutdown.

**Output:** a bound loopback server whose live port is discoverable through the runtime file.

### Step 2: Reject non-loopback remote addresses

Binding to loopback is not sufficient on its own; a proxy, a container port mapping or a
forwarded socket can still deliver a request whose remote address is not loopback. Check the
actual remote address of every request and refuse anything that is not loopback.

- Compare the resolved address, not the string. `127.0.0.1`, `::1` and `::ffff:127.0.0.1` are
  loopback; `0.0.0.0`, a LAN address and an empty remote address are not.
- Refuse before any handler runs, so a refused request cannot reach a read or write path.
- Do not treat a forwarded header as the client's address. Honouring `X-Forwarded-For` here
  re-opens the boundary the check exists to close.

**Output:** an address check ahead of routing, with a test for each rejected shape.

### Step 3: Require the per-install token on the write route

The token lives in a `0600` file in the owner-only state directory, and is regenerated on
reinstall. It is required on the write route only.

- A write without the token is refused. A write with the wrong token is refused. Both are
  refused before the handler touches state.
- Read routes stay unauthenticated. They carry no content and the boundary exists to keep the
  port from being a control surface, not to hide session state from the local user.
- The comparison should not leak timing information, and the token must never appear in a log
  line, an error body or a URL query string.
- Do not accept the token in a query parameter. It lands in access logs and in the browser
  history for any request the dashboard makes.

**Output:** a token check scoped to the write route, with tests for missing and wrong tokens.

### Step 4: Send a strict CSP and no permissive cross-origin header

- Send a strict `content-security-policy` with the dashboard response.
- Send **no** permissive cross-origin header. No `Access-Control-Allow-Origin: *`. A read-only
  daemon still hands a cross-origin page a channel to it.
- A CSP conflict is resolved by **narrowing the policy**, never by adding `unsafe-inline` or
  `unsafe-eval`. If the PixiJS bundle needs something the current policy forbids, the fix is a
  tighter directive set or a different mechanism, not a weakened policy.
- Keep the policy in one named constant so the test and the server cannot disagree about what
  is sent.

**Output:** one strict policy constant, asserted on the real dashboard response.

Load `references/csp-and-tokens.md` when the PixiJS bundle conflicts with the policy, when
choosing the directive set, or when a browser feature appears to need a relaxed directive.

### Step 5: Prove the mutating route set is exactly `{ack}`

This is the proof obligation and it is a test, not a review.

- Enumerate every registered route at runtime and, for each one, compare stored pending and
  event counts before and after a request. Assert the ack route is the only one that changes
  stored state.
- Refuse every other mutating method or path with method-not-allowed or not-found. `PUT`,
  `DELETE` and `PATCH` on any path must not mutate.
- Assert by test that **no** route can spawn, steer, interrupt, prompt or approve anything in a
  harness. This is a promise about the whole surface, so it needs a negative test over the
  enumerated set, not a comment.
- The ack route may only mark a pending item acknowledged. It answers not-found for an unknown
  identifier and conflict for an already resolved item, and it changes nothing else.

Load `references/route-inventory.md` for the route table, the expected mutating set, and the
enumeration test to copy.

**Output:** a route-enumeration test that fails when any second mutating route appears.

### Step 6: Verify the boundary end to end, over a real socket

Boot the real entry point against a temporary state directory and exercise the boundary over a
real loopback socket. Assertions against a mocked request object do not exercise the address
check, because the address comes from the socket.

- Read the port from the runtime file, then make real requests.
- Assert a second instance refuses to start while the first holds the runtime file.
- Assert no read route changes stored state, by comparing pending and event counts around every
  read.

**Output:** a boundary test over real sockets, not mocks.

---

## Gotchas

- **A route added without re-running the enumeration test becomes a second mutating route.**
  The enumeration test is the only thing that notices, and it only runs if it is in the
  validation command for the task. A new route with no test is a silent second control surface.

- **Binding to `0.0.0.0` to dodge a port collision inverts the security property.** The
  correct response is the next free loopback port recorded in the runtime file. A wider bind
  trades a security boundary for a startup convenience.

- **A string comparison of the remote address accepts `::ffff:127.0.0.1` inconsistently and
  rejects some genuine loopback forms.** Compare the resolved address class. An IPv4-mapped
  loopback address is loopback.

- **Trusting `X-Forwarded-For` as the client address re-opens the boundary.** The check exists
  because a proxy can deliver a non-loopback peer; honouring a caller-supplied address header
  defeats it.

- **Putting the token in a query string leaks it into logs and history.** It also survives in a
  copied URL. Send it in a request header.

- **Adding `unsafe-inline` to make a CSP conflict go away is the wrong fix.** Narrow the policy
  or change the mechanism. A weakened policy is invisible in review and permanent in the
  shipped header.

- **`Access-Control-Allow-Origin: *` on a read route is still a hole.** The daemon is
  unauthenticated on read, so any page the developer visits can read session state through the
  browser. Send no permissive cross-origin header at all.

- **A CSRF-shaped write from a page the developer is already visiting succeeds** if the token
  check is the only defence and the token is readable by that page. Keeping the token out of
  the served dashboard bundle is part of the boundary.

- **Testing the address check with a mocked request skips the check entirely.** A fabricated
  request object has whatever remote address the test set. The check reads the socket.

- **Read routes that mutate incidentally break the "observably read-only" promise.** Counting
  a dashboard open, recording a deep link or snapshotting a pending count mutates. Those belong
  on explicitly accounted paths, and the before-and-after count comparison will find them.

---

## Validation

Run from the repository root. Boot against a temporary state directory; never point these tests
at a real installation's state.

```bash
npm test -- tests/hub/server.test.ts tests/hub/security.test.ts tests/hub/ack.test.ts
npm test -- tests/hub/metrics.test.ts
npm run typecheck
```

Confirm each item:

- [ ] The server binds `127.0.0.1` and never a wildcard address
- [ ] Occupying the default port results in the next free loopback port being used, recorded in
      the runtime file, and released on shutdown
- [ ] A request whose remote address is not loopback is refused before reaching any handler, and
      `::ffff:127.0.0.1` is correctly accepted
- [ ] A forwarded address header is not treated as the client's address
- [ ] A write with no token and a write with a wrong token are both refused, and neither
      changes stored state
- [ ] Read routes stay unauthenticated
- [ ] The token never appears in a log line, an error body or a URL query string
- [ ] The dashboard response carries a strict `content-security-policy` and no permissive
      cross-origin header
- [ ] The CSP contains no `unsafe-inline` and no `unsafe-eval`
- [ ] A test enumerates every registered route and asserts the ack route is the only one that
      changes stored state
- [ ] `PUT`, `DELETE` and `PATCH` on every path are refused with method-not-allowed or
      not-found
- [ ] The enumerated route set contains nothing that can spawn, steer, interrupt, prompt or
      approve anything in a harness
- [ ] An unknown identifier answers not-found and an already resolved item answers conflict,
      neither changing state
- [ ] A second instance refuses to start while the first holds the runtime file
- [ ] Pending and event counts are unchanged around every read request

If an assertion fails, fix the boundary rather than the test. A security test edited to pass
has inverted its purpose. The symptom points at the layer: an enumeration failure means a second
mutating route exists; a CSP failure means the policy was weakened; an address failure means the
check runs after routing instead of before it.
