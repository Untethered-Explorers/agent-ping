// A second instance of the hub, in a real separate process.
//
//   node tests/hub/fixtures/second-instance.mjs <stateDir>
//
// This is the single-instance guarantee of HC-FR-01 proven the only way it can be:
// another OS process, with its own view of the file system, importing the real
// `src/main/index.ts` and calling the real `startHub`. The process that holds the
// runtime file is a different process, so nothing in memory can make the two agree
// about who is running.
//
// Exit codes are the assertion:
//
//   0  the hub started, which means the lock failed to refuse a second instance
//   1  the start was refused, and the reason is on stderr
//   2  the fixture itself could not run, which is a failure and not a skip
//
// The state directory is passed in rather than resolved from the environment, so
// the fixture cannot accidentally start a second hub against a developer's real
// installation.

import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

register('./ts-resolver.mjs', import.meta.url)

const stateDir = process.argv[2]
if (stateDir === undefined || stateDir === '') {
  process.stderr.write('second-instance: a state directory is required\n')
  process.exit(2)
}

const { startHub } = await import(
  pathToFileURL(new URL('../../../src/main/index.ts', import.meta.url).pathname).href
)

let hub
try {
  hub = await startHub({ stateDir, dashboardRoot: null })
} catch (cause) {
  // Named and quoted on purpose: the test asserts that the refusal identifies
  // itself and names the instance that is already running, rather than failing for
  // some unrelated reason.
  process.stdout.write(`${cause?.name ?? 'Error'}\n`)
  process.stderr.write(`${cause?.message ?? String(cause)}\n`)
  process.exit(cause?.name === 'HubAlreadyRunningError' ? 1 : 2)
}

process.stdout.write(`started on ${hub.origin}\n`)
await hub.close()
process.exit(0)
