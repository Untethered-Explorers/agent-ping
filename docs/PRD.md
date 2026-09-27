# PRD: agent-ping

## 1. Overview

**Product Name:** agent-ping
**Summary:** A local-only notification surface that watches long-lived coding-agent sessions across every repository on one machine and tells the developer when a session is blocked on them, when it finished real work, and what else happened, without ever becoming the thing demanding attention. The notification is a card agent-ping renders in its own window; it is never handed to the operating system's notification service.
**Target Platform:** Linux, macOS and Windows desktops, single user, single machine, loopback only.
**Key Constraints:** Node 22+ and TypeScript only; read-only except one ack route; no conversation content stored or transmitted; ACP as the connector interface contract; one surface implementation for all three platforms.
**Historical Sources:** [docs/IDEA.md](IDEA.md) (idea of record, preserved unchanged), [docs/research/model-inventory.json](research/model-inventory.json) (local model inventory, not a requirement source)
**Delivery Decision:** [ADR-012](adr/ADR-012-surface-is-rendered-by-agent-ping.md) supersedes the original "notify through the platform" decision in ADR-009.

---

## 2. Version History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.1 | 2026-09-27 | Track change decided with the user | Notification delivery moved from the platform notification services to a surface agent-ping renders itself. `notify-send`, `osascript` and the PowerShell toast are abandoned; see [ADR-012](adr/ADR-012-surface-is-rendered-by-agent-ping.md). Goals G-1, G-4, G-5, G-6 and every non-goal except the platform-integration one survive unchanged; the delivery *mechanism* behind them does not. |
| 1.0 | 2026-09-26 | forge-auto-build-prd, decided with the user | Initial vision authored from docs/IDEA.md |

---

## 3. Goals and Non-Goals

### 3.1 Goals

- G-1 Surface a blocked session the moment it blocks, and make "something is pending" impossible to lose.
- G-2 Cover every repository from one global install, with no per-repository setup and no registry to drift.
- G-3 Answer "which of my projects is asking for me" on an on-demand PixiJS dashboard grouped by repository.
- G-4 Stay quiet: no sound, no repeat timers, no per-subtask firing, and no always-*visible* surface. The notification host window exists for as long as the hub runs and draws nothing, occupying no screen space, unless a card is actually showing.
- G-5 Remain observably read-only and content-free, so an unauthenticated loopback port cannot become a remote control.
- G-6 Survive hub restarts, logins and harness restarts without losing a pending block.

### 3.2 Non-Goals

- Multi-user, authentication, or any hosted or remote component.
- Supervising agent processes: no spawning, steering, interrupting or killing sessions.
- Any write endpoint other than acknowledging a pending item.
- Approving permissions, sending prompts or any other in-page agent control.
- Transcript history, conversation search, or any stored prompt, response or tool output.
- Sound of any kind.
- A persistently **visible** always-on-top panel: the promotion path if the badge and the card prove too easy to miss. A topmost host window that renders nothing and occupies no screen space is not what this non-goal excludes, and is not in tension with it.
- Integration with the operating system's notification service, notification centre, or focus-assist behaviour on any platform. The surface is rendered by agent-ping.
- Harnesses beyond opencode and GitHub Copilot CLI.
- Mobile or remote clients of any kind.

---

## 4. Personas

| Persona | Description | Key Needs |
|---------|-------------|-----------|
| Multi-repo operator | One developer running several long-lived agent sessions at once across many repositories on one desktop; the only user of the product | Know within seconds which repo needs them, see pending count without being pinged repeatedly, and trust that nothing they typed is stored |

```forge-requirement
{"id":"APX-US-01","kind":"story","text":"As the multi-repo operator, I want one global install to cover every repository I have open, so that no session is invisible because I forgot to configure a repo."}
```

```forge-requirement
{"id":"APX-US-02","kind":"story","text":"As the multi-repo operator, I want to be told once, clearly, when a session is blocked on a decision only I can make, and then left alone until I deal with it."}
```

