# Project Progress

## Current State
**Phase**: OPENCODE-PLUGIN-ADAPTER-1
**Status**: In Progress
**Validation Gaps**: 49 unverified check(s) - see "Validation Gaps"
**Last Updated**: 2026-09-26T19:53:15.249Z
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
- [x] Phase OPENCODE-PLUGIN-ADAPTER-1, Task OA-1: Translate opencode events into the normalized envelope (@connector-engineer)
  - Files: src/plugin/opencode/index.ts, src/plugin/opencode/translate.ts, src/plugin/opencode/work-signal.ts, tests/plugin/opencode-translate.test.ts, tests/plugin/opencode-work-signal.test.ts, docs/engine-config.json
- [x] Phase OPENCODE-PLUGIN-ADAPTER-1, Task OA-2: Deliver events to the hub and leave a breadcrumb on failure (@connector-engineer)
  - Files: src/plugin/transport/http.ts, src/plugin/transport/breadcrumb.ts, tests/plugin/transport.test.ts

## Current Task
- None currently running

## Remaining
- [ ] Phase NOTIFICATION-AND-TRAY-PRESENCE-2: Phase 2: Tray presence
- [ ] Phase NOTIFICATION-AND-TRAY-PRESENCE-3: Phase 3: Live notification gates
- [ ] Phase OPENCODE-PLUGIN-ADAPTER-1: Phase 1: Event translation and delivery
- [ ] Phase OPENCODE-PLUGIN-ADAPTER-2: Phase 2: Polling fallback and live verification
- [ ] Phase OPENCODE-PLUGIN-ADAPTER-3: Phase 3: Live adapter gate
- [ ] Phase LIVE-DASHBOARD-1: Phase 1: Live state on the approved layout
- [ ] Phase LIVE-DASHBOARD-2: Phase 2: Interactions against the real API
- [ ] Phase LIVE-DASHBOARD-3: Phase 3: End-to-end journey and review
- [ ] Phase INSTALL-AUTOSTART-AND-OPERATIONS-1: Phase 1: Package and command line
- [ ] Phase INSTALL-AUTOSTART-AND-OPERATIONS-2: Phase 2: Autostart
- [ ] Phase INSTALL-AUTOSTART-AND-OPERATIONS-3: Phase 3: Live operations verification and gate
- [ ] Phase COPILOT-CLI-ACP-SPIKE-1: Phase 1: Probes
- [ ] Phase COPILOT-CLI-ACP-SPIKE-2: Phase 2: Gate decision and authorised outcome

## Blockers
- None

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
- Task OA-1: No live opencode session was run. The payload shapes are the 1.18.32 type declarations, not a capture from a running harness; proving the harness delivers them is OA-5's script and OA-6's gate, not this task.
- Task OA-1: The one-envelope and block-lifecycle tests use the real ingest pipeline and the real SQLite log but drive it from fixtures rather than from a harness's event stream.
- Task OA-1: The plugin was not loaded by opencode itself. Its structural plugin and client types mirror the 1.18.32 declarations rather than importing @opencode-ai/plugin, which is deliberate (the adapter must load with no dependency), so a signature change upstream would not be caught by a compile error here - the OA-3 install and OA-5 live run are where that surfaces.
- Task OA-2: No live opencode session was run. The plugin hook path is driven from fixtures through the real AGENT_PING_PLUGIN, so what is proven is that a harness hook with this transport wired resolves and that a failure becomes a breadcrumb on the harness's own client - not that a running opencode delivers a signal. OA-5's script and OA-6's gate are where that is observed.
- Task OA-2: The transport is not yet wired into an installed plugin artefact, so 'delivered from inside a harness process' is a property of the code path under test rather than of a process the engine started. OA-3 owns the single-file install that constructs the transport and passes it as `deliver`.
- Task OA-2: The end-to-end test starts a real hub in this test process, not in a second OS process. The real ingest pipeline, the real SQLite log and the real runtime file and token are all involved, and a second store connection reads what was stored, but the process boundary itself is unproven here.
- Task OA-2: The answer-cap and body-never-ends cases are driven against a bare http server rather than the hub, because the hub always answers completely; those two bounds are the client's own and have no hub-side counterpart to test against.
- Task OA-2: One row of the failure table (a seam that rejects) uses the injected sender rather than a real socket. Every other row is a real loopback failure, and the injection exists so an unexpected fault in a caller-supplied seam is covered at all.

## Notes
- Workflow engine run 7d107e32-e0b5-4a61-9b30-c0c01b5ddbd8
- Harness: opencode
