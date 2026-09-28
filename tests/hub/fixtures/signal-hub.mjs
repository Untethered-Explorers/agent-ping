// A real hub, in a real separate process, with a real notifier behind the delivery
// policy and the real signal handlers installed.
//
//   node tests/hub/fixtures/signal-hub.mjs <stateDir> <attemptsFile> [notifier] [preferredPort]
//
// Where `notifier` is `ok`, `fail` or `none`:
//
//   ok    the notifier records the attempt and returns normally
//   fail  the notifier records the attempt and throws, which is how a delivery failure
//         is forced rather than simulated (APX-FR-02, NT-FR-09)
//   none  no notifier at all, which is the state of every build until notification-
//         engineer constructs the platform one (NT-1)
//
// WHY A SEPARATE PROCESS IS THE ONLY HONEST WAY TO TEST THIS
// The claims HC-5 makes are about an *operating system process*: a hub that is killed
// while a block is pending and replays it after a restart, and a hub that is sent a
// termination signal and leaves no listener, no runtime file and an openable database.
// None of them is about a function that can be called. An in-process test could call
// `hub.close()` and assert the log is closed, and every one of those assertions would
// hold in a world where the process was never actually signalled, the port was never
// actually released, and the restart never actually happened.
//
// So this fixture does the real thing: it imports the real `src/main/index.ts` and
// calls the real `startHub`, which installs the real `process.on('SIGTERM')`
// handlers, binds a real loopback port and publishes it in the real runtime file. The
// test finds it the way an adapter finds a hub - by polling the runtime file for a
// published port - kills it, and starts a second one over the same state directory.
//
// The notifier writes one line per attempt to `attemptsFile`, which is how the test
// observes "the pipeline attempted a delivery" from outside the process: a file two
// processes appended to is evidence that outlives both, where an in-memory count would
// not. The line is the notification request the notifier received, which is the
// product's own content-free shape.
//
// Exit codes are the assertion, and they are the only channel that does not depend on
// a pipe surviving a `process.exit`:
//
//   0  a clean shutdown
//   1  a shutdown that did not finish (the grace bound expired, or the close threw)
//   2  the fixture itself could not run, which is a failure and not a skip
//
// The state directory is passed in rather than resolved from the environment, so this
// can never be pointed at a developer's real installation.

import { appendFileSync } from 'node:fs'
import { register } from 'node:module'

register('./ts-resolver.mjs', import.meta.url)

const [stateDir, attemptsFile, notifierMode = 'ok', preferredPort = ''] = process.argv.slice(2)
if (stateDir === undefined || attemptsFile === undefined) {
  process.stderr.write('signal-hub: a state directory and an attempts file are required\n')
  process.exit(2)
}

// A preferred port is a test-suite convenience, not a product default: empty means the
// hub uses DEFAULT_HUB_PORT and its own next-free fallback, and a number means this
// process was given a port band of its own so that a port it releases cannot be taken
// by another suite while a test is still asserting that nothing answers it.
const port =
  preferredPort === '' ? undefined : Number.parseInt(preferredPort, 10)
if (port !== undefined && !Number.isInteger(port)) {
  process.stderr.write(`signal-hub: "${preferredPort}" is not a port number\n`)
  process.exit(2)
}

// The source entry, as a URL. `new URL(relative, import.meta.url).href` and nothing
// else: this used to be
//
//   pathToFileURL(new URL('../../../src/main/index.ts', import.meta.url).pathname).href
//
// which converts twice. The URL constructor already resolved the specifier against
// this file, and taking `.pathname` throws that resolution away in favour of an opaque
// encoded string - which `pathToFileURL` then has to guess at again. On Linux the
// round trip happens to be idempotent, so it worked. On Windows it is not: `.pathname`
// yields `/D:/a/...`, and re-resolving that against the current drive produces
// `D:\D:\a\...`, so the fixture died with ERR_MODULE_NOT_FOUND on the one platform
// where its import target lives behind a drive letter. Five fixtures carried the
// pattern, which is what the Windows CI cell reported as 50 failing tests.
//
// The four sibling fixtures - second-instance, measure-idle-rss, measure-stream-rss and
// tests/e2e/fixtures/dashboard-hub.mjs - import the same entry the same way and must
// keep doing so in this one shape.
const { startHub } = await import(
  new URL('../../../src/main/index.ts', import.meta.url).href
)

/**
 * One attempt, appended to a file two processes may both write.
 *
 * `appendFileSync` with one short line is a single write syscall under the default
 * O_APPEND semantics, which is what keeps run 1's live delivery and run 2's replay from
 * interleaving into one corrupt line. The fields are the notification request as the
 * notifier received it: row key, class, pending count, the repository's short name, the
 * live origin and which path asked - and no content, because there is none to carry
 * (APX-FR-01).
 */
function recordAttempt(request) {
  appendFileSync(
    attemptsFile,
    `${JSON.stringify({
      at: new Date().toISOString(),
      pid: process.pid,
      eventId: request.event.eventId,
      class: request.class,
      source: request.source,
      pendingCount: request.pendingCount,
      repoShortName: request.repoShortName,
      origin: request.origin,
    })}\n`,
  )
}

const notifier =
  notifierMode === 'none'
    ? undefined
    : (request) => {
        recordAttempt(request)
        if (notifierMode === 'fail') {
          throw new Error('this notifier is failing on purpose')
        }
      }

let hub
try {
  hub = await startHub({
    stateDir,
    dashboardRoot: null,
    ...(port === undefined ? {} : { preferredPort: port }),
    ...(notifier === undefined ? {} : { delivery: { notifier } }),
  })
} catch (cause) {
  process.stderr.write(`signal-hub could not start: ${cause?.message ?? String(cause)}\n`)
  process.exit(2)
}

// One line, so a test that pipes stdout can see it without polling for the runtime
// file. The runtime file is the real discovery mechanism and the test prefers it.
process.stdout.write(`${JSON.stringify({ origin: hub.origin, pid: process.pid })}\n`)

// The hub owns the rest: the signal handlers are installed by `startHub`, so SIGTERM
// and SIGINT run the ordered close and the process exits with the lifecycle's code.
// Nothing here keeps the loop alive on its own account - the listener does - so the
// process stays alive exactly as long as the hub is serving.