```forge-requirement
{"id":"APX-US-03","kind":"story","text":"As the multi-repo operator, I want to open the dashboard on my own and immediately see which projects are asking for me, so that checking costs nothing."}
```

---

## 5. Research Findings

Verified against vendor sources on 2026-09-26. Details and citations live with the owning feature.

- opencode loads global plugins from `~/.config/opencode/plugins/` and project plugins from `.opencode/plugins/`; global plugins load for every session regardless of how it was started.
- The opencode plugin `event` hook delivers `session.status`, `session.idle` (deprecated in favour of `session.status` but still emitted), `permission.asked`, `permission.replied`, `session.error`, `session.compacted`, `message.updated`, `tool.execute.before`, `tool.execute.after` and `todo.updated`.
- The `permission.ask` plugin hook is reported as never firing upstream; permission asks are only observable through the generic `event` hook.
- opencode plugins should log through `client.app.log` with a service name rather than writing to the console.
- opencode exposes a local HTTP API including active-session listing, a wait-until-idle route, a permission-request listing route and an idle-transition view marker, which makes a polling fallback possible.
- GitHub Copilot CLI 1.0.83 documents the hook triggers `sessionStart`, `sessionEnd`, `userPromptSubmitted`, `preToolUse`, `postToolUse` and `errorOccurred`; there is no documented idle or permission hook.
- Copilot CLI speaks ACP natively via `copilot --acp` over newline-delimited JSON-RPC on stdio, with a `--port` variant; whether ACP mode emits `session/request_permission` is unresolved upstream, so the "Needs You" class for Copilot is a heuristic until proven otherwise.
- The Agent Client Protocol is at protocol version 1 with a TypeScript SDK, which is what makes a third harness additive rather than a rewrite.

---

## 6. Technical Architecture

### 6.1 Technology Stack

| Component | Choice | Version | Verified |
|-----------|--------|---------|----------|
| Runtime | Node.js | 22.23.3 (LTS line; local 22.22.2) | npm registry |
| Language | TypeScript | 7.0.2 (latest stable) | npm registry |
| Notification surface, tray host and shell | Electron | 44.4.5 (requires Node >= 22.12.0), a **runtime** dependency, not a build-time one | npm registry; window primitives live-verified on the authoring machine |
| Dashboard renderer | PixiJS | 8.21.0 | npm registry |
| Renderer build | Vite | 8.3.1 | npm registry |
| Unit and integration tests | Vitest | 5.0.2 (requires Node ^22.12.0) | npm registry |
| DOM test environment | jsdom | 30.1.1 | npm registry |
| End-to-end tests | Playwright | @playwright/test 1.63.0 | npm registry |
| Durable store | better-sqlite3 | 13.0.3 (requires Node >= 22) | npm registry |
| Payload validation | zod | 4.6.5 | npm registry |
| opencode plugin types | @opencode-ai/plugin | 1.18.32, matching local opencode 1.18.32 | npm registry |
| opencode client | @opencode-ai/sdk | 1.18.32 | npm registry |
| ACP client | @agentclientprotocol/sdk | 1.5.0 (protocol version 1) | npm registry |
| Notification rendering | Plain DOM in an Electron host window; no canvas, no OS notification API | part of the Electron dependency | [docs/research/electron-surface-preflight.json](research/electron-surface-preflight.json) |
| Autostart | systemd user unit, launchd agent, Windows Startup entry | platform facilities | local system |

Electron moved from a build-time consideration to a load-bearing runtime dependency in version 1.1: the tray badge, the notification card and the dashboard window all run inside it. Its Chromium process-sandbox launch policy on an unprivileged per-user install is an open question recorded in §16, not an assumption.

No dependency in this table is deprecated or end-of-life. Where a version could not be verified it is recorded in Open Questions rather than guessed.

```forge-requirement
{"id":"APX-CON-06","kind":"constraint","text":"Platform support is Linux, macOS and Windows in v1, served by one notification surface implementation rather than one per platform. Linux is the only live-verified path on the authoring machine; per-platform differences are limited to documented window-manager behaviour, shipped with scripted checks and documented manual steps, and no macOS or Windows claim is made from a Linux machine."}
```

