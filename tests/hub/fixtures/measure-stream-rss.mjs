// A hub's resident set size with live state streams attached, measured in a
// process that is only a hub.
//
//   node tests/hub/fixtures/measure-stream-rss.mjs
//
// APX-CON-11 budgets hub idle RSS at 150 MB. HC-1 measures a hub serving read
// routes; this measures the same hub with the stream surface in use, because the
// stream is the only route a client holds open and the only one that keeps frames
// in memory: a bounded replay window per hub plus one response per connected
// client. Those are the numbers a budget has to be checked against, and measuring
// them in the test suite would measure Vitest instead of agent-ping.
//
// What this process does:
//
//   1. starts the real entry point against a throwaway state directory
//   2. opens CLIENTS real loopback streams and reads their preambles
//   3. publishes CHANGES state transitions, so the replay window fills past its
//      bound and every client has been written to CHANGES times
//   4. answers a burst of the read routes, because a dashboard does both
//   5. prints its own `process.memoryUsage().rss` at each phase
//
// One JSON object on the last line of stdout is the whole contract:
//
//   { rssAfterBootBytes, rssAfterStreamsBytes, rssAfterChangesBytes, rssAfterReadsBytes,
//     clients, changes, retainedFrames, retainedBytes, pendingCount, port,
//     measured: 'typescript-source' }
//
// A failure to print it is a failure, not a zero: the caller asserts on the
// numbers, so a fixture that could not measure anything cannot report a pass.
//
// `measured` says what was measured, and it matters when reading the number. This
// process runs the TypeScript sources, so part of what it holds is Node's type
// stripping; the same hub run from the tsc build does not pay that. The packaged
// application - an Electron main process - has to be measured again in its own
// right, because Electron's baseline is in none of these numbers.

import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

register('./ts-resolver.mjs', import.meta.url)

const stateDir = mkdtempSync(path.join(tmpdir(), 'agent-ping-stream-rss-'))
const { startHub } = await import(
  pathToFileURL(new URL('../../../src/main/index.ts', import.meta.url).pathname).href
)

/** How many streams to hold open: a few dashboards plus a script or two. */
const CLIENTS = 4
/** Enough transitions to fill the default replay window and then overrun it. */
const CHANGES = 600
/** The read routes a dashboard runs alongside the stream. */
const READS_PER_ROUTE = 10

// A short heartbeat, so the measurement includes the per-tick cost of keeping
// every connection warm rather than only the cost of the first write.
const hub = await startHub({ stateDir, dashboardRoot: null, stream: { heartbeatIntervalMs: 50 } })

await new Promise((resolve) => setTimeout(resolve, 250))
const rssAfterBootBytes = process.memoryUsage().rss

/** Open one stream and read until it has sent its preamble. */
function openStream() {
  const { hostname, port } = new URL(hub.origin)
  return new Promise((resolve, reject) => {
    const call = request({ host: hostname, port, path: '/api/stream', method: 'GET', agent: false }, (response) => {
      response.setEncoding('utf8')
      if (response.statusCode !== 200) {
        reject(new Error(`/api/stream answered ${String(response.statusCode)}`))
        return
      }
      // Read enough to prove the stream is live, then keep draining so no client is
      // ever the one that stops reading - a stalled client is closed by the hub, and
      // that would measure the wrong thing.
      response.on('data', () => undefined)
      response.on('error', reject)
      response.once('data', () => resolve(call))
    })
    call.on('error', reject)
    call.end()
  })
}

const streams = []
for (let index = 0; index < CLIENTS; index += 1) streams.push(await openStream())
await new Promise((resolve) => setTimeout(resolve, 100))
const rssAfterStreamsBytes = process.memoryUsage().rss

// Paced, not a tight loop. The hub closes a client that stops reading rather than
// buffering for it, and four clients hit by six hundred writes in one tick do stop
// reading - which would leave this measuring a hub nobody is connected to. Yielding
// every twenty-five transitions is enough for the sockets to drain, and the caller
// asserts that all four clients were still connected at the end, so a regression
// here cannot be reported as a footprint.
for (let index = 0; index < CHANGES; index += 1) {
  if (index > 0 && index % 25 === 0) await new Promise((resolve) => setTimeout(resolve, 5))
  hub.store.insertEvent({
    harness: 'opencode',
    sessionId: `ses_${String(index % 8)}`,
    repoShortName: 'agent-ping',
    repoFullPath: '/home/dev/Projects/agent-ping',
    rawEventType: 'session.idle',
    class: 'finished',
    occurredAt: new Date(Date.UTC(2026, 8, 26, 10, 0, index)).toISOString(),
    receivedAt: new Date(Date.UTC(2026, 8, 26, 10, 0, index)).toISOString(),
    dedupeKey: `opencode:ses_${String(index % 8)}:idle-${String(index)}`,
  })
}
await new Promise((resolve) => setTimeout(resolve, 250))
const rssAfterChangesBytes = process.memoryUsage().rss

const routes = ['/api/sessions', '/api/pending', '/api/events?limit=50', '/api/metrics', '/api/health']
function read(pathname) {
  const { hostname, port } = new URL(hub.origin)
  return new Promise((resolve, reject) => {
    const call = request({ host: hostname, port, path: pathname, method: 'GET', agent: false }, (response) => {
      response.resume()
      response.on('end', () => resolve(response.statusCode))
    })
    call.on('error', reject)
    call.end()
  })
}
let requestsServed = 0
for (let round = 0; round < READS_PER_ROUTE; round += 1) {
  for (const route of routes) {
    const status = await read(route)
    if (status !== 200) throw new Error(`${route} answered ${String(status)}`)
    requestsServed += 1
  }
}

await new Promise((resolve) => setTimeout(resolve, 250))
const rssAfterReadsBytes = process.memoryUsage().rss

// Read before the close starts: the close destroys the streams, so anything
// sampled afterwards would report a hub that has already let go of them.
const retained = hub.stream.retainedFrames()
const connectedClients = hub.stream.subscriberCount()
const changeCount = hub.stream.currentCursor()
const pendingCount = hub.store.readPending().length

process.stdout.write(
  `${JSON.stringify({
    rssAfterBootBytes,
    rssAfterStreamsBytes,
    rssAfterChangesBytes,
    rssAfterReadsBytes,
    clients: connectedClients,
    changes: changeCount,
    retainedFrames: retained.length,
    retainedBytes: Buffer.byteLength(JSON.stringify(retained), 'utf8'),
    pendingCount,
    requestsServed,
    port: hub.port,
    measured: 'typescript-source',
  })}\n`,
)

for (const stream of streams) stream.destroy()
await hub.close()
rmSync(stateDir, { recursive: true, force: true })
