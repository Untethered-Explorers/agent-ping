// The shutdown path: what a termination signal does to a running hub, in what
// order, and what an operator is left with (HC-FR-10, HC-FR-07, PRD 10, APX-CON-03,
// ADR-001).
//
// THE ORDER IS THE REQUIREMENT
// HC-FR-10 names five things: stop accepting events, flush counters, close the
// database, remove the runtime file, exit. They are not a list, they are a sequence,
// and the sequence is what makes a kill survivable:
//
//   1. stop accepting  the hub's state becomes `stopping` and its signal handlers are
//                      removed, so a second Ctrl-C is the operating system's answer
//                      rather than a second ordered close. New events are refused by
//                      the ingest pipeline's own gate, which is the first step of the
//                      close the composition root already owns (src/main/index.ts).
//   2. drain           deliveries already in flight are finished, bounded by the
//                      delivery attempt bound, so a wedged notifier cannot decide
//                      whether the hub stops (APX-CON-10).
//   3. end the streams, stop answering, flush the counters, close the log, give the
//                      runtime file back - all inside the composition root's ordered
//                      close, which this module calls rather than reimplements.
//   4. exit            with code 0, or 1 when the ordered close did not finish.
//
// WHY THE FLUSH IS ITS OWN STEP
// `counters.flush()` folds the write-ahead log back into the database file, so a copy
// of the single file is complete after a shutdown rather than only after a restart
// that reopens it (src/storage/counters.ts, PRD 10's "counters flushed"). It is a
// step rather than a detail because it is the one part of the close that is invisible
// from outside the process - and tests/hub/lifecycle.test.ts asserts it from outside,
// by watching the write-ahead log truncate.
//
// A GRACE BOUND, BECAUSE "EXITS" HAS TO BE TRUE EVEN WHEN SOMETHING WEDGES
// The handlers are not the only way this process can be asked to stop, and a daemon
// that cannot be killed is a daemon a developer will kill more violently. So the
// shutdown carries a grace bound: if the ordered close has not finished when it
// expires, the runtime file this instance published is removed (only if it is still
// ours, so a hub that was restarted underneath us is never disowned) and the process
// exits with a failure code. The grace timer is deliberately *not* `unref`ed: if the
// close is wedged on a promise that never settles, nothing else is holding the event
// loop open, and an unrefed timer would let the process drift out of existence without
// closing the log or removing the runtime file - a silent data-loss shape worse than
// the wedge that caused it.
//
// WHAT THIS MODULE CANNOT DO
// It cannot stop a harness, a session, an agent or anything outside this process. It
// starts no subprocess, signals no pid but its own, and reaches no harness: the only
// signal it handles is its own process's, and the only file it deletes is the runtime
// file this instance published. agent-ping is a sidecar that observes agent processes
// and owns none of them (APX-CON-03, ADR-001), and a shutdown that killed something
// else would be that violation in its most literal form.
//
// WHY THE PROCESS IS INJECTED
// `SignalSource` and `exit` are injected rather than reached for, so a test can drive
// this module's real handler - the state machine, the ordering, the grace bound and
// the handler removal - without signalling the test runner and exiting it. The
// production default is `process`, and tests/hub/lifecycle.test.ts additionally sends
// a real SIGTERM to a real hub in a real OS process, because a state machine proven
// only against a fake is a state machine whose *installation* was never proven.

import { unlinkSync } from 'node:fs'
import { readRuntimeFile, runtimeFilePath } from './runtime-file.js'

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

/**
 * The hub's lifecycle states, exactly as PRD 10 names them.
 *
 * Reported on health so `doctor` can tell a hub that is starting, a hub that is
 * serving, and a hub on its way out. `stopped` exists because a shutdown has to be
 * able to say it finished; a state machine with no terminal state cannot be observed
 * at rest.
 */
export const HUB_STATES = ['starting', 'running', 'stopping', 'stopped'] as const

export type HubState = (typeof HUB_STATES)[number]

/**
 * The signals that mean "stop".
 *
 * SIGTERM is what a service manager sends on stop and on logout, and SIGINT is what a
 * terminal sends on Ctrl-C. SIGHUP is deliberately absent: this hub is not a
 * controlling terminal for anything, and a hub that treated a hangup as a shutdown
 * would exit when its parent shell closed. Anything else keeps Node's default
 * behaviour, which is to terminate - the one thing a daemon must always be able to
 * do.
 */
export const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const

export type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number]

/**
 * How long the ordered close may take before the process gives up on it.
 *
 * Five seconds against a two-second delivery bound and a one-second store watchdog: a
 * clean close of a hub with nothing wedged finishes in milliseconds, so this is the
 * number at which something is wrong rather than merely slow. It is a bound on a
 * shutdown, not a delay - a close that finishes early is not held open for it.
 */
export const SHUTDOWN_GRACE_MS = 5_000