| ID | Kind | Priority |
|----|------|----------|
| APX-CON-06 | constraint | Must |

### 6.2 Project Structure

Single npm package, one toolchain, three build entry points (Electron main via `tsc`, dashboard via Vite, plugin as directly loadable TypeScript).

```text
src/
  domain/        event model, classification, pending lifecycle, dedupe
  storage/       sqlite schema, migrations, store, retention, counters
  hub/           electron main: loopback http, ingest, sse, delivery, tray wiring
  notify/        notifier interface, class policy, and the self-rendered surface
                 (host window, card model, card view, lifetime policy)
  dashboard/     pixijs renderer, dom mirror, mock prototype data
  plugin/        opencode global plugin and acp copilot adapter
  cli/           agent-ping install, uninstall, doctor, status
scripts/         live verification scripts (opencode session, notification surface,
                 autostart, e2e)
tests/           unit, integration and end-to-end suites mirroring src/
docs/reviews/    human review evidence files
```

### 6.3 Key APIs / Interfaces

Hub HTTP surface, bound to loopback only. Exactly one route mutates state.

| Method | Path | Purpose | Mutating |
|--------|------|---------|----------|
| POST | `/api/ingest` | Accept one normalized harness event; validates, dedupes, classifies, returns 202 | Yes, appends an event |
| POST | `/api/ack/:eventId` | Acknowledge one pending item; the only route that changes an existing record | Yes, ack only |
| GET | `/api/sessions` | Session summaries with state and pending counts | No |
| GET | `/api/sessions/:id` | One session summary with its recent events | No |
| GET | `/api/pending` | Unacked needs-you items, the tray badge source of truth | No |
| GET | `/api/events` | Bounded event history for the dashboard history view | No |
| GET | `/api/metrics` | Local counters backing the success bar | No |
| GET | `/api/health` | Hub, database and plugin delivery status | No |
| GET | `/api/stream` | Server-sent state changes with heartbeat and cursor replay | No |
| GET | `/` and assets | The built dashboard, also opened in an Electron window | No |

Connector interface, specified in ACP terms so a future harness is additive: a normalized event envelope plus a delivery sink. The opencode adapter is the reference implementation of that interface; the Copilot adapter is the second.

```forge-requirement
{"id":"APX-CON-13","kind":"constraint","text":"The connector interface is specified in Agent Client Protocol terms: a harness adapter translates its own events into the normalized envelope and delivers it to the hub, so a third harness is additive work rather than a rewrite of the hub, the store or the dashboard."}
```

```forge-requirement
{"id":"APX-CON-09","kind":"constraint","text":"Identity is the repository short name, which is the directory basename of the session. Sessions nest beneath it and the full path is available on hover or focus but is never the primary label."}
```

| ID | Kind | Priority |
|----|------|----------|
| APX-CON-09 | constraint | Must |
| APX-CON-13 | constraint | Must |

---

## 7. Non-Functional Requirements

Budgets and cross-cutting rules are shared constraints so every feature resolves the same numbers.

```forge-requirement
{"id":"APX-CON-11","kind":"constraint","text":"Performance budgets: hub idle RSS at most 150 MB, local ingest p95 at most 50 ms, dashboard first paint at most 1 s from warm cache, live update visible within 250 ms of an accepted event."}
```

```forge-requirement
{"id":"APX-CON-05","kind":"constraint","text":"One toolchain only: Node.js 22 LTS or newer with TypeScript and npm. No second implementation language and no runtime dependency the supported Node line does not satisfy."}
```

```forge-requirement
{"id":"APX-CON-12","kind":"constraint","text":"No telemetry leaves the machine. Counters, logs and the durable log are local files only, and no outbound network call exists other than to the loopback hub and the harnesses already running on this machine."}
```

| ID | Kind | Priority |
|----|------|----------|
| APX-CON-05 | constraint | Must |
| APX-CON-11 | constraint | Must |
| APX-CON-12 | constraint | Must |

---

## 8. Security and Privacy

