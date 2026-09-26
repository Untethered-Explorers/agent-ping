// The opencode plugin: one module, loaded for every session, that subscribes to
// opencode's own events and reports what they are worth to the local hub
// (OA-FR-01, OA-FR-02, OA-FR-03, OA-FR-05, OA-FR-06, OA-FR-09, APX-CON-03,
// APX-CON-09, APX-CON-13).
//
// THE HOOKS, AND WHY THESE THREE
//   - `event`: the generic hook, and the only path to a permission ask. The
//     dedicated `permission.ask` hook is reported as never firing upstream (PRD 5),
//     so it is not subscribed at all: a hook that cannot fire adapts into a block
//     signal that never arrives and a test that passes anyway (OA-FR-02).
//   - `tool.execute.before` / `tool.execute.after`: the only path to a tool boundary
//     in the 1.18.32 plugin API. PRD 5 records the `event` hook as delivering both
//     names; the installed types deliver them as hooks, so the plugin takes both
//     paths and they share one row, one reader and one set of identities. Which of
//     the two the harness uses changes nothing downstream, and the row-by-row
//     evidence is in src/plugin/opencode/translate.ts.
//
// WHAT THE PLUGIN DELIBERATELY DOES NOT DO
//   - It does not read configuration. There is no per-repository file, no
//     environment variable and no registry: the plugin's whole input is the harness
//     directory and the events, so an interactive session, a `opencode run` and a
//     session attached to a running server all take the same path and none of them
//     can be invisible because a repository was never set up (OA-FR-09, ADR-006).
//   - It does not own the session. It reads events, translates them and hands them
//     to a delivery port; it never writes to a session, never answers a permission,
//     never calls a tool and never blocks. A developer's session must behave exactly
//     as it would with no plugin installed (APX-CON-03, APX-CON-10).
//   - It does not deliver itself. Delivery is the `deliver` port below, and OA-2
//     supplies the real one: the loopback hub's live port, the per-install token, a
//     bounded timeout and no retry storm. Until then the plugin translates and says
//     so, once, in the harness's own log.
//
// NOTHING THROWS INTO THE HARNESS
// Every hook body is wrapped, a delivery port that throws or rejects is caught, and
// a logging client that fails is caught inside the logger. The developer's session
// continues in every one of those cases, which is the outcome that is never negotiable
// (APX-CON-03). What is not negotiable in the other direction is visibility: a
// translation that fails becomes a breadcrumb through the harness's own logging
// client, naming the service, the session and the event type (OA-FR-05, APX-FR-02).
//
// WHAT A BREADCRUMB MAY CARRY
// The harness's log is a surface a developer reads and a log file keeps, so a
// breadcrumb carries a service name, a session id, an event name, a variant and a
// reason code - and never a payload, a path, a measurement or an error message. A
// provider error message is where a failed request is echoed back, so even an
// unexpected internal fault reports its error *name* and not its text.
//
// HANDOFFS, WRITTEN DOWN WHERE THE NEXT TASK WILL LOOK
//   - OA-2 owns delivery: `deliver` is the port, and the shared service name is
//     `AGENT_PING_SERVICE` from the translator so the transport and the plugin write
//     their lines under one name.
//   - OA-3 owns installation. The three modules here are the adapter's source; the
//     installed artefact is ONE plugin file, so the installer emits a single
//     directly-loadable file and is responsible for making the classifier reachable
//     from it rather than copying the classification rules into it (ADR-005, ADR-006).
//   - OA-4 owns the polling fallback, and it starts from the same entry point below
//     when no delivery port is wired. It must take its transition identities from
//     `translator.currentTransitionId` rather than minting keys of its own, or a
//     session that both pushes and is polled produces two of everything (OA-FR-07).

import type {
  HarnessLog,
  OpencodeEvent,
  OpencodeLogClient,
  OpencodeToolBoundary,
  TranslatedSignal,
} from './translate.js'
import { AGENT_PING_SERVICE, createHarnessLog, createTranslator } from './translate.js'
import type { HarnessSignal } from '../../domain/classify.js'
import { ClassificationError } from '../../domain/classify.js'

/** The harness this adapter speaks for, named where a breadcrumb reports it. */
const HARNESS_NAME = 'opencode'

// ---------------------------------------------------------------------------
// The harness's plugin surface
// ---------------------------------------------------------------------------

