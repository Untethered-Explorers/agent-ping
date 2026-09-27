# Project Progress

## Current State
**Phase**: COPILOT-CLI-ACP-SPIKE-1
**Status**: In Progress
**Validation Gaps**: 82 unverified check(s) - see "Validation Gaps"
**Last Updated**: 2026-09-27T11:41:45.572Z
**Run ID**: 7d107e32-e0b5-4a61-9b30-c0c01b5ddbd8
**Harness**: opencode
**Execution Mode**: auto

## Completed Tasks
- [x] Phase DASHBOARD-DESIGN-PROTOTYPE-1, Task DP-1: Establish toolchain and test-runner convention (@tooling-engineer)
  - Files: package.json, tsconfig.json, vitest.config.ts, eslint.config.js, tests/tooling/runner-convention.test.ts, .gitignore, package-lock.json, scripts/build.mjs, scripts/run-tests.mjs, tsconfig.build.json
- [x] Phase DASHBOARD-DESIGN-PROTOTYPE-1, Task DP-2: Render the static mock dashboard page (@dashboard-engineer)
  - Files: vite.config.ts, src/dashboard/prototype/index.html, src/dashboard/prototype/main.ts, src/dashboard/prototype/scene.ts, src/dashboard/prototype/mock-data.ts, tests/dashboard/prototype-scene.test.ts, package-lock.json, package.json, tsconfig.json
- [x] Phase DASHBOARD-DESIGN-PROTOTYPE-1, Task DP-3: Add non-colour urgency encoding, keyboard order and the DOM mirror (@dashboard-engineer)
  - Files: src/dashboard/prototype/main.ts, src/dashboard/a11y/dom-mirror.ts, src/dashboard/a11y/keyboard-nav.ts, src/dashboard/theme/motion.ts, tests/dashboard/dom-mirror.test.ts, tests/dashboard/keyboard-nav.test.ts, tests/dashboard/prototype-scene.test.ts, tests/dashboard/prototype-harness.ts
- [x] Phase DASHBOARD-DESIGN-PROTOTYPE-2, Task DP-4: Review the static prototype as a design artefact
  - Files: docs/reviews/dashboard-design.json
- [x] Phase EVENT-MODEL-AND-DURABLE-LOG-1, Task EL-1: Create the content-free schema and store API (@domain-engineer)
  - Files: src/storage/schema.sql, src/storage/db.ts, src/storage/paths.ts, src/storage/eventStore.ts, tests/storage/schema.test.ts, tests/storage/eventStore.test.ts, package-lock.json, package.json
- [x] Phase EVENT-MODEL-AND-DURABLE-LOG-1, Task EL-2: Add retention pruning and local counters (@domain-engineer)
  - Files: src/storage/retention.ts, src/storage/counters.ts, tests/storage/retention.test.ts, tests/storage/counters.test.ts, tests/storage/eventStore.test.ts
- [x] Phase EVENT-MODEL-AND-DURABLE-LOG-2, Task EL-3: Define the envelope and the classification rules (@domain-engineer)
  - Files: src/domain/envelope.ts, src/domain/classify.ts, tests/domain/classify.test.ts
- [x] Phase EVENT-MODEL-AND-DURABLE-LOG-2, Task EL-4: Implement the pending lifecycle state machine (@domain-engineer)
  - Files: src/domain/pending.ts, tests/domain/pending.test.ts, src/storage/eventStore.ts, tests/domain/classify.test.ts, tests/storage/eventStore.test.ts
- [x] Phase HUB-CORE-AND-DELIVERY-POLICY-1, Task HC-1: Stand up the hub process and its read routes (@hub-engineer)
  - Files: src/main/index.ts, src/hub/server.ts, src/hub/routes/read.ts, src/hub/runtime-file.ts, tests/hub/server.test.ts, src/storage/eventStore.ts, tests/storage/eventStore.test.ts, tests/hub/fixtures/measure-idle-rss.mjs, tests/hub/fixtures/second-instance.mjs, tests/hub/fixtures/ts-resolver.mjs