```forge-requirement
{"id":"APX-FR-01","kind":"requirement","text":"The system never stores or transmits conversation content: no prompt, response, tool output, file content or diff is written to the durable log, a log file or any outbound request. Only harness, repository short name and full path, session identifier, event class and subtype, timestamps and acknowledgement or resolution state are persisted."}
```

```forge-requirement
{"id":"APX-FR-02","kind":"requirement","text":"A delivery failure is never silent: when the hub is unreachable or an event cannot be stored, the failure is surfaced where the developer will see it, and the durable log records that an event was dropped rather than pretending it was delivered."}
```

```forge-requirement
{"id":"APX-CON-01","kind":"constraint","text":"The hub binds to 127.0.0.1 only and rejects any connection whose remote address is not loopback. The port is treated as security-relevant, not incidental."}
```

```forge-requirement
{"id":"APX-CON-08","kind":"constraint","text":"Exactly one mutating route exists, the ack route, and it can only mark a pending item acknowledged. No route can spawn, steer, interrupt, prompt or approve anything inside a harness."}
```

```forge-requirement
{"id":"APX-CON-03","kind":"constraint","text":"agent-ping is a sidecar. It observes agent processes and never owns them: it must be killable and restartable at any moment without loss, and a repository that was never registered must keep working."}
```

```forge-requirement
{"id":"APX-CON-10","kind":"constraint","text":"Harness delivery is fire-and-forget with a bounded timeout and no retry storm, and when the hub is absent the adapter leaves a visible breadcrumb in the harness's own user interface instead of swallowing the event."}
```

| ID | Kind | Priority |
|----|------|----------|
| APX-FR-01 | requirement | Must |
| APX-FR-02 | requirement | Must |
| APX-CON-01 | constraint | Must |
| APX-CON-03 | constraint | Must |
| APX-CON-08 | constraint | Must |
| APX-CON-10 | constraint | Must |

---

## 9. Accessibility

```forge-requirement
{"id":"APX-CON-07","kind":"constraint","text":"The PixiJS canvas is always paired with a visually hidden but focusable DOM mirror of every visible row, so the dashboard is operable by keyboard and legible to a screen reader. Reduced-motion preferences are honoured, urgency is never encoded by colour alone, and text meets WCAG 2.1 AA contrast against its background."}
```

```forge-requirement
{"id":"APX-CON-04","kind":"constraint","text":"No sound in v1: no audio, no terminal bell, and no sound capability anywhere on the notification path. Because agent-ping renders the card itself rather than handing it to a platform notification service, silence is a property of this product's own renderer rather than a property the operating system may override."}
```

| ID | Kind | Priority |
|----|------|----------|
| APX-CON-07 | constraint | Must |
| APX-CON-04 | constraint | Must |

---

## 10. System States / Lifecycle

Hub states: starting (migrations run, pending rows replayed), running (accepting events, tray present), degraded (database or tray unavailable, ingest still accepted and recorded), stopping (counters flushed, database closed, runtime file removed). A crashed hub is indistinguishable from a stopped one and recovers to running on next start with pending state intact.

Session states as observed, never as owned: unknown, running, blocked (needs you), idle after work (finished), idle after nothing (silent), gone.

Pending item states: pending, resolved by the harness, acknowledged by the developer. Pending survives hub restart; it is cleared by resolution or acknowledgement only.

---

## 11. Analytics / Success Metrics

| Metric | Target | Measurement Method |
|--------|--------|--------------------|
| Unprompted dashboard pull | At least one per week after two weeks of use | `dashboard_opens` counter in the local store |
| Caught sessions | Developer can name specific sessions the tool caught | History view plus review at day 14 |
| Absence of harm | Tool not muted, ignored or uninstalled | No mute control shipped; uninstall path never nagged |
| Notification restraint | Zero repeat toasts per block, zero sound events | `toast_deliveries` counter against `blocks` counter |
| Content safety | Zero content columns, zero content fields in any payload | Schema invariant test plus ingest payload test |

Product-level acceptance:

