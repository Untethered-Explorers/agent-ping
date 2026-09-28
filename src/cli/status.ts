// `agent-ping status`: what is outstanding, when the last thing happened, how long the
// hub has been up, and how many sessions are live (IO-FR-05).
//
// FOUR NUMBERS, AND THE ROUTE EACH ONE COMES FROM
// The pending count is `GET /api/pending`, which is the same accessor the tray badge
// reads, so the number in a terminal and the number on the icon cannot disagree. The
// most recent event is one row of the bounded history, asked for with `limit=1` so the
// read is bounded however long the log is. The uptime is the health payload's own,
// computed by the process that started rather than re-derived from a timestamp here. The
// active sessions are the session list filtered by the two live states. Nothing in this
// file re-derives a fact another module owns (HC-FR-02, NT-FR-05).
//
// "THE HUB IS NOT RUNNING" IS A SENTENCE, NOT AN ABSENCE
// IO-FR-05 asks for the command to say so plainly, and the reason it insists is that an
// empty result reads as a product with nothing to report rather than as a product whose
// hub is down. So the down branch prints the reason it could not be reached - no runtime
// file, still starting, a stale file, another program on the port - together with the
// remedy, and never a table of zeroes.
//
// THE EXIT CODE IS ZERO WHEN THE HUB IS DOWN, AND THAT IS A DECISION
// A stopped sidecar is a supported state, not a fault: the autostart unit starts it at
// login, and a developer who closed the tray has not broken anything. `doctor` is the
// command whose exit code means "something is wrong" (IO-FR-04). A `status` that exited
// non-zero for a healthy stopped hub would be useless in the script that has to ask
// "is it up?" before deciding what to do next. The plain sentence is the answer.

import { readStatus, type HubReadOptions, type HubUnreachable, type HubStatusReport } from './hub-client.js'
import type { LocalLog } from './log.js'
import { formatDuration, formatTimestamp, kv, printed, type Row } from './output.js'

export interface StatusOptions {
  readonly stateDir: string
  /** The loopback read. Defaults to the state directory above, over a real socket. */
  readonly hub?: HubReadOptions
  readonly log?: LocalLog
  /** Injected so a test's expected output does not depend on the wall clock. */
  readonly now?: () => Date
}

function runningLines(report: HubStatusReport, now: Date): readonly string[] {
  const rows: readonly Row[] = [
    ['origin', report.origin],
    ['uptime', formatDuration(report.uptimeSeconds)],
    ['pending', String(report.pendingCount)],
    [
      'last event',
      report.lastEventAt === null ? 'none recorded' : formatTimestamp(report.lastEventAt, now),
    ],
    ['active sessions', `${String(report.activeSessions)} of ${String(report.totalSessions)}`],
    ['delivery', report.deliveryStatus],
  ]
  return [
    'agent-ping: the hub is running.',
    ...kv(rows),
    // The delivery status is not decoration. A hub whose surface cannot show a card is
    // the commonest reason a developer runs this at all, and `not-wired` is the honest
    // word for it (APX-FR-02, NT-FR-09).
    ...(report.deliveryLastFailure === null
      ? []
      : [`  last delivery failure: ${report.deliveryLastFailure}`]),
  ]
}

function downLines(failure: HubUnreachable): readonly string[] {
  return [
    'agent-ping: the hub is not running.',
    ...kv([
      ['reason', failure.detail],
      ['remedy', failure.remedy],
    ]),
  ]
}

export async function runStatus(options: StatusOptions): Promise<ReturnType<typeof printed>> {
  const now = options.now ?? ((): Date => new Date())
  const reading = await readStatus(options.hub ?? { stateDir: options.stateDir })
  if (reading.kind === 'down') {
    // `reason` rather than `hub`: the failure kind is a closed token and `hub` holds a
    // loopback origin. The log's per-field kinds caught that a test never had to.
    options.log?.info('status.read', { outcome: 'hub-not-running', reason: reading.failure.kind })
    return printed(downLines(reading.failure), 0, 'status.read', {
      outcome: 'hub-not-running',
      reason: reading.failure.kind,
    })
  }
  const report = reading
  options.log?.info('status.read', {
    outcome: 'hub-running',
    hub: report.origin,
    port: report.port,
    pending: report.pendingCount,
  })
  return printed(runningLines(report, now()), 0, 'status.read', {
    outcome: 'hub-running',
    hub: report.origin,
    port: report.port,
    pending: report.pendingCount,
  })
}
