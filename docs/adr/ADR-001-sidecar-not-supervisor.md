# ADR-001: agent-ping is a sidecar, never a supervisor

- **Status:** Accepted
- **Date:** 2026-09-26
- **Amended:** 2026-09-27 by [ADR-012](ADR-012-surface-is-rendered-by-agent-ping.md) — the
  notification command is no longer one of the spawn sites, because the surface is
  rendered by this product and spawns nothing
- **Decision owners:** Project author (settled with the user via `forge-grill-idea`)
- **Implementation state:** Implemented, and structural rather than policed.
  Nothing under `src/` names a harness or agent process as something to start,
  signal or attach to. After ADR-012 the product spawns a process in exactly
  one place: the plugin installer's verification child
  (`src/plugin/install/global-plugin.ts`). The toast command
  (`src/notify/command.ts`) is removed by NT-8, and the notification path
  spawns nothing at all — a card is drawn, not delegated. The remaining
  `process.kill(pid, 0)` in `src/hub/runtime-file.ts` is a liveness probe on a
  previous *hub* pid, not a signal. A killed hub is reclaimed and restarted
  against the same log (`tests/hub/delivery.test.ts` does this with a real
  `SIGKILL` of a real child process).

## Context

The product watches long-lived coding-agent sessions so the developer knows when
one is blocked on them. The tempting scope for a tool like this is to also
*manage* those sessions — start them, steer them, cancel them, approve
permissions on their behalf.

That scope is what makes such a tool dangerous rather than merely annoying. A
component that can both observe and act on an agent process is a component that
can act on the user's behalf. It also inverts the trust relationship: the user
must now trust the notifier before they can trust their agent, which is the
opposite of what a notification tool is for.

The product also has a hard availability requirement. A missed "needs you"
block is the exact failure the product exists to prevent, so the notification
path must not be able to introduce a new way for a session to break.

## Decision

agent-ping **observes** agent processes and never **owns** them.

Concretely, this decision binds the following:

- agent-ping will not spawn, steer, interrupt, kill, or attach to an agent
  process as a means of controlling it. Handoff to a live session is the
  developer's own action (`opencode attach <url>`, or their own terminal), not
  a capability the hub provides.
- agent-ping must be killable and restartable at any moment without loss. A
  running agent session must behave identically whether agent-ping is running,
  dead, or was never installed.
- A repository that was never registered or configured must keep working
  normally. There is no registration step whose absence can break a session.
- Delivery from an adapter to the hub is bounded and non-blocking. A slow or
  absent hub must never add latency to, or fail, a harness session.

## Alternatives Considered

- **Supervisor / process manager.** Rejected. It would make the notification
  surface a control surface, and would put agent availability behind
  agent-ping's availability — the exact inversion described in Context. It also
  directly conflicts with the read-only posture recorded in ADR-002.
- **Register each repository explicitly.** Rejected in favour of the global
  install in ADR-006, because a registration step is a step that can be
  forgotten, and a forgotten registration is an invisible session.
- **Retry delivery until the hub accepts.** Rejected. Retry storms from many
  concurrent agent sessions would be a self-inflicted denial of service against
  the developer's own machine. Failure handling is specified in ADR-010.

## Consequences

- **Benefit:** The blast radius of any agent-ping defect is bounded to
  notification quality. A completely broken agent-ping costs the user their
  notifications, not their work.
- **Benefit:** No authentication story is needed, because nothing valuable is
  exposed. This is what makes the loopback port in ADR-002 defensible.
- **Benefit:** The product can be uninstalled at any moment with no cleanup
  ritual inside any agent session.
- **Cost:** agent-ping cannot help the user *unblock* a session. The user must
  switch to the harness themselves. The product answers "which project is
  asking for me", not "resolve this for me".
- **Cost:** Because the hub is not in the session's lifecycle, the hub can be
  absent while sessions run. This is accepted, and is the reason ADR-010
  requires visible failure rather than silence.
- **Risk:** If a future change adds any write path that reaches into a harness,
  this ADR must be reopened rather than quietly amended. Approving a
  permission from an unauthenticated loopback page is the specific case the
  source material calls out as the reason it is deferred.

## Implementation References

- Requirements: [APX-CON-03](../PRD.md#8-security-and-privacy) — sidecar
  constraint. [APX-CON-01](../PRD.md#8-security-and-privacy) and
  [APX-CON-08](../PRD.md#8-security-and-privacy) — loopback and single
  mutating route. [APX-CON-10](../PRD.md#8-security-and-privacy) — bounded
  delivery.
- Goals and non-goals: [PRD §3](../PRD.md#3-goals-and-non-goals) explicitly
  excludes supervising agent processes.
- Originating rationale: [IDEA.md — How It Connects](../IDEA.md#how-it-connects)
  and [IDEA.md — Boundaries](../IDEA.md#boundaries).
- Source locations: `src/hub/`, `src/plugin/`, `src/notify/`. The single
  mutating route this decision bounds is
  [`POST /api/ack/:eventId`](ADR-002-loopback-only-single-mutating-route.md);
  the route registry in `src/hub/server.ts` refuses at registration time to
  accept a second control surface.