- A blocked session in any repository produces exactly one toast, one pending item, and a badge count of one, within two seconds of the block.
- Nothing occupies screen space when no session is blocked or finished.
- Killing the hub mid-block and restarting it leaves the pending item and its badge count intact.
- An idle session that did no work produces no toast, no pending item and no history row.
- Two weeks in, the dashboard is opened without being prompted to at least weekly.

---

## 12. Dependencies and Risks

### 12.1 Dependencies

- opencode 1.18.32 plugin API and its event names, plus the local HTTP API used by the polling fallback.
- GitHub Copilot CLI 1.0.83 and ACP protocol version 1, both gated by a live spike before any adapter work.
- Electron 44.4.5 as a runtime dependency: its `BrowserWindow` and `screen` modules for the notification surface and the dashboard window, and its tray and `nativeImage` facilities for the badge. A per-user install's Chromium process-sandbox launch policy on Ubuntu 23.10 and newer is unresolved and recorded in Open Questions.
- The platform status-area or notification-area facilities for the tray icon, which remain an OS integration by design because a status icon is presence, not notification.
- Node.js 22 LTS as the floor for Electron, Vitest and better-sqlite3.

### 12.2 Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Copilot exposes no idle or permission signal | "Needs You" degrades to a heuristic on one harness | Spike first, gate decision recorded before any adapter task |
| The notification surface has never run, because Electron was not a dependency at all | The tray badge and the card could both be unbuildable on the authoring machine | A pre-flight probe proved every window primitive on the authoring machine ([docs/research/electron-surface-preflight.json](research/electron-surface-preflight.json)); NT-6 makes the launch policy an explicit tested decision and NT-9 drives a real window from a script |
| Transparent, always-on-top window compositing differs per window manager | The card could be mispositioned, invisible, or steal focus on one platform | The card is positioned inside the display work area rather than the screen rectangle; `showInactive` avoids focus theft; a missing display or a failed window is a loud failure in the verification script, never a skip |
| Electron footprint and autostart behaviour | A 150 MB dependency for a notification daemon | Single package, no bundled Chromium download beyond the default, autostart is a user-level unit with no root, and the dependency is now explicit rather than assumed |
| Playwright browser download in a locked environment | End-to-end journey evidence unavailable | The dashboard is also served over loopback, so the journey can be driven in an existing browser; script failure is explicit, never silently skipped |
| TypeScript 7 release line | Tooling incompatibility with the test runner or bundler | Pin the exact verified version and record the fallback in Open Questions |
| Plugin API drift on a future opencode release | Silent loss of events | Version check in `doctor`, breadcrumb on delivery failure, pinned plugin package version |

---

## 13. Future Considerations

- A persistently visible always-on-top panel, promoted from deferred to real only if the badge and the card prove too easy to miss.
- Sound, once the signal is trusted, as an opt-in per class. The card is rendered by this product, so sound becomes a decision rather than a platform negotiation.
- Additional harnesses that speak ACP, each additive through the connector interface.
- Session-level grouping beyond the repository short name once multiple windows per repo become common.
- Rich history filtering, still without content.

---

## 14. Features

| # | Feature | File | Dependencies | Priority |
|---|---------|------|-------------|----------|
| 1 | Dashboard Design Prototype | [docs/features/dashboard-design-prototype.md](features/dashboard-design-prototype.md) | None | Must |
| 2 | Event Model and Durable Log | [docs/features/event-model-and-durable-log.md](features/event-model-and-durable-log.md) | None | Must |
| 3 | Hub Core and Delivery Policy | [docs/features/hub-core-and-delivery-policy.md](features/hub-core-and-delivery-policy.md) | Event Model and Durable Log | Must |
| 4 | Notification and Tray Presence | [docs/features/notification-and-tray-presence.md](features/notification-and-tray-presence.md) | Hub Core and Delivery Policy | Must |
| 5 | opencode Plugin Adapter | [docs/features/opencode-plugin-adapter.md](features/opencode-plugin-adapter.md) | Hub Core and Delivery Policy | Must |
| 6 | Live Dashboard | [docs/features/live-dashboard.md](features/live-dashboard.md) | Dashboard Design Prototype, Hub Core and Delivery Policy, Notification and Tray Presence | Must |
| 7 | Install, Autostart and Operations | [docs/features/install-autostart-and-operations.md](features/install-autostart-and-operations.md) | Notification and Tray Presence, opencode Plugin Adapter | Must |
| 8 | Copilot CLI ACP Spike | [docs/features/copilot-cli-acp-spike.md](features/copilot-cli-acp-spike.md) | Hub Core and Delivery Policy | Should |

