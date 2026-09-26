# Project Idea

## The Idea

Developers and power users often run several long-lived agent sessions at once,
across several repositories, and lose track of them. A local-only, PixiJS-rendered
notification surface watches those sessions and tells you when one has finished or
when one is blocked waiting on you — quietly enough that you are willing to leave
it running.

The original framing was "a connector installed in every repo." That is now
settled as something better: installed once, globally, covering every repo.

## Who It Is For

One person, on one machine, on loopback. Not a team product, not a hosted
service, not a remote agent monitor. There is no auth because there is only one
user, and that user is the person sitting at the keyboard.

## Scope

Two harnesses, one connector interface:

- **opencode** — instrumented natively via its plugin API.
- **GitHub Copilot CLI** — instrumented as a second adapter, using ACP (Agent
  Client Protocol) as the shared interface contract.

`opencode acp` and `copilot --acp` both speak ACP, and opencode additionally
exposes a native HTTP API with an event stream. The connector interface is
specified in ACP terms so a future harness is additive rather than a rewrite, but
opencode's native feed is preferred because it reports idle and permission events
precisely rather than by inference.

"Multiple repos" is satisfied by N opencode servers/plugins across N repos — not
by supporting N harnesses.

## How It Connects

A local hub process on loopback. A globally installed opencode plugin
(`~/.config/opencode/plugins/`) forwards session events to that hub. This works no
matter how a session is started — TUI, `opencode run`, `opencode attach` — and
requires no per-repository setup, so there is no registry to drift out of sync
with reality. Polling the opencode session store is an explicit fallback for
anything that cannot push.

**agent-ping observes agent processes; it never owns them.** It is a sidecar that
can be killed and restarted at any time without loss, and a repo that was never
registered still works.

## What Earns An Interruption

Three classes, with different loudness. The design constraint is that the tool
must never become the thing demanding attention.

| Class | Trigger | Delivery |
|---|---|---|
| **Needs You** | Session blocked on a permission decision or user input | OS toast, never auto-dismiss, repeats until acknowledged |
| **Finished** | Session went idle after doing real work | One notification per idle transition, then silent until the session resumes |
| **FYI** | Errors, retries, long tool calls, compaction, token burn | In-app only, never escapes the app |

Additional rules, all deliberate:

- A session that goes idle having done nothing — opened, greeted, closed — fires
  nothing at all.
- No sound in v1. Sound is the fastest route to becoming the notification people
  kill, and it is trivially added later once the signal is trusted.
- "Task done" and "session complete" are not separate events. Per-subtask firing
  is exactly the noise this tool exists to avoid.

## Where The Surface Lives

On demand, not always on screen. The hub is a daemon; the notification is an OS
toast (`notify-send`, X11) that deep-links into a local PixiJS page. Nothing
occupies screen real estate until something actually happens.

An always-on-top ambient panel is the explicit v2 if toasts prove too easy to
miss. Choosing on-demand does not defer the PixiJS work — PixiJS renders the
dashboard you land on. What is deferred is pinning it to the screen permanently.

## Boundaries

- **Read-only.** The dashboard shows state; clicking a session hands off via
  `opencode attach <url>` or the user's terminal. No write endpoints at all.
  Approving permissions from the page is deferred precisely because it would make
  an unauthenticated loopback service able to execute code on the user's behalf.
- **No content storage, ever.** agent-ping persists *that* something happened,
  never *what* was said. The durable log holds session summaries and notification
  events — repo, harness, session id, class, timestamp, acked/unacked — and no
  prompts, responses, tool output, or file content. It is not a second copy of
  everything the agents read and wrote.
- **Identity** is the repository short name, with sessions nested beneath it and
  the full path available on hover. The dashboard's question is "which of my
  projects is asking for me", which is a repo-level question.
- **The loopback port is security-relevant**, not incidental — especially if
  write endpoints are ever added.

## Availability Contract

The hub autostarts on login via a systemd user unit. The failure mode must never
be silence, since a missed "Needs You" is the exact problem this tool exists to
prevent. So the plugin's delivery is fire-and-forget with an explicit visible
failure: when the hub is absent, the plugin leaves a breadcrumb in the harness's
own UI rather than swallowing the event.

## Success

After two weeks of use, the bar is **absence of harm**: the tool has not been
muted, ignored, or uninstalled, and the user can name specific sessions it caught
that would otherwise have been missed. The leading indicator is **unprompted
pull** — opening the dashboard without having been prompted to.

A tool that is merely tolerable fails this bar. Only one that is actively reached
for survives, and this is the only formulation that is falsifiable by behavior
rather than by memory.

## Non-Goals

Explicitly out of scope for v1, listed so they are not quietly smuggled back in:

- Multi-user, auth, or any hosted/remote component.
- Agent process supervision — spawning, steering, or killing sessions.
- Write endpoints: approving permissions, sending prompts, remote control.
- Full transcript history or search over conversation content.
- Sound.
- An always-on-top ambient window (deferred to v2, not rejected).
- Supporting harnesses beyond opencode and Copilot CLI.

## Open Questions

**What the dashboard looks like.** Layout, density, how urgency is encoded, and
whether motion helps or adds noise cannot be settled by discussion — two designs
can both satisfy every requirement above while one is clearly better in the hand.
Left open on purpose. The smallest thing that settles it: a single static page
with three hardcoded mock rows rendered in PixiJS, no hub, no plugin, no real
data — roughly 150 lines, and ninety seconds of looking. This should be built
first, before any connector work.

**Whether Copilot's hooks report idle and permission events.** Copilot CLI 1.0.83
has a plugin system with hooks, so the push architecture is very likely viable
for it, but it is unverified that its hook surface exposes equivalents to
`session.idle` and `permission.asked`. If it does not, the Copilot adapter must
infer them and the "Needs You" class degrades to a heuristic on that harness
only. This is a spike to run early, not a design decision.

---

> Generated by forge-launcher on 2026-09-26T08:58:17Z
> Sharpened by @forge-grill-idea on 2026-09-26 — decisions above settled with the
> user; Open Questions deliberately unresolved.
> Use this file as input for: `@workspace /forge-auto-build-prd Use docs/IDEA.md as the project idea`
