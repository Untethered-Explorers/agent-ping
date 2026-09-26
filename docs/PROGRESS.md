# Project Progress

## Current State
**Phase**: HUB-CORE-AND-DELIVERY-POLICY-2
**Status**: In Progress
**Validation Gaps**: 23 unverified check(s) - see "Validation Gaps"
**Last Updated**: 2026-09-26T15:41:12.918Z
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

## Current Task
- None currently running

## Remaining
- [ ] Phase HUB-CORE-AND-DELIVERY-POLICY-2: Phase 2: Write surface, security, delivery and metrics
- [ ] Phase HUB-CORE-AND-DELIVERY-POLICY-3: Phase 3: Read-only and restart-safety gate
- [ ] Phase NOTIFICATION-AND-TRAY-PRESENCE-1: Phase 1: Notifier and toast policy
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

## Notes
- Workflow engine run 7d107e32-e0b5-4a61-9b30-c0c01b5ddbd8
- Harness: opencode