### Feature Dependency Graph

```text
Dashboard Design Prototype (no prerequisites)
Event Model and Durable Log (no prerequisites)
Hub Core and Delivery Policy
├── Notification and Tray Presence
│   ├── Live Dashboard
│   └── Install, Autostart and Operations
├── opencode Plugin Adapter
│   └── Install, Autostart and Operations
└── Copilot CLI ACP Spike

Live Dashboard also builds on Dashboard Design Prototype.
```

---

## 15. Glossary

| Term | Definition |
|------|------------|
| Block | A session waiting on a permission decision or user input |
| Needs You | Class for a block; the only class that leaves the app |
| Finished | Class for a session that went idle after doing real work |
| FYI | In-app-only class for errors, retries, long tool calls, compaction and token burn |
| Card | The notification this product renders itself, in its own always-on-top window: two lines, the repository short name and one sentence. Never delivered through a platform notification service, notification centre or focus-assist mechanism |
| Surface | The card and the machinery that draws it: the host window, the card model, the DOM view and the lifetime policy |
| Pending item | A needs-you block that is neither resolved by the harness nor acknowledged |
| Badge | The pending count drawn on the tray or menu-bar icon |
| Hub | The local daemon that owns the store, the loopback API, delivery, the surface and the tray |
| Adapter | A connector translating one harness's events into the normalized envelope |
| Envelope | The normalized event record: harness, repo, session, class, subtype, timestamps |
| Sidecar | An observer that can be killed and restarted without loss |
| Deep link | A loopback URL that opens the dashboard focused on one session |

---

## 16. Open Questions