/**
 * What opencode hands a plugin.
 *
 * Three fields, all of them the harness telling the truth about itself: the client
 * (used here only for `app.log`), the directory the session is working in (the
 * repository's full path, APX-CON-09), and the worktree. Everything else the
 * `PluginInput` type carries - the project, the experimental workspace registry, the
 * shell - is deliberately not part of this declaration, because a plugin surface
 * this adapter can reach is a smaller one.
 */
export interface OpencodePluginInput {
  readonly client: OpencodeLogClient
  readonly directory: string
  readonly worktree?: string
}

/**
 * The delivery port, injected rather than reached for.
 *
 * One signal in, fire and forget: the port is not awaited, a throw is caught, and a
 * rejection is caught too. The bounded timeout, the live port, the shared token and
 * the breadcrumb on an unreachable hub are OA-2's transport; this module's contract
 * with it is exactly this signature (OA-FR-04, APX-CON-10).
 */
export type DeliverPort = (signal: HarnessSignal) => void | Promise<void>

/**
 * The plugin options the installer may configure.
 *
 * opencode passes plugin options as a free-form record, so the one key that means
 * something to this adapter is read by name and validated by shape; anything else in
 * the record is ignored rather than interpreted.
 */
export interface AgentPingPluginOptions {
  /** The delivery port. Absent means "not wired", which is reported once. */
  readonly deliver?: DeliverPort
}

/** The hooks this plugin returns. Nothing else is a hook opencode may call. */
export interface OpencodePluginHooks {
  event?: (input: { readonly event: OpencodeEvent }) => Promise<void>
  'tool.execute.before'?: (input: OpencodeToolBoundary) => Promise<void>
  'tool.execute.after'?: (input: OpencodeToolBoundary) => Promise<void>
}

/** The plugin shape opencode loads: a promise of hooks. */
export type OpencodePlugin = (
  input: OpencodePluginInput,
  options?: Readonly<Record<string, unknown>>,
) => Promise<OpencodePluginHooks>

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------

/**
 * agent-ping's opencode plugin.
 *
 * A named export, which is the convention the harness's own example plugin uses
 * (`@opencode-ai/plugin` exports `ExamplePlugin` and nothing else): one function, one
 * set of hooks, loaded once for every session on this machine.
 */
export const AGENT_PING_PLUGIN: OpencodePlugin = async (input, options) => {
  const log = createHarnessLog(input.client, { directory: input.directory })
  const directory = input.directory
  if (typeof directory !== 'string' || directory === '') {
    // No session directory means no repository identity, and identity is the one
    // thing every event carries (APX-CON-09, ADR-008). Reporting without it would be
    // reporting under a label this product cannot derive, so the adapter says why it
    // is silent and returns no hooks rather than a session's worth of nothing.
    log.warn({
      message:
        'agent-ping did not subscribe: the harness reported no session directory, so there is no repository to report against. This is a capability gap, not a quiet session.',
    })
    return {}
  }

  const translator = createTranslator({ directory })
  const deliver = deliverOf(options)
  const state = { unwiredReported: false, unattributedReported: false }

  /**
   * Hand one signal to the delivery port, and never await it.
   *
   * The three failure modes are all handled here rather than by the caller: a port
   * that was never wired (reported once, so a missing transport is visible without
   * becoming a line per event), a port that throws, and a port that rejects. None of
   * them may become an exception in the developer's session (APX-CON-03, APX-CON-10).
   */
  const publish = (translated: TranslatedSignal | null): void => {
    if (translated === null) {
      if (translator.stats.unattributed > 0 && !state.unattributedReported) {
        state.unattributedReported = true
        log.warn({
          message:
            'agent-ping received an event it maps but could not attribute to a session, so it reported nothing for it. The harness payload is expected to name a session.',
        })
      }
      return
    }
    const { signal } = translated
    log.debug({
      message: 'agent-ping translated an opencode event',
      extra: {
        harness: signal.harness,
        eventName: signal.eventName,
        ...(signal.variant === undefined ? {} : { variant: signal.variant }),
        sessionId: signal.sessionId,
        outcome: translated.classification.outcome,
        ...(translated.classification.outcome === 'no-event'
          ? { reason: translated.classification.reason }
          : {}),
      },
    })
    if (deliver === undefined) {
      if (!state.unwiredReported) {
        state.unwiredReported = true
        log.warn({
          message:
            'agent-ping translated an event but no delivery port is wired, so it was not reported to the hub. The adapter is installed; the transport is not connected.',
        })
      }
      return
    }
    const ref: FailureRef = {
      eventName: signal.eventName,
      sessionId: signal.sessionId,
      ...(signal.variant === undefined ? {} : { variant: signal.variant }),
    }
    try {
      const result = deliver(signal)
      if (isThenable(result)) {
        result.then(undefined, (cause: unknown) => {
          breadcrumbFor(log, ref, cause, 'delivery-rejected')
        })
      }
    } catch (cause) {
      breadcrumbFor(log, ref, cause, 'delivery-failed')
    }
  }

  /** Translate one event, whatever the event is, and never throw out of here. */
  const observe = (event: OpencodeEvent): Promise<void> => {
    try {
      publish(translator.observe(event))
    } catch (cause) {
      // The signal was never built, so the session is asked of the event itself
      // through the translator's own reader - a breadcrumb that named the event but
      // not the session would be half the visibility the requirement asks for
      // (OA-FR-05).
      const sessionId = translator.sessionIdOf(event)
      breadcrumbFor(
        log,
        { eventName: event?.type ?? 'unknown', ...(sessionId === undefined ? {} : { sessionId }) },
        cause,
        'translate-failed',
      )
    }
    return Promise.resolve()
  }

  return {
    event: (input) => observe(input.event),
    // The same event, spelled as the event the table knows: one row, one reader, and
    // no second path that can be fixed without the other being fixed.
    'tool.execute.before': (boundary) =>
      observe({ type: 'tool.execute.before', properties: boundary }),
    'tool.execute.after': (boundary) => observe({ type: 'tool.execute.after', properties: boundary }),
  }
}