/** The exit code of a shutdown that finished. */
export const SHUTDOWN_CLEAN_EXIT_CODE = 0

/**
 * The exit code of a shutdown that did not: the close threw, or the grace bound
 * expired.
 *
 * One code for both, deliberately. A caller that inspects a daemon's exit status
 * learns that the daemon stopped uncleanly, and the distinction between "threw" and
 * "ran out of time" is in the diagnostic line and in whether the runtime file is still
 * there - not in a number a service manager would have to be taught two of.
 */
export const SHUTDOWN_FAILURE_EXIT_CODE = 1

// ---------------------------------------------------------------------------
// The state
// ---------------------------------------------------------------------------

/** What the hub is doing, for the health route and for a diagnostic. */
export interface HubStateReport {
  readonly state: HubState
  /** ISO 8601, when the hub entered this state. */
  readonly since: string
  /** What asked for the shutdown, or null while the hub has not been asked. */
  readonly reason: string | null
  /** True when the close threw, or the grace bound expired. */
  readonly forced: boolean
}

/** The slice of a process this module reacts to. */
export interface SignalSource {
  on(signal: string, handler: () => void): void
  off(signal: string, handler: () => void): void
}

export interface HubLifecycleOptions {
  /**
   * The ordered close. The composition root's own, unchanged: this module decides
   * *when* and decides that a wedged close cannot keep the process alive, and it does
   * not restate the order of the steps inside (src/main/index.ts).
   *
   * Callable before the hub exists. A signal that arrives while the hub is still
   * starting runs this, and the composition root's version releases the claim and
   * closes whatever it had opened - which is the honest answer to "stop" at that
   * point, rather than a half-started process holding a runtime file.
   */
  readonly close: () => Promise<void>
  /** The state directory, for the forced path's runtime-file removal. */
  readonly stateDir: string
  /** Overrides the signals handled. Defaults to SHUTDOWN_SIGNALS. */
  readonly signals?: readonly string[]
  /** Overrides the grace bound. Defaults to SHUTDOWN_GRACE_MS. */
  readonly graceMs?: number
  /** Milliseconds since the epoch. Injectable so a test can read `since`. */
  readonly now?: () => number
  /** Reports a diagnostic line. Never called with content, a path or a token. */
  readonly onDiagnostic?: (message: string) => void
  /** Defaults to `process`. */
  readonly signalSource?: SignalSource
  /** Defaults to `process.exit`. */
  readonly exit?: (code: number) => void
  /** This instance's identity, so the forced path only removes its own runtime file. */
  readonly instanceId?: string
  readonly pid?: number
}

/**
 * The shutdown half of a hub.
 *
 * `begin` and `finish` exist so the composition root's `close` can report the same
 * state a signal does: `close` is reachable from a test, from Electron's
 * `before-quit` and from the signal handler, and a health payload that said `running`
 * while the log was being closed would be a lie in one of those three cases.
 */
export interface HubLifecycle {
  /** The current state, read when the health payload is built. */
  state(): HubStateReport
  /** Install the signal handlers. Idempotent. */
  install(): void
  /** Remove them. Idempotent, and does not change the state. */
  dispose(): void
  /**
   * Mark the hub as serving: accepting events, with the tray present (PRD 10's
   * `running`).
   *
   * Idempotent, and refused once a shutdown has begun: a hub that said `running`
   * because something called this late would be worse than one that said `stopping`,
   * because `running` is the state a client trusts.
   */
  markRunning(): void
  /**
   * Mark the hub as stopping: refuse new work and stop reacting to signals.
   *
   * Idempotent, and safe to call from the composition root's `close`, which is how a
   * directly-closed hub reports the same state a signalled one does.
   */
  begin(reason: string): void
  /** Mark the ordered close as finished. Idempotent. */
  finish(): void
  /**
   * The whole shutdown, for a signal or any other trigger: begin, close within the
   * grace bound, exit.
   *
   * Idempotent. A second caller receives the first call's promise and no second exit
   * is performed, which is what makes Electron's `before-quit` and a SIGTERM arriving
   * together harmless.
   */
  shutdown(reason: string): Promise<void>
  /** The signals this lifecycle is handling, for the diagnostic and a test. */
  handledSignals(): readonly string[]
}