| # | Question | Default Assumption |
|---|----------|--------------------|
| 1 | Does the dashboard design review approve the prototype, or does it force a layout change? | Prototype is accepted with minor changes; a rejection reopens the design feature before Live Dashboard starts |
| 2 | ~~Which exact libnotify hint keeps a toast resident on the target desktops?~~ | **Closed in 1.1.** No platform notification mechanism is used, so there is no hint to choose. Replaced by the surface's own lifetime policy, `NT-FR-02` |
| 3 | ~~Which macOS and Windows mechanism delivers a non-auto-dismissing toast?~~ | **Closed in 1.1.** No platform notification mechanism is used on any platform. Per-platform variance is now limited to window-manager behaviour, covered by `APX-CON-06` |
| 4 | Are the opencode HTTP fallback route shapes and payload fields as documented? | Adapter parses defensively and the live script fails loudly on an unexpected shape |
| 5 | Are ACP notification names for permission and idle as expected? | Spike records the observed names verbatim and the gate decision binds the mapping to that evidence |
| 6 | Does TypeScript 7.0.2 work cleanly with Vitest 5 and the chosen build path? | Pin 7.0.2; fall back to the 5.9.x line only if a concrete incompatibility appears, and record it |
| 7 | Can Playwright browsers be downloaded in the target environment? | Yes on the authoring machine; otherwise the journey is driven in an existing browser against the loopback URL |
| 8 | Which retention numbers keep history useful without unbounded growth? | 30 days and at least the most recent 500 events per session, never pruning an unacknowledged pending item |
| 9 | How is the per-install write token stored and rotated? | Random token in a 0600 file in the state directory, regenerated by reinstall |
| 10 | Default loopback port and collision behaviour? | Fixed default with automatic next-free fallback, the live port written to a runtime file the plugin reads |
| 11 | Can the badge be drawn for arbitrary counts on every desktop? | Counts above 99 render as a capped marker; the count itself is always in the dashboard and `status` |
| 12 | ~~Does the Copilot gate authorise a heuristic "Needs You" for v1?~~ | **Answered 2026-09-27: deferral. v1 ships opencode only.** The ACP permission signal is `observed`, but the per-turn boundary an attaching client would receive is unproven, the documented idle hook type is `unclear` (which the probe's own rule forbids mapping on), and the work-detection the quietness gate depends on was never exercised. See [docs/reviews/CP-3-console-review.md](reviews/CP-3-console-review.md) |
| 13 | What Chromium process-sandbox launch policy does an unprivileged per-user install use? | The pre-flight found that the npm-installed `chrome-sandbox` helper is not usable and the unprivileged user-namespace fallback is blocked by AppArmor on Ubuntu 24.04, so a per-user install must launch with `--no-sandbox`. NT-6 must choose and assert that policy explicitly rather than let the packaged app abort at startup. `webPreferences` `sandbox: true` is a renderer setting and is unaffected |
| 14 | Does a transparent always-on-top window composite correctly under GNOME, KDE and Windows on every target desktop? | Unknown, and the honest answer is now cheap: the surface is one code path, so only the window manager varies. NT-9 proves it on the authoring machine and the runbook records what remains unobserved elsewhere |
| 15 | Should the historical counter name `toast_deliveries` be renamed now that no toast exists? | Deferred. Renaming a persisted counter pulls the content-free schema guard into this track change for no functional gain; ADR-012 records it as a known misnomer and the rename is its own change |

---

## 17. Traceability Matrix

One owning definition per ID. Feature documents reference these IDs; they never restate the text.

| Canonical ID | Kind | Owner | Participating features |
|-------------|------|-------|------------------------|
| APX-US-01 | story | Vision | opencode Plugin Adapter, Install Autostart and Operations |
| APX-US-02 | story | Vision | Notification and Tray Presence, Live Dashboard |
| APX-US-03 | story | Vision | Dashboard Design Prototype, Live Dashboard |
| APX-FR-01 | requirement | Vision | Event Model and Durable Log, Hub Core and Delivery Policy, opencode Plugin Adapter |
| APX-FR-02 | requirement | Vision | Hub Core and Delivery Policy, opencode Plugin Adapter |
| APX-CON-01 | constraint | Vision | Hub Core and Delivery Policy |
| APX-CON-03 | constraint | Vision | opencode Plugin Adapter, Hub Core and Delivery Policy |
| APX-CON-04 | constraint | Vision | Notification and Tray Presence |
| APX-CON-05 | constraint | Vision | Dashboard Design Prototype, Install Autostart and Operations |
| APX-CON-06 | constraint | Vision | Notification and Tray Presence, Install Autostart and Operations |
| APX-CON-07 | constraint | Vision | Dashboard Design Prototype, Live Dashboard |
| APX-CON-08 | constraint | Vision | Hub Core and Delivery Policy, Live Dashboard |
| APX-CON-09 | constraint | Vision | Live Dashboard, Copilot CLI ACP Spike |
| APX-CON-10 | constraint | Vision | opencode Plugin Adapter, Hub Core and Delivery Policy |
| APX-CON-11 | constraint | Vision | Hub Core and Delivery Policy, Live Dashboard |
| APX-CON-12 | constraint | Vision | Event Model and Durable Log, Install Autostart and Operations |
| APX-CON-13 | constraint | Vision | opencode Plugin Adapter, Copilot CLI ACP Spike |
| DP-FR-01..08 | requirement | Dashboard Design Prototype | none, terminal feature |
| EL-FR-01..11 | requirement | Event Model and Durable Log | none, terminal feature |
| HC-FR-01..10 | requirement | Hub Core and Delivery Policy | none, terminal feature |
| NT-FR-01..12 | requirement | Notification and Tray Presence | none, terminal feature |
| OA-FR-01..09 | requirement | opencode Plugin Adapter | none, terminal feature |
| LD-FR-01..11 | requirement | Live Dashboard | none, terminal feature |
| IO-FR-01..09 | requirement | Install Autostart and Operations | none, terminal feature |
| CP-FR-01..07 | requirement | Copilot CLI ACP Spike | none, terminal feature |
