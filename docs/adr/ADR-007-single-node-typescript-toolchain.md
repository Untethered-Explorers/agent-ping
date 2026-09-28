# ADR-007: Single toolchain — Node 22 + TypeScript, Electron main, PixiJS dashboard

- **Status:** Accepted, **amended by [ADR-012](ADR-012-surface-is-rendered-by-agent-ping.md)**
- **Date:** 2026-09-26
- **Amended:** 2026-09-27. The libnotify row leaves the technology table, Electron is
  promoted from an uninstalled shell to a load-bearing runtime dependency, and the
  notification path becomes this product's own rendering rather than a platform service.
- **Decision owners:** Project author (decided with the user; versions recorded
  in the PRD)
- **Implementation state:** **Implemented, with one recorded divergence and one
  platform gap.** The
  toolchain itself exists and is verified: `package.json` and `package-lock.json`
  are the single package, `tsconfig.json` is `strict` with
  `noUncheckedIndexedAccess`, and all three build entry points work —
  `npm run build` compiles the Node-hosted sources with `tsc` to `dist/main` and
  builds the dashboard with Vite, and `npm test` runs the whole Vitest suite
  through `scripts/run-tests.mjs`. **Electron is a runtime dependency**
  (`electron` 44.4.5 in `dependencies`, not `devDependencies`), reached by the
  composition root in `src/main/index.ts` through a dynamic `import('electron')`
  behind an injectable bridge — the bridge is what lets the real entry point be
  started by a test on a machine with no display, and it is also what
  `doctor` and the live scripts interrogate. `src/cli/` is built and its four
  subcommands run from the built entry point. The Electron main process, the
  tray, the card window and the CLI have all run inside Electron on a real
  Linux desktop, and **only on Linux**: macOS and Windows have never run this
  product. See the divergence table below.

## Context

The product needs a resident daemon (Electron main process), a rendered
interactive surface (the dashboard), a native durable store, its own notification
path including a tray or menu-bar icon, and a plugin that must be
loadable by a Node process the user already runs.

The user-facing dashboard is a canvas surface by choice — the project targets a
PixiJS-rendered notification dashboard. That choice is what forces the
toolchain question, because a canvas surface also forces the accessibility
question: a canvas has no semantics, so it must be paired with a DOM mirror
(ADR-009, and APX-CON-07).

The ecosystem options for a resident process with a tray icon and a window are
thin, which pushes toward Electron. Electron is a large dependency for what is
conceptually a notification daemon, and that cost is real: it is recorded as a
named risk in the PRD. **ADR-012 makes this cost unavoidable rather than
optional**: the card, the badge and the dashboard window all execute inside
Electron, so it is now a runtime dependency rather than a shell that might be
avoided.

A second constraint is decisive: **one toolchain only**. A second implementation
language, or a runtime dependency the supported Node line does not satisfy, is
excluded. This keeps the whole product buildable and testable with one
`npm` toolchain and one type checker.

## Decision

**One npm package, one toolchain, three build entry points.**

Runtime floor: **Node.js 22 LTS or newer**, with **TypeScript** and **npm**.
No second implementation language, and no runtime dependency the supported Node
line does not satisfy.

The stack as recorded in the PRD technology table:

| Role | Choice | Version recorded | Verified against |
|------|--------|------------------|------------------|
| Runtime | Node.js | 22.23.3 LTS line | npm registry |
| Language | TypeScript | 7.0.2 | npm registry |
| Shell and tray host | Electron | 44.4.5 (needs Node >= 22.12.0) | npm registry |
| Dashboard renderer | PixiJS | 8.21.0 | npm registry |
| Renderer build | Vite | 8.3.1 | npm registry |
| Unit and integration tests | Vitest | 5.0.2 | npm registry |
| DOM test environment | jsdom | 30.1.1 | npm registry |
| End-to-end tests | Playwright | `@playwright/test` 1.63.0 | npm registry |
| Durable store | better-sqlite3 | 13.0.3 (needs Node >= 22) | npm registry |
| Payload validation | zod | 4.6.5 | npm registry |
| opencode plugin types | `@opencode-ai/plugin` | 1.18.32 | npm registry |
| opencode client | `@opencode-ai/sdk` | 1.18.32 | npm registry |
| ACP client | `@agentclientprotocol/sdk` | 1.5.0 (protocol version 1) | npm registry |
| Notification rendering | plain DOM in an Electron host window | part of the Electron dependency | live probe on the authoring machine |