/** What a failure breadcrumb may name: three closed tokens and a session id. */
interface FailureRef {
  readonly eventName: string
  readonly variant?: string
  readonly sessionId?: string
}

/**
 * A failure, as a breadcrumb the developer can act on.
 *
 * A classification failure is the interesting one, and the classifier has already
 * done the work of making it safe to show: the error carries the signal as three
 * closed tokens and a code, and its message is written to quote no value, because
 * that message is written to a log and shown in a breadcrumb (OA-FR-05,
 * src/domain/classify.ts). So the breadcrumb carries the classifier's own text and
 * the session the event belonged to, which is the three things the requirement names
 * - the service, the session, the event type.
 *
 * Anything else is an internal fault. Its *name* is reported and its message is not,
 * because a fault in a payload reader is the kind of fault whose message is built
 * from the value it choked on, and a value in a log line is content (APX-FR-01).
 */
function breadcrumbFor(
  log: HarnessLog,
  ref: FailureRef,
  cause: unknown,
  stage: 'translate-failed' | 'delivery-failed' | 'delivery-rejected',
): void {
  if (cause instanceof ClassificationError) {
    log.warn({
      message: `agent-ping could not report an opencode event: ${cause.message}`,
      extra: {
        service: AGENT_PING_SERVICE,
        stage,
        code: cause.code,
        harness: cause.signal.harness,
        eventName: cause.signal.eventName,
        variant: cause.signal.variant,
        ...(ref.sessionId === undefined ? {} : { sessionId: ref.sessionId }),
      },
    })
    return
  }
  log.warn({
    message:
      'agent-ping hit an internal fault while observing an opencode event; the session was not affected and nothing was reported.',
    extra: {
      service: AGENT_PING_SERVICE,
      stage,
      code: 'internal',
      harness: HARNESS_NAME,
      eventName: ref.eventName,
      ...(ref.variant === undefined ? {} : { variant: ref.variant }),
      ...(ref.sessionId === undefined ? {} : { sessionId: ref.sessionId }),
      errorName: errorNameOf(cause),
    },
  })
}

/**
 * The delivery port from the options record, or undefined.
 *
 * Read by name and checked by shape, so a mistyped configuration is "not wired" -
 * which is reported - rather than a call that throws on the first event.
 */
function deliverOf(options: Readonly<Record<string, unknown>> | undefined): DeliverPort | undefined {
  const candidate = options?.['deliver']
  return typeof candidate === 'function' ? (candidate as DeliverPort) : undefined
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

/** The class name of a fault, and never its message. */
function errorNameOf(cause: unknown): string {
  if (cause instanceof Error) return cause.name
  return 'unknown'
}
