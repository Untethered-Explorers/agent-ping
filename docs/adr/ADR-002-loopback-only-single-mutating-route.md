# ADR-002: Loopback-only hub with exactly one mutating route

- **Status:** Accepted
- **Date:** 2026-09-26
- **Decision owners:** Project author (settled with the user via `forge-grill-idea`)
- **Implementation state:** Not started. No code exists for this decision.

## Context

The hub is a local daemon that accepts events from harness adapters and serves a
dashboard. It listens on a TCP port. It has no authentication, and by design it
never will: the source material is explicit that there is exactly one user, and
that user is the person at the keyboard.

An unauthenticated HTTP service is only defensible when two things are both
true. First, it must be unreachable from off the machine. Second, it must be
incapable of causing harm even if something else on the machine reaches it.

Binding to loopback satisfies the first condition only partially — any process
on the machine, and any browser tab in any browser on the machine, can reach a
loopback port. Modern browsers in particular are a well-known source of
cross-site requests to `127.0.0.1`. So the second condition has to be carried
by the API surface itself.

This makes the port security-relevant rather than incidental, and it makes the
shape of the route table a security control, not just an interface choice.

## Decision

The hub binds to `127.0.0.1` only, and **rejects any connection whose remote
address is not loopback**. It does not bind to `0.0.0.0` or to a wildcard
interface under any configuration.

The HTTP surface is read-only except for **exactly one** mutating route. The
planned route table is:

| Method | Path | Mutating |
|--------|------|----------|
| POST | `/api/ingest` | Yes — appends one event (the adapter's only write) |
| POST | `/api/ack/:eventId` | Yes — ack only; the sole route that changes an existing record |
| GET | `/api/sessions` | No |
| GET | `/api/sessions/:id` | No |
| GET | `/api/pending` | No |
| GET | `/api/events` | No |
| GET | `/api/metrics` | No |
| GET | `/api/health` | No |
| GET | `/api/stream` | No |
| GET | `/` and assets | No |

The binding constraint: **no route may spawn, steer, interrupt, prompt, or
approve anything inside a harness.** Ingest appends; ack marks acknowledged.
Nothing else changes state.

## Alternatives Considered

- **Add authentication (token, passphrase) to the loopback port.** Rejected for
  v1. It adds credential storage and rotation for a threat model — another
  process on the user's own machine — that the read-only surface already
  neutralises. The PRD tracks per-install write-token storage as an open
  question rather than a settled requirement.
- **Use a Unix domain socket instead of a TCP port.** Rejected. The dashboard
  must also be openable in an ordinary browser against a loopback URL, and the
  PRD relies on the dashboard being reachable over loopback as the fallback path
  when Playwright browsers cannot be downloaded. A socket would complicate the
  browser story to solve a problem the read-only surface does not have.
- **Allow in-page permission approval.** Rejected explicitly, and this is the
  decision's sharpest edge. It would make an unauthenticated loopback service
  able to execute code on the user's behalf — reachable by any web page the user
  happens to have open.
- **Bind to all interfaces with a firewall rule.** Rejected. Configuration that
  is correct on one machine and silently wrong on another is not a security
  boundary.

## Consequences

- **Benefit:** The service needs no credentials, so there are no secrets to
  store, rotate, or leak.
- **Benefit:** The worst outcome of a fully compromised agent-ping is disclosure
  of *metadata* — repository names, session identifiers, timestamps — and even
  that is bounded by ADR-003.
- **Cost:** Any future write feature requires reopening this ADR and a real
  threat model. This is intended friction, not an oversight.
- **Cost:** Cross-origin browser requests to the hub must be considered
  explicitly, since a loopback port is reachable from any page. This ADR fixes
  *what* the routes can do; the concrete origin-handling policy is a
  build-time concern tracked in the hub feature document's open questions.
- **Operational implication:** The port is a security control, so changing it,
  exposing it, or reverse-proxying agent-ping changes the threat model. The PRD
  defers the default port and collision behaviour to an open question; a
  fixed default with next-free fallback and a runtime file the plugin reads is
  the recorded default assumption, not a shipped behaviour.
- **Note on delivery semantics:** adapter-to-hub ingest is specified as
  fire-and-forget with a bounded timeout. This is at-least-once-with-dedupe
  intent, **not** transport-level exactly-once delivery. Deduplication happens
  in the hub against a dedupe key, not in transit.

## Implementation References

- Requirements: [APX-CON-01](../PRD.md#8-security-and-privacy),
  [APX-CON-08](../PRD.md#8-security-and-privacy),
  [APX-FR-02](../PRD.md#8-security-and-privacy).
- Planned API surface: [PRD §6.3 Key APIs / Interfaces](../PRD.md#63-key-apis-interfaces).
- Open questions on port default, collision behaviour, and write-token storage:
  [PRD §16 Open Questions](../PRD.md#16-open-questions) items 9 and 10.
- Originating rationale: [IDEA.md — Boundaries](../IDEA.md#boundaries), which
  names the port as security-relevant.
- Planned source locations (**do not exist yet**): `src/hub/`.
  Feature document: [Hub Core and Delivery Policy](../features/hub-core-and-delivery-policy.md).