The three build entry points, and why each exists separately:

- **Electron main via `tsc`** — the hub, store, ingest, SSE, delivery, tray
  wiring, and CLI. Typed compilation, no bundler.
- **Dashboard via Vite** — the PixiJS renderer, because bundling and asset
  handling are what a bundler is for.
- **Plugin as directly loadable TypeScript** — the global opencode plugin is
  loaded by opencode itself, so it must be loadable without a separate build
  step in the consumer's path.

Source layout, per the PRD, is organised by concern: `src/domain/`,
`src/storage/`, `src/hub/`, `src/notify/`, `src/dashboard/`, `src/plugin/`,
`src/cli/`, with `scripts/` for live verification and `tests/` mirroring
`src/`.

## Alternatives Considered

- **A native daemon (Rust or Go) plus a web dashboard.** Rejected. It is a
  second implementation language, violating the single-toolchain constraint,
  and it roughly doubles the build and test surface for a single-user tool.
- **A plain Node daemon with no Electron, serving the dashboard to a browser.**
  Rejected for v1 because it loses the tray or menu-bar icon, and the tray badge
  is load-bearing: it is the **durable** signal that does not depend on the user
  catching a card. Losing it would push the product back toward
  "easy to miss", which is the failure mode ADR-004 is designed to avoid. ADR-012
  did not reopen this: the tray badge remains the durable signal, and a card that
  is never drawn must still leave a number behind.
- **Tauri instead of Electron.** Rejected. It is a credible footprint
  improvement, but it adds a Rust build dependency to a project whose defining
  constraint is a single Node/TypeScript toolchain.
- **React or another DOM framework for the dashboard, with no canvas.** Rejected.
  The canvas surface is a deliberate product choice, not an accident.
- **Multiple packages in a workspace.** Rejected. A single-user daemon with one
  binary does not benefit from workspace versioning, and several package
  versions would create exactly the version-drift ambiguity this repository's
  documentation has to avoid.

## Consequences

- **Benefit:** One `npm` toolchain builds and tests everything. One type
  checker. No polyglot repository.
- **Benefit:** The tray badge is available on all three target platforms from one
  host, which supports the durable-signal requirement in ADR-004.
- **Cost:** Electron is a heavy dependency for a notification daemon. The PRD
  records this as a named risk and mitigates it with a single package, no
  bundled Chromium download beyond the default, and user-level (non-root)
  autostart. The footprint is accepted, not solved.
- **Cost:** Three build entry points means three ways for a build to break, and
  the Electron main `tsc` path and the Vite path can drift in how they resolve
  modules.
- **Risk:** **TypeScript 7.0.2 compatibility is an open question**, not a
  verified fact. The PRD's recorded default is to pin 7.0.2 and fall back to the
  5.9.x line only if a concrete incompatibility with Vitest 5 or the build path
  appears, recording the fallback when it does. This is untested.

  **Resolved in practice (2026-09-26):** the build pinned **5.9.3**, so the
  documented fallback was taken. See the divergence table below.

## Divergence from the recorded technology table

The table above is the PRD's *recorded default*, researched from the npm
registry. What `package.json` actually contains as of 2026-09-26 differs, and
the differences are decisions rather than accidents:

