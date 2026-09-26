// `GET /api/stream`: the live state stream a dashboard holds open instead of
// polling (HC-FR-03, PRD 6.3).
//
// WHAT THIS ROUTE IS
// Transport, and nothing else. The frame shapes, the cursor, the replay window
// and the decision about what a reconnecting client needs all live in
// ../sse.ts, and this file's whole job is to put them on a socket: the media
// type, the preamble that flushes the headers, the subscriber, and the
// unsubscribe when the client goes away.
//
// IT IS A READ
// The route is registered as `read-only` and it is a GET, and that is not a
// convention here: tests/hub/server.test.ts walks the enumerated registry and
// compares stored counts around every request, including this one. Nothing in
// this file writes - the only writes in the product are the ack route (HC-4) and
// the ingest pipeline's own store call, neither of which is reachable from here.
// There is no way to make a harness do anything from this connection, and no
// route that could (APX-CON-08).
//
// ORDER IS THE PART THAT MATTERS
// The order in `serveStream` is load-bearing and the test asserts it:
//
//   1. The client limit, before anything is written, so a refused client gets a
//      JSON error and not half a stream.
//   2. The replay plan, computed from the retained window.
//   3. The headers and the preamble, which is what makes a browser's EventSource
//      fire `open` immediately instead of after the first change.
//   4. The subscription - and only then the `ready` frame and whatever the plan
//      called for.
//
// The subscription comes before the first frame on purpose. Between reading the
// current cursor and subscribing there is no gap, because this handler is
// synchronous: nothing else in the process can publish in the middle of it. The
// other order would leave a window in which a change is published, is missing
// from the plan, and is not yet delivered to a connected client - a change the
// client would never see and would never be told it missed.
//
// WHAT A CLIENT GETS
//   - No cursor: `ready`, then live changes. A first connection is expected to
//     have read the read routes already.
//   - A cursor this feed can honour: `ready`, then exactly the changes it missed,
//     in cursor order, then live changes.
//   - Any other cursor: `ready`, then `refresh-required` naming why, and no change
//     frames at all. A client that is too far behind re-reads the hub; it is
//     never handed a partial replay that looks like current state.
//
// SECURITY, INHERITED AND NOT REPEATED
// The stream carries no cross-origin header of any kind, so a page the developer
// visits cannot read a session's changes through the browser, and it carries no
// token because it changes nothing (HC-FR-06, ADR-002). The loopback check has
// already run before this handler: it is in the listener, ahead of routing, and
// a refused request never reaches a frame.

import type { IncomingMessage } from 'node:http'
import { baseHeaders, respondJson, type RouteContext, type RouteDefinition } from '../server.js'
import {
  changeFrame,
  cursorRequest,
  encodeStreamPreamble,
  planReplay,
  readyFrame,
  refreshRequiredFrame,
  writeFrame,
  STREAM_CONTENT_TYPE,
  STREAM_RECONNECT_HINT_MS,
  type ChangeFeed,
  type CursorRequest,
  type FrameSink,
} from '../sse.js'
import type { HubServices } from './read.js'

/**
 * The stream route, in the same shape as the read routes so the composition root
 * registers it from one list and the enumeration test sees it (HC-FR-02).
 */
export const STREAM_ROUTES: readonly RouteDefinition<HubServices>[] = [
  {
    method: 'GET',
    pattern: '/api/stream',
    name: 'stream.state',
    mutation: 'read-only',
    handle: (context): void => {
      serveStream(context, context.services.stream)
    },
  },
]

/**
 * Read the cursor a client arrived with.
 *
 * `?cursor=` first, then `Last-Event-ID`. Both are part of the contract rather
 * than one of them being a convenience: the header is what a browser's
 * `EventSource` sends when it reconnects by itself, and the parameter is what a
 * client that reloaded the page - and lost its last event id - has left. An
 * unusable value is reported as unusable rather than treated as absent, so a
 * broken client is told to refresh and a new one is not.
 */
export function readRequestedCursor(
  request: IncomingMessage,
  query: URLSearchParams,
): CursorRequest {
  const parameter = query.get('cursor')
  // An empty parameter carries no information, so it falls through to the header
  // rather than overriding it with nothing: `?cursor=` is a template that had no
  // value, not a client asserting cursor zero.
  if (parameter !== null && parameter.trim() !== '') return cursorRequest(parameter)
  const header = request.headers['last-event-id']
  if (typeof header === 'string' && header.trim() !== '') return cursorRequest(header)
  return { kind: 'none' }
}