- [x] Phase HUB-CORE-AND-DELIVERY-POLICY-1, Task HC-2: Add the live state stream with heartbeat and cursor replay (@hub-engineer)
  - Files: src/hub/sse.ts, src/hub/routes/stream.ts, tests/hub/stream.test.ts, src/hub/routes/read.ts, src/main/index.ts, tests/hub/server.test.ts, tests/hub/fixtures/measure-stream-rss.mjs
- [x] Phase HUB-CORE-AND-DELIVERY-POLICY-1, Task HC-3: Build the ingest route and event pipeline (@hub-engineer)
  - Files: src/hub/routes/ingest.ts, src/hub/ingest-service.ts, tests/hub/ingest.test.ts, src/hub/routes/read.ts, src/hub/server.ts, src/main/index.ts, tests/hub/server.test.ts
- [x] Phase HUB-CORE-AND-DELIVERY-POLICY-2, Task HC-4: Add the ack-only write surface and its security boundary (@hub-engineer)
  - Files: src/hub/routes/ack.ts, src/hub/security.ts, tests/hub/ack.test.ts, tests/hub/security.test.ts, src/hub/routes/read.ts, src/hub/server.ts, src/main/index.ts, tests/hub/server.test.ts
- [x] Phase HUB-CORE-AND-DELIVERY-POLICY-2, Task HC-5: Implement delivery policy, restart replay and clean shutdown (@hub-engineer)
  - Files: src/hub/delivery.ts, src/hub/lifecycle.ts, tests/hub/delivery.test.ts, tests/hub/lifecycle.test.ts, src/hub/routes/read.ts, src/main/index.ts, tests/hub/security.test.ts, tests/hub/server.test.ts, tests/hub/fixtures/hub-process.ts, tests/hub/fixtures/signal-hub.mjs
- [x] Phase HUB-CORE-AND-DELIVERY-POLICY-2, Task HC-6: Expose the local metrics surface (@hub-engineer)
  - Files: src/hub/metrics.ts, src/hub/routes/metrics.ts, tests/hub/metrics.test.ts, src/hub/delivery.ts, src/hub/routes/read.ts, src/hub/server.ts, src/main/index.ts
- [x] Phase HUB-CORE-AND-DELIVERY-POLICY-3, Task HC-7: Review the hub read-only promise and restart safety
  - Files: docs/reviews/hub-core.json
- [x] Phase NOTIFICATION-AND-TRAY-PRESENCE-1, Task NT-1: Define the notifier interface and the Linux notifier (@notification-engineer)
  - Files: src/notify/types.ts, src/notify/policy.ts, src/notify/linux.ts, src/notify/registry.ts, src/main/index.ts, tests/notify/policy.test.ts, tests/notify/linux.test.ts, tests/notify/registry-selection.test.ts, tests/hub/delivery.test.ts, tests/hub/ingest.test.ts, tests/hub/metrics.test.ts, tests/hub/server.test.ts
- [x] Phase NOTIFICATION-AND-TRAY-PRESENCE-1, Task NT-2: Add the macOS and Windows notifiers (@notification-engineer)
  - Files: src/notify/macos.ts, src/notify/windows.ts, tests/notify/macos.test.ts, tests/notify/windows.test.ts, docs/runbooks/notify-platforms.md, src/main/index.ts, src/notify/linux.ts, src/notify/registry.ts, src/notify/types.ts, tests/notify/registry-selection.test.ts, src/notify/command.ts
- [x] Phase NOTIFICATION-AND-TRAY-PRESENCE-2, Task NT-3: Add the tray icon with its pending-count badge (@notification-engineer)
  - Files: src/hub/tray.ts, src/tray/badge.ts, src/main/index.ts, tests/hub/tray.test.ts, tests/tray/badge.test.ts, src/hub/metrics.ts
- [x] Phase NOTIFICATION-AND-TRAY-PRESENCE-3, Task NT-6: Make the Electron host real and mount the overlay window (@notification-engineer)
  - Files: package.json, package-lock.json, src/notify/surface/host.ts, src/notify/surface/electron-host.ts, src/notify/surface/position.ts, src/main/index.ts, tests/notify/surface-host.test.ts, tests/notify/surface-position.test.ts