| Role | Recorded | Installed | Why |
|------|----------|-----------|-----|
| Language | TypeScript 7.0.2 | **5.9.3** | The documented fallback line. `npm run typecheck` and `npm run build` are green on it. |
| Shell and tray host | Electron 44.4.5 | **not yet installed** | Reached only through a dynamic `import('electron')`, so the hub is testable headless. The tray is asserted against the `TrayBridge` interface. |
| Payload validation | zod 4.6.5 | **not used** | Validation is hand-written closed schemas (`INGEST_SIGNAL_FIELDS`, `INGEST_ISSUE_CODES`, `presentedWriteToken`). A dependency is a stronger promise than the closed-union approach, and every refusal has a named code. |
| opencode plugin types | `@opencode-ai/plugin` 1.18.32 | **structural types only** | The installed plugin file must load with nothing beside it, so the adapter mirrors the 1.18.32 declarations rather than importing them. Consequence: an upstream signature change is **not** caught by a compile error here. |
| opencode client | `@opencode-ai/sdk` 1.18.32 | **not used** | Same reason, and nothing needs a client: delivery is a plain HTTP POST to loopback. |
| ACP client | `@agentclientprotocol/sdk` 1.5.0 | **not yet installed** | Deferred with the Copilot spike (ADR-005). No ACP code exists. |
| End-to-end tests | Playwright 1.63.0 | **not yet installed** | Owned by the live-dashboard feature. `scripts/run-tests.mjs` already dispatches `tests/e2e` to it and **fails loudly** when the CLI or config is absent, so the gap cannot be reported as a pass. |
| — | not listed | eslint 10.11.0, typescript-eslint 8.70.1, `@types/node` | The lint configuration the toolchain feature added. |

The single-toolchain constraint itself is intact: one language, one package, one
type checker, one `npm` entry point per build step.
- **Risk:** **Playwright browser download may fail** in a locked environment.
  The mitigation is that the dashboard is also served over loopback, so the
  journey can be driven in an existing browser; script failure is explicit and
  never silently skipped.
- **Operational implication:** Node 22 is a **floor**, not a suggestion — it is
  required by Electron 44, Vitest 5, and better-sqlite3. Install and support
  documentation must state the floor rather than a tested version.
- **Constraint carried forward:** better-sqlite3 is a native module. This is why
  the repository ignores `build/`, `prebuilds/`, and `*.node`. It also means the
  install has a native build step, which is a real installation consideration.

## Implementation References

- Requirements: [APX-CON-05](../PRD.md#7-non-functional-requirements) — one
  toolchain. [APX-CON-06](../PRD.md#61-technology-stack) — platform support.
  [APX-CON-07](../PRD.md#9-accessibility) — canvas plus DOM mirror.
  [APX-CON-11](../PRD.md#7-non-functional-requirements) — performance budgets.
- Technology table: [PRD §6.1](../PRD.md#61-technology-stack) — including the
  explicit statement that no dependency in the table is deprecated or
  end-of-life, and that unverifiable versions are recorded in Open Questions
  rather than guessed.
- Project structure: [PRD §6.2](../PRD.md#62-project-structure).
- Risks and mitigations: [PRD §12.2](../PRD.md#122-risks) — Electron footprint,
  Playwright download, TypeScript 7 line.
- Open questions 6 and 7 in [PRD §16](../PRD.md#16-open-questions).
- Feature documents: [Dashboard Design Prototype](../features/dashboard-design-prototype.md)
  (which also establishes the toolchain and the test-runner convention),
  [Live Dashboard](../features/live-dashboard.md),
  [Install, Autostart and Operations](../features/install-autostart-and-operations.md).
- Paths: `package.json`, `tsconfig.json`, `tsconfig.build.json`,
  `vitest.config.ts`, `eslint.config.js`, `scripts/build.mjs`,
  `scripts/run-tests.mjs`, `src/`, `tests/`. `src/cli/` is the one directory in
  the agreed layout that does not exist yet.