export function createHubLifecycle(options: HubLifecycleOptions): HubLifecycle {
  const now = options.now ?? ((): number => Date.now())
  const diagnostic = options.onDiagnostic ?? ((): void => {})
  const signals = options.signals ?? SHUTDOWN_SIGNALS
  const graceMs = options.graceMs ?? SHUTDOWN_GRACE_MS
  const source: SignalSource = options.signalSource ?? process
  const exit = options.exit ?? ((code: number): void => process.exit(code))
  const pid = options.pid ?? process.pid
  const instanceId = options.instanceId

  let state: HubState = 'starting'
  let since = new Date(now()).toISOString()
  let reason: string | null = null
  let forced = false
  let inFlight: Promise<void> | undefined
  const installed: { signal: string; handler: () => void }[] = []

  const to = (next: HubState): void => {
    state = next
    since = new Date(now()).toISOString()
  }

  const dispose = (): void => {
    // Splice before iterating: a handler that throws while being removed must not
    // leave the list claiming a handler is still installed.
    for (const entry of installed.splice(0)) {
      try {
        source.off(entry.signal, entry.handler)
      } catch {
        // A signal this process never had a handler for cannot be un-installed, and a
        // shutdown must not fail because of it.
      }
    }
  }

  const begin = (why: string): void => {
    if (state === 'stopping' || state === 'stopped') return
    reason = why
    to('stopping')
    // The handlers go first, and that is what makes a second Ctrl-C the operating
    // system's answer rather than a second ordered close: with no listener installed,
    // SIGINT and SIGTERM terminate the process. A daemon that cannot be killed
    // politely is a daemon that gets killed unpolitely.
    dispose()
    diagnostic(`agent-ping: stopping on ${why}`)
  }

  const finish = (): void => {
    if (state === 'stopped') return
    to('stopped')
  }

  /**
   * Remove this instance's runtime file, and only this instance's.
   *
   * Used by the forced path, where the ordered close did not get as far as releasing
   * it. The identity check is the whole point: if a newer instance has taken the
   * directory over - which can only happen if this one was stopped so hard that its
   * file was reclaimed - then that file belongs to a live hub, and removing it would
   * send every adapter on this machine to a port nobody is listening on (HC-FR-01).
   */
  const removeOwnRuntimeFile = (): void => {
    try {
      const record = readRuntimeFile(options.stateDir)
      if (record === null) return
      if (record.pid !== pid) return
      if (instanceId !== undefined && record.instanceId !== instanceId) return
      unlinkSync(runtimeFilePath(options.stateDir))
      diagnostic('agent-ping: this instance\'s runtime file was removed')
    } catch (cause) {
      // A runtime file that cannot be removed is not a reason to refuse to exit: a
      // file left by a process that is no longer running is reclaimed on the next
      // start (src/hub/runtime-file.ts), and a daemon that will not die is worse than
      // a stale file.
      diagnostic(
        `agent-ping: the runtime file could not be removed (${
          cause instanceof Error ? cause.name : 'unknown error'
        }); the next start will reclaim it`,
      )
    }
  }

  const shutdown = (why: string): Promise<void> => {
    // One shutdown per process. A second caller - Electron's before-quit, a CLI, a
    // test - gets the first one's promise rather than a second ordered close and a
    // second exit.
    if (inFlight !== undefined) return inFlight
    begin(why)
    inFlight = (async (): Promise<void> => {
      // One flag for "this shutdown did not finish cleanly", set by either failure path.
      // Without it the second one would fall through to the clean exit below and report
      // success for a shutdown that failed, which is the one thing an exit status is
      // trusted for.
      let failed = false
      // Refed, unlike every other timer on this hub's request paths: an unrefed timer
      // would let a wedged close take the process out of existence without closing the
      // log or removing the runtime file, which is the silent shape this bound exists
      // to prevent.
      const grace = setTimeout(() => {
        failed = true
        forced = true
        diagnostic(
          `agent-ping: the ordered close did not finish within ${graceMs} ms; this is a wedged ` +
            'shutdown, and the exit status says so',
        )
        removeOwnRuntimeFile()
        exit(SHUTDOWN_FAILURE_EXIT_CODE)
      }, graceMs)
      try {
        await options.close()
      } catch (cause) {
        failed = true
        forced = true
        diagnostic(
          `agent-ping: the ordered close failed (${
            cause instanceof Error ? cause.name : 'unknown error'
          }); the hub stopped with its log reported as unclosed rather than as clean`,
        )
        exit(SHUTDOWN_FAILURE_EXIT_CODE)
      } finally {
        clearTimeout(grace)
      }
      finish()
      // Skipped when either failure path already fired: that path exited, and a second
      // exit with a different code would overwrite the failure with a success.
      if (!failed) exit(SHUTDOWN_CLEAN_EXIT_CODE)
    })()
    return inFlight
  }

  return {
    state: (): HubStateReport => ({ state, since, reason, forced }),

    markRunning: (): void => {
      if (state !== 'starting') return
      to('running')
    },

    install: (): void => {
      if (installed.length > 0) return
      for (const signal of signals) {
        // One closure per signal, so the diagnostic names the one that actually fired
        // rather than a shared mutable "last signal" two handlers race over.
        const handler = (): void => {
          void shutdown(`signal:${signal}`)
        }
        source.on(signal, handler)
        installed.push({ signal, handler })
      }
    },

    dispose,

    begin,

    finish,

    shutdown,

    handledSignals: (): readonly string[] => [...signals],
  }
}