- [x] Phase NOTIFICATION-AND-TRAY-PRESENCE-3, Task NT-7: Render the card and own its lifetime (@notification-engineer)
  - Files: src/notify/surface/lifetime.ts, src/notify/surface/card.ts, src/notify/surface/card-view.ts, tests/notify/surface-lifetime.test.ts, tests/notify/surface-card.test.ts, tests/notify/surface-card-view.test.ts, docs/EXECUTION-MANIFEST.json
- [x] Phase NOTIFICATION-AND-TRAY-PRESENCE-3, Task NT-8: Deliver to the surface and retire the platform notifiers (@notification-engineer)
  - Files: src/notify/types.ts, src/notify/policy.ts, src/notify/registry.ts, src/main/index.ts, tests/notify/policy.test.ts, tests/hub/tray.test.ts, docs/runbooks/notification-surface.md, docs/runbooks/notify-platforms.md, src/hub/delivery.ts, src/hub/routes/read.ts, src/notify/command.ts, src/notify/linux.ts, src/notify/macos.ts, src/notify/windows.ts, tests/hub/delivery.test.ts, tests/notify/linux.test.ts, tests/notify/macos.test.ts, tests/notify/registry-selection.test.ts, tests/notify/surface-card.test.ts, tests/notify/windows.test.ts
- [x] Phase NOTIFICATION-AND-TRAY-PRESENCE-3, Task NT-9: Prove the card on a real desktop with a script (@qa-engineer)
  - Files: scripts/verify-notification-surface.mjs, docs/reviews/notification-surface-evidence.json, docs/runbooks/notification-surface.md, tests/scripts/verify-notification-surface.test.ts
- [x] Phase OPENCODE-PLUGIN-ADAPTER-1, Task OA-1: Translate opencode events into the normalized envelope (@connector-engineer)
  - Files: src/plugin/opencode/index.ts, src/plugin/opencode/translate.ts, src/plugin/opencode/work-signal.ts, tests/plugin/opencode-translate.test.ts, tests/plugin/opencode-work-signal.test.ts, docs/engine-config.json
- [x] Phase OPENCODE-PLUGIN-ADAPTER-1, Task OA-2: Deliver events to the hub and leave a breadcrumb on failure (@connector-engineer)
  - Files: src/plugin/transport/http.ts, src/plugin/transport/breadcrumb.ts, tests/plugin/transport.test.ts
- [x] Phase OPENCODE-PLUGIN-ADAPTER-1, Task OA-3: Install and remove the global plugin idempotently (@connector-engineer)
  - Files: src/plugin/install/global-plugin.ts, tests/plugin/install.test.ts, assets/images/agent-ping-logo.png
- [x] Phase OPENCODE-PLUGIN-ADAPTER-2, Task OA-4: Add the polling fallback for non-pushing sessions (@connector-engineer)
  - Files: src/plugin/opencode/poll-fallback.ts, src/plugin/opencode/index.ts, tests/plugin/poll-fallback.test.ts, src/plugin/opencode/translate.ts, tests/plugin/install.test.ts, tests/plugin/opencode-translate.test.ts
- [x] Phase COPILOT-CLI-ACP-SPIKE-1, Task CP-1: Probe the real Copilot ACP surface (@connector-engineer)
  - Files: scripts/probe-copilot-acp.mjs, tests/scripts/probe-copilot-acp.test.ts, docs/research/copilot-acp-capture.json, tests/scripts/fixtures/copilot-acp-capture.json
- [x] Phase COPILOT-CLI-ACP-SPIKE-1, Task CP-2: Probe the Copilot hook surface and write the report (@connector-engineer)
  - Files: scripts/probe-copilot-hooks.mjs, docs/research/copilot-acp-probe.md, docs/research/copilot-hooks-capture.json, tests/scripts/fixtures/copilot-hooks-capture.json, tests/scripts/probe-copilot-hooks.test.ts

## Current Task
- None currently running

