// The hub's own resident set size, measured in a process that is only a hub.
//
//   node tests/hub/fixtures/measure-idle-rss.mjs
//
// APX-CON-11 budgets hub idle RSS at 150 MB. Measuring that inside the test suite
// would measure the test runner as well - the transform, the module graph, every
// fixture - so the number would be about Vitest rather than about agent-ping. This
// process starts the real entry point against a throwaway state directory, answers
// a burst of the real read routes, and prints its own `process.memoryUsage().rss`.
//
// One JSON object on the last line of stdout is the whole contract:
//
//   { rssAfterImportBytes, rssAfterGraphBytes, rssAfterBootBytes, rssAfterReadsBytes,
//     requestsServed, port, measured: 'typescript-source' }
//
// A failure to print it is a failure, not a zero: the caller asserts on the numbers,
// so a fixture that could not measure anything cannot report a pass.
//
// `measured` says what was measured, and it matters when reading the number. This
// process runs the TypeScript sources, so part of what it holds is Node's type
// stripping; the same hub run from the tsc build does not pay that. The import
// phase is reported separately for exactly that reason, and the packaged
// application - an Electron main process - has to be measured again in its own
// right, because Electron's baseline is not in any of these numbers.

import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

register('./ts-resolver.mjs', import.meta.url)

const stateDir = mkdtempSync(path.join(tmpdir(), 'agent-ping-rss-'))
const rssAfterImportBytes = process.memoryUsage().rss
const { startHub } = await import(
  pathToFileURL(new URL('../../../src/main/index.ts', import.meta.url).pathname).href
)
const rssAfterGraphBytes = process.memoryUsage().rss

const READS_PER_ROUTE = 25
const hub = await startHub({ stateDir, dashboardRoot: null })

// Settle before the first reading: the bind, the migrations and the first
// compilation of every handler are startup work, not idle footprint.
await new Promise((resolve) => setTimeout(resolve, 250))
const rssAfterBootBytes = process.memoryUsage().rss

const routes = ['/api/sessions', '/api/pending', '/api/events?limit=50', '/api/metrics', '/api/health']

/** One real loopback request, through node:http rather than a global. */
function read(origin, pathname) {
  const { hostname, port } = new URL(origin)
  return new Promise((resolve, reject) => {
    const call = request({ host: hostname, port, path: pathname, method: 'GET' }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode, bytes: chunks.length }))
    })
    call.on('error', reject)
    call.end()
  })
}

let requestsServed = 0
for (let round = 0; round < READS_PER_ROUTE; round += 1) {
  for (const route of routes) {
    const response = await read(hub.origin, route)
    if (response.status !== 200) {
      throw new Error(`${route} answered ${response.status}`)
    }
    requestsServed += 1
  }
}

await new Promise((resolve) => setTimeout(resolve, 250))
const rssAfterReadsBytes = process.memoryUsage().rss

process.stdout.write(
  `${JSON.stringify({
    rssAfterImportBytes,
    rssAfterGraphBytes,
    rssAfterBootBytes,
    rssAfterReadsBytes,
    requestsServed,
    port: hub.port,
    measured: 'typescript-source',
  })}\n`,
)

await hub.close()
rmSync(stateDir, { recursive: true, force: true })