function serveStream(
  { request, response, query }: RouteContext<HubServices>,
  feed: ChangeFeed,
): void {
  // 1. The client limit, answered as JSON before a single byte of stream exists.
  if (feed.subscriberCount() >= feed.settings.maxClients) {
    respondJson(response, 503, {
      error: 'too-many-stream-clients',
      message: `this hub streams to ${feed.settings.maxClients} clients at once. Close a dashboard ` +
        'and reconnect; nothing is queued, because a queue is a latency nobody asked for.',
    })
    return
  }

  // 2. What this client needs, decided from the retained window alone.
  const plan = planReplay({
    retained: feed.retainedFrames(),
    currentCursor: feed.currentCursor(),
    requested: readRequestedCursor(request, query),
  })

  // 3. The headers and the preamble. A comment line is the cheapest way to make
  //    the operating system push the response head out, which is what turns a
  //    connected EventSource into an `open` event rather than a connection that
  //    looks idle until the first change happens to arrive.
  for (const [name, value] of Object.entries(baseHeaders(STREAM_CONTENT_TYPE))) {
    response.setHeader(name, value)
  }
  response.statusCode = 200
  response.write(encodeStreamPreamble('agent-ping state stream', STREAM_RECONNECT_HINT_MS))

  // 4. Subscribe, then write. See the note above: this order is what makes the
  //    plan and the live frames cover every change exactly once.
  let finished = false
  // Declared before the exit that uses it, because `finish` can be reached from
  // the subscription below before `subscribe` has returned. The initial value is
  // the no-op, and it is only ever called before the real one exists if the
  // subscription is never made at all - in which case there is nothing to
  // release.
  let unsubscribe = (): void => undefined
  const sink: FrameSink = {
    write: (chunk): boolean => {
      if (response.writableEnded || response.destroyed) return false
      return response.write(chunk)
    },
    end: (): void => {
      if (response.writableEnded) return
      response.end()
    },
  }
  // The one exit from a stream, taken from three directions: the client went
  // away, a client stopped reading, or the hub is closing. All three end the
  // response and release the subscription, and all three are idempotent, so a
  // response is never left with a subscriber on it and an unsubscribe is never
  // run twice.
  const finish = (): void => {
    if (finished) return
    finished = true
    unsubscribe()
    sink.end()
  }

  unsubscribe = feed.subscribe({
    onFrame: (frame): void => {
      if (finished) return
      // A client that stops reading is closed rather than buffered; it reconnects
      // with the cursor it last applied and `planReplay` hands it what it missed.
      if (!writeFrame(sink, frame)) finish()
    },
    onHeartbeat: (frame): void => {
      if (finished) return
      if (!writeFrame(sink, frame)) finish()
    },
    onClose: (): void => {
      // The hub is closing. Nothing is written: the port is going away and the
      // retry hint the client was given at open is what governs what it does
      // next.
      finish()
    },
  })

  // The client going away is the direction this handler cannot see itself.
  response.on('close', () => {
    finish()
  })
  response.on('error', () => {
    finish()
  })

  // A request that reached the route after the feed was closed - the window between
  // `hub.close` ending the streams and the listener going away - is answered by
  // ending the response rather than by opening a stream nothing will ever write to.
  // Without this the client would sit on an open connection until the server's
  // keep-alive timeout, and the shutdown would wait for it.
  if (feed.isClosed()) {
    finish()
    return
  }

  const at = new Date().toISOString()
  const ready = readyFrame({
    cursor: feed.currentCursor(),
    oldestRetainedCursor: feed.oldestRetainedCursor(),
    heartbeatIntervalMs: feed.settings.heartbeatIntervalMs,
    replayWindowMs: feed.settings.replayWindowMs,
    replayMaxFrames: feed.settings.replayMaxFrames,
    at,
  })
  if (!writeFrame(sink, ready)) {
    finish()
    return
  }
  if (plan.kind === 'refresh-required') {
    // Explicit, and alone: no partial replay follows it.
    writeFrame(sink, refreshRequiredFrame(plan, at))
    return
  }
  for (const change of plan.kind === 'replay' ? plan.frames : []) {
    if (!writeFrame(sink, changeFrame(change))) {
      finish()
      return
    }
  }
}