## Remaining
- [ ] Phase OPENCODE-PLUGIN-ADAPTER-2: Phase 2: Polling fallback and live verification
- [ ] Phase OPENCODE-PLUGIN-ADAPTER-3: Phase 3: Live adapter gate
- [ ] Phase LIVE-DASHBOARD-1: Phase 1: Live state on the approved layout
- [ ] Phase LIVE-DASHBOARD-2: Phase 2: Interactions against the real API
- [ ] Phase LIVE-DASHBOARD-3: Phase 3: End-to-end journey and review
- [ ] Phase INSTALL-AUTOSTART-AND-OPERATIONS-1: Phase 1: Package and command line
- [ ] Phase INSTALL-AUTOSTART-AND-OPERATIONS-2: Phase 2: Autostart
- [ ] Phase INSTALL-AUTOSTART-AND-OPERATIONS-3: Phase 3: Live operations verification and gate
- [ ] Phase COPILOT-CLI-ACP-SPIKE-2: Phase 2: Gate decision and authorised outcome

## Blockers
- Manifest reconciliation added 4 pending task(s): NT-6, NT-7, NT-8, NT-9
- Manifest reconciliation removed 2 task(s): NT-4, NT-5
- Manifest reconciliation changed 16 existing task(s): NT-1, NT-2, NT-3, OA-5, OA-6, LD-1, LD-2, LD-3, LD-4, LD-5, IO-1, IO-2, IO-3, IO-4, IO-5, CP-4
- Manifest reconciliation changed 16 existing task(s): NT-1, NT-2, NT-3, OA-5, OA-6, LD-1, LD-2, LD-3, LD-4, LD-5, IO-1, IO-2, IO-3, IO-4, IO-5, CP-4

