// The prototype's only data source (DP-FR-06).
//
// Everything the prototype draws comes from this module and nothing else. There
// is no hub, no plugin, no network request, no filesystem read and no live data
// on this path (DP-FR-01); the whole page is a function of the constants below.
//
// Determinism is the point. Identifiers, paths and timestamps are literals and
// ages are measured against PROTOTYPE_NOW rather than the machine clock, so two
// runs of the page, and every assertion in tests/dashboard, see the same pixels
// and the same strings.

/** The three states a session row can be drawn in (DP-FR-03). */
export type SessionState = 'blocked' | 'finished' | 'running'

export interface MockSession {
  /** Fixed and unique. The DOM mirror and later focus handling key on this. */
  readonly id: string
  readonly state: SessionState
  /** The session's own short label, e.g. "wire the live dashboard". */
  readonly label: string
  /**
   * One line of state text for the row. This is a status sentence produced by
   * the dashboard, never conversation content (APX-FR-01).
   */
  readonly status: string
  /** ISO-8601 UTC instant of the last event. Fixed; never derived from a clock. */
  readonly lastEventAt: string
}

export interface MockRepository {
  readonly id: string
  /** The full checkout path. Identity is the short name, not this (APX-CON-09). */
  readonly path: string
  readonly sessions: readonly MockSession[]
}

/**
 * The instant every prototype age is measured against. Using a literal rather
 * than `Date.now()` is what makes the rendered ages assertable.
 */
export const PROTOTYPE_NOW = '2026-09-26T12:00:00.000Z'

/**
 * The directory basename of a repository path, which is the identity the
 * dashboard groups and labels by (APX-CON-09).
 *
 * LD-1 replaces this with connector-engineer's identity helper once the
 * connector lands; the prototype needs it here only so the rule is exercised
 * rather than restated as a second hardcoded string.
 */
export function repositoryShortName(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '')
  const segments = trimmed.split(/[/\\]/)
  const last = segments[segments.length - 1] ?? trimmed
  return last === '' ? trimmed : last
}

/**
 * Three rows across two repositories, covering the three interesting cases the
 * design review needs: a blocked session and a finished session in the same
 * repository, and a running session in a second one.
 *
 * The finished session is listed *first* on purpose. Ordering is a property of
 * the renderer (see `orderSessions` in scene.ts), so the fixture must not hand
 * the renderer the answer it is supposed to produce.
 */
export const PROTOTYPE_REPOSITORIES: readonly MockRepository[] = Object.freeze([
  Object.freeze({
    id: 'repo-agent-ping',
    path: '/home/dev/Projects/agent-ping',
    sessions: Object.freeze([
      Object.freeze({
        id: 'session-ingest-route',
        state: 'finished' as const,
        label: 'add the ingest route',
        status: 'changes are ready, nothing else is needed',
        lastEventAt: '2026-09-26T09:55:00.000Z',
      }),
      Object.freeze({
        id: 'session-ack-flow',
        state: 'blocked' as const,
        label: 'confirm the ack flow',
        status: 'waiting on your decision to continue',
        lastEventAt: '2026-09-26T11:52:00.000Z',
      }),
    ]),
  }),
  Object.freeze({
    id: 'repo-knowledge-dungeon',
    path: '/home/dev/Projects/knowledge-dungeon',
    sessions: Object.freeze([
      Object.freeze({
        id: 'session-village-objects',
        state: 'running' as const,
        label: 'render the session list',
        status: 'working through the queued items',
        lastEventAt: '2026-09-26T11:58:00.000Z',
      }),
    ]),
  }),
])
