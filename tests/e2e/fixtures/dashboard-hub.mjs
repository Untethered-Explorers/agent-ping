// The real hub, in a real separate operating-system process, serving the real
// built dashboard over the real loopback origin.
//
//   node tests/e2e/fixtures/dashboard-hub.mjs <stateDir> <dashboardRoot> [preferredPort]
//
// WHY A SEPARATE PROCESS
// The journeys in tests/e2e/dashboard.spec.ts are about a page and a hub that
// exist independently of the test runner. Three of the claims depend on it:
//
//   - LD-FR-10: the same build is served over the loopback origin. The server has
//     to be a real listener on a real socket, not a handler in the test process.
//   - The stale-state journey interrupts the stream and needs a hub that is still
//     there afterwards, with the same log, the same runtime file and the same
//     published port.
//   - The idle-RSS reading for APX-CON-11 is a property of the hub process, and a
//     number measured inside the Playwright worker's own heap would be the
//     worker's number.
//
// It also keeps this out of Playwright's own module graph: the composition root
// imports `better-sqlite3` and resolves its own relative specifiers with the `.js`
// extension the tsc build requires, neither of which Playwright's loader
// provides. The resolver hook below is the same one tests/hub/fixtures uses, and
// it is the reason this checkout needs no build step to serve the real
// `src/main/index.ts`.
//
// WHAT IS THE PRODUCT'S AND WHAT IS THIS FILE'S
// Everything that answers a request is the product's: the real composition root,
// the real runtime-file lock, the real durable store, the real route registry,
// the real ingest classifier, the real change feed, the real ack route and the
// real static route with the real content-security policy. This file passes two
// things in - a temporary state directory and a prepared dashboard root - and
// prints one line. It mounts no notifier and no tray, so a delivery is recorded
// `not-wired` rather than shown to anyone: this run is about the dashboard page
// and about a page, and a real card on a real screen is
// scripts/verify-notification-surface.mjs's claim (NT-FR-10, APX-CON-12).
//
// The state directory is an argument rather than an environment lookup, so this
// can never be pointed at a developer's own installation.

import { register } from 'node:module'

register('../../hub/fixtures/ts-resolver.mjs', import.meta.url)

const [stateDir, dashboardRoot, preferredPort = ''] = process.argv.slice(2)
if (stateDir === undefined || dashboardRoot === undefined) {
  process.stderr.write('dashboard-hub: a state directory and a dashboard root are required\n')
  process.exit(2)
}

const port = preferredPort === '' ? undefined : Number.parseInt(preferredPort, 10)
if (port !== undefined && !Number.isInteger(port)) {
  process.stderr.write(`dashboard-hub: "${preferredPort}" is not a port number\n`)
  process.exit(2)
}

const { startHub } = await import(
  new URL('../../../src/main/index.ts', import.meta.url).href
)

let hub
try {
  hub = await startHub({
    stateDir,
    dashboardRoot,
    ...(port === undefined ? {} : { preferredPort: port }),
  })
} catch (cause) {
  process.stderr.write(`dashboard-hub could not start: ${cause?.message ?? String(cause)}\n`)
  process.exit(2)
}

process.stdout.write(`${JSON.stringify({ origin: hub.origin, pid: process.pid })}\n`)

// The hub owns the rest: `startHub` installs the signal handlers, so SIGTERM runs
// the ordered close and the process ends with the lifecycle's own exit code. The
// listener is what keeps the loop alive, so the process lasts exactly as long as
// it is serving.