## Validation Gaps
- Task DP-1: No product, dashboard, store, hub or CLI source exists yet, so npm run build reports its tsc and Vite steps as skipped rather than compiling anything; the build wiring itself is exercised only as far as the empty source set allows.
- Task DP-1: The Playwright e2e project is not created or exercised here: playwright.config.ts is owned by qa-engineer under LD-4. Only the dispatch behaviour is verified, and it fails loudly as required.
- Task DP-2: The committed test suite cannot execute the real renderer: jsdom provides no 2D or WebGL context, so Application.init() does not resolve there. The real PixiJS host is exercised through its own seam with a fake Application that records its init and destroy arguments, and the painter is exercised against real PixiJS Container, Graphics, Rectangle and Text objects. Actual pixels are proven by the Vite build plus a headless Chrome run, both reported above.
- Task DP-2: The APX-CON-11 first-paint budget of 1 s from warm cache is not measured here. The built entry chunk is 283 kB raw and 85 kB gzipped with six lazy chunks, but no timing harness exists yet; measuring it belongs to the LD-4 browser suite.
- Task DP-2: Mouse hover was driven through CDP Input.dispatchMouseEvent rather than a real device, and the browser run was headless with software WebGL. The design verdicts in DP-4 and LD-5 remain unperformed and are not claimed here.
- Task DP-2: docs/EXECUTION-AUDIT.jsonl and docs/WORKFLOW-STATE.json show as modified in git status; those are the engine's own files and I did not touch them.
- Task DP-3: jsdom applies no layout, so the visual hiding is asserted as stylesheet text and the browser run above is what proves the computed style; jsdom would report a focus on an element hidden with display: none.
- Task DP-3: The prototype's row model is fixed, so an update that changes a row cannot be produced through the prototype's entry point; the changed-row, departed-row and emptied-list cases are driven through the same mirror and keyboard modules with the mount's own two-line wiring, while the mount's own repaint paths are asserted through the entry point.
- Task DP-3: The design verdicts in DP-4 and LD-5 are human judgements and are not claimed here; no human-review attestation was created.
- Task EL-1: The descriptor-leak test reads /proc/self/fd and is skipped where that directory does not exist; the owner-only mode tests are skipped on Windows. Both skips are visible in the reporter output rather than silent.
- Task EL-1: The macOS and Windows state-directory layouts are asserted through the pure resolveStateDir(env, platform, home) function rather than on those machines, which remains the documented APX-CON-06 manual-gate path.
- Task EL-3: The classification table is asserted against the event names documented in PRD 5 and in the harness-signal-mapping skill reference, not against a live opencode or Copilot capture; the live proof is OA-5's script, not this task.
- Task EL-3: The built classifier was exercised directly (idle gate and row count) and confirmed to load no database driver, but no hub or harness integration was run, because that is out of this task's scope.
- Task HC-1: No Electron process was started: the package is not installed in this checkout and the task's own tests are specified against a real loopback socket, not a window. startElectronMain is exercised only as far as its non-Electron branches allow, and the single-instance guarantee is proven through the runtime-file lock that the Electron path also takes.
- Task HC-1: The build output of the hub was smoke-tested locally by hand-copying schema.sql; that copy is removed and the packaged start path is not covered by an automated test while the build gap above stands.
- Task HC-1: The stream route (HC-2), ingest (HC-3), ack (HC-4), delivery and shutdown (HC-5) and counter recording (HC-6) are deliberately absent. The seams they need exist and are documented in place: one registration point, one close() primitive, the delivery field on health, and the onRequestServed hook.
- Task HC-2: The subscribe-before-write ordering in serveStream is a correctness argument about a synchronous handler, not a test: no publish can interleave between reading the current cursor and subscribing, so a mutation that inverts the order is unobservable and was not counted as one of the eleven that were caught.
- Task HC-2: The two client implementations prove the frames are readable by a standard HTTP client and by a WHATWG client; no browser was involved. EventSource-specific behaviour (automatic reconnection using Last-Event-ID) is asserted against the spec's id/last-event-id rules in the test's own parser rather than against a real browser, and qa-engineer's LD-4 journey is where that belongs.
- Task HC-2: The 250ms budget is measured from the store write the hub accepted to the frame on a real socket. The full accepted-event-to-visible path includes HC-3's ingest validation and classification, which do not exist, so the budget is proven for the stream's share of it only.
- Task HC-2: Idle RSS is measured in a child process that is only a hub, holding four streams through six hundred paced transitions. A real workload's socket and undici costs are not represented.
- Task HC-3: No Electron process was started: the package is not installed in this checkout, so the entry point was exercised through startHub rather than through the Electron runtime.
- Task HC-3: The wire shape is agreed with nothing external: no opencode adapter exists yet, so 'an adapter posts this' is a contract this file publishes, not a behaviour a test observed against a real harness. OA-1/OA-2 and OA-5's live script are where that is proven.
- Task HC-3: The store bound is asserted as a measured watchdog plus a fast-error path, because a synchronous driver cannot be interrupted mid-call. What is proven is that the caller is released on every path, that a throwing store is refused immediately, that an overrun is reported rather than hidden, and that the p95 of real posts is 4.61 ms; a store blocked inside SQLite is bounded by that driver's own busy timeout (src/storage/db.ts) rather than by this task.
- Task HC-5: The observed ingest p95 (6.04 ms) comes from the ingest suite, which measures the response path only: a delivery is fire-and-forget after the 202, so a slow notifier is bounded by DELIVERY_ATTEMPT_TIMEOUT_MS rather than by that number.
- Task HC-5: The restart evidence is a real SIGKILL of a real child process and a real restart, not a service-manager restart; that remains qa-engineer's IO-4.
- Task HC-5: Ordering inside the ordered close is asserted from the source rather than observed, because the steps run within one turn of the event loop; every step's own effect is asserted independently (listener released, counters flushed, log closed and openable, runtime file removed, state reported).
- Task HC-5: The policy was exercised against a notifier that is a test function, not against a platform notifier; notification-engineer's NT-1 is where a real toast boundary is proven, and APX-CON-10's no-retry-storm claim about real notifiers inherits from that.
- Task HC-6: No Electron process was started and no tray exists: the package is not installed in this checkout and NT-2 is not built. The half of NT-FR-08's counter requirement that belongs to the tray is proven by the recorder's public method and by driving onDashboardDocumentServed directly, not by a tray click.
- Task HC-6: The restart-replay counter test uses two in-process hubs over one state directory rather than two operating-system processes. The real-process version of restart replay is tests/hub/delivery.test.ts's, and the count above it is the counter, not the kill.
- Task HC-6: The 'only caller of a counter write' assertion walks src/ as source text with a regular expression. It catches a new call site in any product module, and it would not see a write through a computed property name.
- Task HC-6: isDashboardDocumentPath treats '//' as a document while the hub answers 404 for it; the hook fires only on a real serve, so this is unobservable in the counters but is a disagreement between two rules rather than a proved-equal pair.
- Task HC-6: The exact key-set and name-shape assertions on the metrics payload are over one real response body. A field that appeared only on a second hub, a different clock or an error path would need a new assertion; /api/metrics has no other payload shape because it has no error path.
- Task NT-1: The real-binary checks cover what the installed notify-send accepts and how it fails, not what a notification server does with a resident notification: the option set is exercised with --version so no toast is sent, and the real argv delivery uses a stub so the assertion is deterministic. Nothing here proves on-screen persistence.
- Task NT-1: The two tests that run against the installed notify-send branch on whether the binary exists: without it they assert the honest 'command-not-found' outcome rather than the parsing claim, so on a machine without libnotify the parsing assertions are not exercised (both branches are real, only one proves the parser).
- Task NT-1: The delivery timeouts and the health route are asserted over real sockets in process; the restart replay test uses two hubs in one process rather than two OS processes, because the process-level restart evidence is HC-5's and tests/hub/delivery.test.ts.
- Task NT-1: The unavailable-platform answers for macOS and Windows are verified as values only (no notifier, correct reason, probe reports it); no macOS or Windows behaviour of any kind is exercised.
- Task NT-2: The macOS and Windows argv and payload claims are proven against real stub executables placed at the front of PATH, so what a real process received is what the OS was handed - but the stub is not osascript and not powershell.exe, so nothing here exercises how either tool parses its arguments.
- Task NT-2: The PowerShell script has never been parsed by PowerShell. Its structure is asserted as an exact string (one line, ErrorActionPreference, try, catch, stderr write, exit 1, the WinRT type projections, the toast call), and the base64 round-trip is proven against real processes, but the script's syntax and its runtime behaviour on Windows are unverified.
- Task NT-2: The macOS AppleScript has never been compiled by AppleScript. The same applies: the argument list, the constant script and the payload placement are asserted exactly and reach a real process intact, but osascript's own parsing of `on run argv` on a Mac is unverified.
- Task NT-2: A real process receiving a hostile title and body proves nothing expanded, split or was reinterpreted on the way to the process. It does not prove what a notification centre would do with the text afterwards.
- Task NT-2: No badge, tray or deep-link behaviour is exercised here; the tray and badge are NT-3 and this task deliberately excluded them.
- Task NT-3: No Electron process was started and no icon was ever displayed. Every tray assertion is made against the TrayBridge interface, which is what this product decides and what the platform is asked to do; the bridge's own behaviour on a real desktop is unobserved.
- Task NT-3: Whether a real desktop shows a drawn badge legibly at its real tray size is unverified, as is whether a click reaches the handler. NT-4's Linux gate and NT-5's macOS/Windows gate are where both belong.
- Task NT-3: The claim 'the tray is mounted before the hub reports running' is asserted against the composition root's source order rather than observed at runtime: the mount is synchronous and holds the event loop, so a health request cannot be answered during it and the two orders answer it identically. The observable half - the icon is on the desktop before the desktop is told the hub is ready - is asserted behaviourally.
- Task NT-3: The badge above ninety-nine is driven on a mounted tray with a synthetic hundred-and-one-item pending set rather than a hundred and one real ingests, because the rule is the count's and not the store's; the store's real transitions are driven through the entry point at counts 0, 1 and 2 and compared against a real GET /api/pending each time.
- Task NT-3: The tray's sound and telemetry properties are asserted by reading both modules' source with their prose stripped, so the check is about the values and the calls rather than the sentences; it would not see a capability reached through a computed property name.
- Task NT-6: The unit suite starts no Electron process and displays no window. The Electron half is a structural stub, so the option set, placement, load, click-through direction, show, hide, destroy and shutdown order are proven as this product's decisions, and nothing is proven about any desktop's compositing.
- Task NT-6: The Electron layers were checked by hand on this machine (Ubuntu 24.04, X11 :1, Electron 44.4.5, Chrome 152.0.7977.130) with a script kept outside the repository in /tmp. NT-9 turns it into scripts/verify-notification-surface.mjs; that script is qa-engineer's output and is not part of this task.
- Task NT-6: No claim is made about macOS or Windows window behaviour. Nothing was run on either platform, the launch policy is applied unconditionally rather than per platform, and the transparency compositing that differs between the three desktops is unobserved.
- Task NT-6: The live check drove this product's option set and placement but not this product's own host code end to end: the check transcribes the option object and the placement rather than importing them, because the built entry point's card document does not exist yet. The host itself is proven against the stub, and NT-9's probe is what closes that gap.
- Task NT-6: A GPU zygote fork failure is visible on this machine under software rendering. The application still reaches ready without a workaround, and the failure is recorded rather than worked around, so no measurement here says anything about GPU behaviour on a normal desktop.
- Task NT-7: No Electron process was started, no window was created and no card was seen on any desktop from this checkout. Every claim in these three suites is about the model, the document and the source; whether any of the three desktops composites a transparent frameless window correctly is unobserved and is NT-9's evidence to produce.
- Task NT-7: No macOS or Windows observation of any kind is claimed, and none was possible: the card has one implementation, its reduced-motion query and DOM are platform-neutral, and this suite ran on Linux only.
- Task NT-7: The seam is proven against jsdom's document and elements rather than a browser's, and the reduced-motion preference is proven through an injected matchMedia rather than a real OS setting; the real preference path is a one-line delegation to window.matchMedia that nothing here exercised.
- Task NT-7: 'When the host is destroyed' is proven at the view: view.destroy() removes the card, cancels the timer and refuses to render again. That the host's destroy reaches the view is NT-8's wiring, because NT-6's host deliberately takes placement only and knows nothing about a card document's contents.
- Task NT-7: The deep link is rendered as a data attribute with no control attached, so a click doing something is unbuilt by design (the feature's UI rule forbids buttons in the card) and the deep-link agreement with the tray is asserted structurally - the card takes the plan's own link - rather than by comparing two strings in a test.
- Task NT-7: The source reader is a hand-written comment stripper. A backtick template is read as one string to its closing backtick, so a nested template inside a ${...} would end the scan early; no module on this path contains one, and the same tokens are checked in both the code and the values that code uses.
- Task NT-8: No Electron process was started, no window was created and no card was seen on any desktop from this checkout. Every claim is about the model, the document, the decision tables and the source.
- Task NT-8: No macOS or Windows observation of any kind is claimed and none was possible: the implementation is one file with no platform branch, and this ran on Linux only.
- Task NT-8: The host seam is proven against this product's NotificationSurfaceHost interface with a recorder, not against a real BrowserWindow; whether any desktop composites a transparent frameless always-on-top window correctly is unobserved and is NT-9's evidence to produce.
- Task NT-8: The card view is proven in jsdom, so nothing here says what a card looks like; the stylesheet that draws it and the window's own transparency compositing are both unobserved.
- Task NT-8: The source sweep strips comments and keeps strings, and reads a backtick template as one string to its closing backtick, so a nested template inside a ${...} would end the scan early. No module on this path contains one, and a missed token would still be caught by the same token in the value the code then uses.
- Task NT-9: No human read a word off a card. The pixel capture counts distinct values in the window's own drawable, which separates a painted card from a blank rectangle and reads no text, and the stylesheet that drew the card in this run is the run's own because the product has none.
- Task NT-9: No card was produced by the shipped build. Every card observed in this run went through the run-time harness's three seams; the shipped build's own answer (not-wired, 404, no viewable card window) is a separate record.
- Task OA-1: No live opencode session was run. The payload shapes are the 1.18.32 type declarations, not a capture from a running harness; proving the harness delivers them is OA-5's script and OA-6's gate, not this task.
- Task OA-1: The one-envelope and block-lifecycle tests use the real ingest pipeline and the real SQLite log but drive it from fixtures rather than from a harness's event stream.
- Task OA-1: The plugin was not loaded by opencode itself. Its structural plugin and client types mirror the 1.18.32 declarations rather than importing @opencode-ai/plugin, which is deliberate (the adapter must load with no dependency), so a signature change upstream would not be caught by a compile error here - the OA-3 install and OA-5 live run are where that surfaces.
- Task OA-2: No live opencode session was run. The plugin hook path is driven from fixtures through the real AGENT_PING_PLUGIN, so what is proven is that a harness hook with this transport wired resolves and that a failure becomes a breadcrumb on the harness's own client - not that a running opencode delivers a signal. OA-5's script and OA-6's gate are where that is observed.
- Task OA-2: The transport is not yet wired into an installed plugin artefact, so 'delivered from inside a harness process' is a property of the code path under test rather than of a process the engine started. OA-3 owns the single-file install that constructs the transport and passes it as `deliver`.
- Task OA-2: The end-to-end test starts a real hub in this test process, not in a second OS process. The real ingest pipeline, the real SQLite log and the real runtime file and token are all involved, and a second store connection reads what was stored, but the process boundary itself is unproven here.
- Task OA-2: The answer-cap and body-never-ends cases are driven against a bare http server rather than the hub, because the hub always answers completely; those two bounds are the client's own and have no hub-side counterpart to test against.
- Task OA-2: One row of the failure table (a seam that rejects) uses the injected sender rather than a real socket. Every other row is a real loopback failure, and the injection exists so an unexpected fault in a caller-supplied seam is covered at all.
- Task OA-3: The live opencode run never reached a hub, so this task's evidence stops at 'the installed file loads in the real harness, translates real events, and reports through client.app.log'. Ingest, classification and delivery are HC-3's and OA-5's evidence, not mine.
- Task OA-3: The verification child process uses `node --experimental-strip-types`, which is not how opencode itself loads the file; the live probe is the evidence for that, and it is a single observed run rather than a repeated one.
- Task OA-3: The scanner-based inliner is proven against this repository's eleven inlined modules and its own negative cases, not against arbitrary TypeScript; a future module using an export form it refuses will fail the install loudly with a named module rather than emit a wrong file.
- Task OA-3: I did not re-verify the claim in the module header that a sibling package.json does not disturb plugin discovery; my own live probe had no package.json beside the plugin, so that specific claim rests on the inherited evidence.
- Task OA-4: No live opencode session was run and no real opencode server was polled. The three route shapes come from the SDK's type declarations, and the tests answer them from a real loopback server built to those declarations - so what is proven is that the fallback reads and enforces that contract, not that a running opencode answers it.
- Task OA-4: The end-to-end dedupe test starts a real hub from the real entry point on an ephemeral port and a real opencode-shaped server, but both run in this test process; the process boundary a real harness would add is unproven here.
- Task OA-4: The poll-fallback module is not yet exercised through OA-3's installed single-file artefact in a real opencode session. That the installer inlines it is asserted (the generated closure includes plugin/opencode/poll-fallback.ts and the file loads in a child Node process), but OA-3's live probe predates this module.
- Task CP-1: The permission finding is from one run on one machine against one Copilot version. It is evidence, not a proof across versions, and the gate decision should cite the version alongside the claim.
- Task CP-1: The hook surface is untouched: CP-2 owns the documented Copilot hook triggers and the consolidated report.
- Task CP-1: The stub-binary deadline test executes a shebang script directly, so it assumes a POSIX-style platform, consistent with the existing tests/tooling/runner-convention.test.ts, which already spawns npm by bare name.

## Notes
- Workflow engine run 7d107e32-e0b5-4a61-9b30-c0c01b5ddbd8
- Harness: opencode
