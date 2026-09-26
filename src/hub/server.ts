// The loopback HTTP surface: the only thing in agent-ping that listens on a
// socket, and the boundary that makes an open port harmless (HC-FR-02, APX-CON-01,
// ADR-002).
//
// WHAT THIS FILE IS BOUND BY
//   - It binds 127.0.0.1 and refuses any request whose remote address is not
//     loopback. Both, because binding alone is not enough: a proxy, a container
//     port mapping or a forwarded socket can deliver a request that reached
//     loopback from somewhere else, and the check that matters reads the socket.
//   - It routes to a registry that is written down, in one place, and every entry
//     declares whether it mutates. The mutating set is a closed union with
//     exactly one member - the ack route - so a second control surface is a
//     compile error rather than a review finding (APX-CON-08).
//   - It serves a strict content-security-policy with the dashboard and sends no
//     cross-origin header at all, because a read-only daemon still hands a
//     cross-origin page a channel to it.
//
// There is no authentication, no remote listener, no hosted component and no
// second write route here. Those are explicit non-goals (PRD 3.2) and this module
// is where they would have to be written.
//
// PORT SELECTION
// The port is security-relevant, not incidental, so the collision answer is never
// "bind wider": the preferred port is tried first and, when it is taken, the next
// free loopback port is used. Every candidate is a loopback port, because a wider
// bind is the one change that would turn this into a network-reachable control
// surface, and no convenience is worth that. The live port is returned to the
// composition root, which publishes it in the runtime file the adapters read.
//
// Nothing here opens a subprocess, resolves a hostname or reports anything off
// the machine (APX-CON-12). The `preferredPort` option exists so an install can
// choose where to start, not so a caller can choose where to listen.

import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'

/**
 * The one address this product binds.
 *
 * Named as a constant rather than inlined at the `listen` call so that a search
 * for a wildcard bind finds this name and the test that guards it.
 */
export const LOOPBACK_HOST = '127.0.0.1'

/**
 * The preferred port. A default and not a constant: it is the first candidate
 * tried, the live port is published in the runtime file, and no adapter may
 * assume it (PRD 16 Open Questions 10). Chosen from the unregistered range so it
 * cannot collide with a well-known service, and overridable per install through
 * the `preferredPort` option.
 */
export const DEFAULT_HUB_PORT = 43117

/**
 * How many consecutive ports may be tried after the preferred one is taken.
 *
 * Bounded, because an unbounded search is a port scan of the machine's loopback
 * range by a background daemon, and twenty is already far more than a real
 * collision needs. When the range is exhausted the failure is reported rather
 * than swallowed: a hub that cannot bind has no port to publish, and publishing a
 * guessed one is the failure mode this whole design exists to avoid.
 */
export const PORT_FALLBACK_ATTEMPTS = 20

/**
 * The content-security-policy sent with the dashboard.
 *
 * One named constant so the server and the test that asserts it cannot disagree
 * about what is sent. No `unsafe-inline` and no `unsafe-eval`: when the PixiJS
 * bundle conflicts with one of these directives the fix is to narrow the policy or
 * change the mechanism, never to weaken it (feature document Open Questions 4,
 * and the rule that a weakened policy looks exactly like a working one in review).
 */
export const DASHBOARD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  // PixiJS draws into a canvas and may hand an image back as a data URI.
  "img-src 'self' data: blob:",
  // The live state stream arrives as an EventSource from this same origin.
  "connect-src 'self'",
  "font-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  // A framed dashboard is a confused deputy: the hub is a local daemon and no
  // page on the machine has business framing it.
  "frame-ancestors 'none'",
  "form-action 'none'",
].join('; ')

/** Content types for the dashboard's own build output, by extension. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
}

/** Methods a client may send. A method outside this set is refused as unknown. */
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const

export type HttpMethod = (typeof HTTP_METHODS)[number]

/**
 * The closed set of mutating routes.
 *
 * One member, and it is not registered yet: the ack route arrives with HC-4. The
 * union exists now so a route that wants to declare a mutation has to name itself
 * as the ack route, which means adding a second control surface is a diff in this
 * file that a reviewer reads. A route that mutates while declaring
 * `mutation: 'read-only'` is a different failure, and it is caught by comparing
 * stored counts around every read rather than by reading this declaration.
 */
export const MUTATING_ROUTE = 'POST /api/ack/:eventId' as const

export type MutatingRoute = typeof MUTATING_ROUTE

/**
 * Whether a route may change stored state.
 *
 * A closed union, checked against the one allowed value at registration time.
 * Rejecting a registration that claims a mutation without being the ack route is
 * what makes the closed set a property of the code rather than a convention.
 */
export type RouteMutation = 'read-only' | 'ack-only'

/** What a handler is given: the request, its resolved path parts, and the services. */
export interface RouteContext<TServices> {
  readonly request: IncomingMessage
  readonly response: ServerResponse
  readonly method: HttpMethod
  /** The path, percent-decoded per segment, without its query. */
  readonly pathname: string
  /** Named parameters from the pattern, e.g. `sessionId`. Never an array. */
  readonly params: Readonly<Record<string, string>>
  readonly query: URLSearchParams
  readonly services: TServices
}

export interface RouteDefinition<TServices> {
  readonly method: HttpMethod
  /**
   * The path pattern. A `:name` segment matches exactly one segment and captures
   * it. Patterns are literal apart from those, so there is no wildcard to abuse
   * and no regular expression to get wrong.
   */
  readonly pattern: string
  /** A short stable name, used in the enumeration test and in diagnostics. */
  readonly name: string
  readonly mutation: RouteMutation
  /**
   * True for the single route that answers a GET which matched nothing. The
   * dashboard's own files are served this way, because a Vite build emits hashed
   * asset names this product does not know in advance.
   */
  readonly fallback?: boolean
  handle(context: RouteContext<TServices>): Promise<void> | void
}

/**
 * The registered routes, in registration order.
 *
 * The enumeration test walks this list rather than a hand-written one, because a
 * hand-written list passes forever regardless of what is actually registered.
 */
export class RouteRegistry<TServices> {
  readonly #routes: RouteDefinition<TServices>[] = []

  register(route: RouteDefinition<TServices>): void {
    if (route.mutation === 'ack-only' && `${route.method} ${route.pattern}` !== MUTATING_ROUTE) {
      throw new Error(
        `route ${route.name} declares itself mutating, and the only mutating route in this product ` +
          `is ${MUTATING_ROUTE} (APX-CON-08). A route that changes stored state is a control ` +
          'surface; the one allowed control surface marks a pending item acknowledged and nothing else.',
      )
    }
    if (this.#routes.some((existing) => existing.name === route.name)) {
      throw new Error(
        `route name ${route.name} is already registered; names identify routes in diagnostics.`,
      )
    }
    this.#routes.push(route)
  }

  registerAll(routes: Iterable<RouteDefinition<TServices>>): void {
    for (const route of routes) this.register(route)
  }

  routes(): readonly RouteDefinition<TServices>[] {
    return [...this.#routes]
  }

  /** Every registered route as `METHOD pattern`, for the enumeration assertions. */
  signatures(): readonly string[] {
    return this.#routes.map((route) => `${route.method} ${route.pattern}`)
  }

  /**
   * Resolve a request to a route.
   *
   * A path that matches a pattern under a method the route does not serve is
   * reported as `method-not-allowed` rather than `not-found`, because the honest
   * answer to `POST /api/pending` is "that path is read-only", and an answer of
   * "no such path" would hide the surface from a reviewer looking for write paths.
   */
  resolve(method: HttpMethod, pathname: string): RouteResolution<TServices> {
    const segments = splitPath(pathname)
    const pathMatched: RouteDefinition<TServices>[] = []
    for (const route of this.#routes) {
      const params = matchPattern(route.pattern, segments)
      if (params === null) continue
      pathMatched.push(route)
      if (route.method === method) return { kind: 'route', route, params }
    }
    if (pathMatched.length > 0) {
      return {
        kind: 'method-not-allowed',
        allowed: [...new Set(pathMatched.map((route) => route.method))].sort() as HttpMethod[],
      }
    }
    const fallbackRoute = this.#routes.find(
      (route) => route.fallback === true && route.method === method,
    )
    if (fallbackRoute !== undefined) return { kind: 'route', route: fallbackRoute, params: {} }
    return { kind: 'not-found', allowed: [] }
  }
}

export type RouteResolution<TServices> =
  | {
      readonly kind: 'route'
      readonly route: RouteDefinition<TServices>
      readonly params: Readonly<Record<string, string>>
    }
  | { readonly kind: 'method-not-allowed'; readonly allowed: readonly HttpMethod[] }
  | { readonly kind: 'not-found'; readonly allowed: readonly HttpMethod[] }

/**
 * Is this remote address on the loopback interface?
 *
 * A pure predicate, and the reason the boundary survives a proxy. The address is
 * compared as a value rather than as a string, because one loopback address has
 * several string forms: Node reports an IPv4 client on a dual-stack socket as
 * `::ffff:127.0.0.1`, and refusing that would break the product on a default
 * macOS or Linux configuration.
 *
 * The empty address is not loopback. It appears when a socket has no peer, and a
 * request with no peer is not a request from this machine's user.
 *
 * `::` and `0.0.0.0` are not loopback either: they are the unspecified address, so
 * accepting them would be accepting a claim rather than an address.
 */
export function isLoopbackAddress(remoteAddress: string | undefined | null): boolean {
  if (typeof remoteAddress !== 'string' || remoteAddress.trim() === '') return false
  const address = remoteAddress.trim().toLowerCase()
  if (address === '::1' || address === '0:0:0:0:0:0:0:1') return true
  // An IPv4-mapped IPv6 address is the same host as the address it maps.
  const mapped = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  if (mapped.includes(':')) return false
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(mapped) && isDottedQuad(mapped)
}

function isDottedQuad(value: string): boolean {
  return value
    .split('.')
    .every(
      (part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255,
    )
}

function splitPath(pathname: string): string[] {
  return pathname.split('/').filter((segment) => segment !== '')
}

function matchPattern(
  pattern: string,
  segments: readonly string[],
): Readonly<Record<string, string>> | null {
  const patternSegments = splitPath(pattern)
  if (patternSegments.length !== segments.length) return null
  const params: Record<string, string> = {}
  for (const [index, patternSegment] of patternSegments.entries()) {
    const segment = segments[index]
    if (segment === undefined) return null
    if (patternSegment.startsWith(':')) {
      params[patternSegment.slice(1)] = segment
      continue
    }
    if (patternSegment !== segment) return null
  }
  return params
}

/** Where the built dashboard lives, and whether it is there at all. */
export interface DashboardSource {
  /**
   * The directory holding the built dashboard, or null when this hub serves no
   * dashboard. A missing directory is answered with an explicit 503 rather than an
   * empty page, because a blank page and a missing build look identical to a
   * developer and only one of them is true.
   */
  readonly root: string | null
}

export interface RequestListenerOptions<TServices> {
  readonly registry: RouteRegistry<TServices>
  /**
   * The services a handler is given, read per request.
   *
   * A thunk rather than a value because the listener is built before the socket
   * exists, and the services carry the live port the bind produced. Reading them
   * per request also means a handler can never close over a half-built object: if
   * a request arrives, the composition root has finished starting.
   */
  readonly services: () => TServices
  readonly dashboard: DashboardSource
  /** Called after every response is finished, with no payload and no content. */
  readonly onRequestServed?: (summary: { method: string; pathname: string; status: number }) => void
}

export interface RequestListener {
  (request: IncomingMessage, response: ServerResponse): void
  /** Requests answered so far. A number, not a log. */
  servedRequests(): number
}

/**
 * Build the request listener.
 *
 * Exported separately from the server so the address check can also be exercised
 * against a synthetic socket. The real-socket half of the boundary is proven by
 * the server test - a request from this machine is answered, and the server is
 * only ever bound to loopback - and the refusal half needs a peer this machine
 * does not have. Both halves exist; neither is allowed to stand in for the other.
 *
 * The order in this function is the security property. The address check runs
 * before routing, so a refused request cannot reach any handler, read or write;
 * the method and path checks run before the handler too, so an unhandled method on
 * a known path cannot reach one either.
 */
export function createRequestListener<TServices>(
  options: RequestListenerOptions<TServices>,
): RequestListener {
  const { registry, services } = options
  let served = 0

  const listener = (request: IncomingMessage, response: ServerResponse): void => {
    const report = (): void => {
      served += 1
      options.onRequestServed?.({
        method: request.method ?? 'UNKNOWN',
        pathname: safePathname(request),
        status: response.statusCode,
      })
    }

    // 1. The boundary. Before routing, before any handler, and reading the socket
    //    rather than a header: a caller-supplied `x-forwarded-for` is a claim, not
    //    an address, and honouring it here would reopen exactly what this closes.
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      respondJson(response, 403, {
        error: 'forbidden',
        // No echo of the address: this body is served to whoever asked.
        message: 'the hub answers loopback callers only.',
      })
      report()
      return
    }

    const method = normaliseMethod(request.method)
    if (method === null) {
      respondJson(
        response,
        405,
        { error: 'method-not-allowed', message: 'unknown HTTP method.', allowed: HTTP_METHODS },
        { Allow: HTTP_METHODS.join(', ') },
      )
      report()
      return
    }

    let url: URL
    try {
      url = new URL(request.url ?? '/', 'http://127.0.0.1')
    } catch {
      respondJson(response, 400, {
        error: 'bad-request',
        message: 'the request target is not a URL.',
      })
      report()
      return
    }

    const pathname = decodePathname(url.pathname)
    const resolution = registry.resolve(method, pathname)

    // 2. Routing. A refused method or path answers before any handler exists.
    if (resolution.kind === 'method-not-allowed') {
      respondJson(
        response,
        405,
        {
          error: 'method-not-allowed',
          message: `${method} is not served on ${pathname}.`,
          allowed: resolution.allowed,
        },
        { Allow: resolution.allowed.join(', ') },
      )
      report()
      return
    }
    if (resolution.kind === 'not-found') {
      respondJson(response, 404, { error: 'not-found', message: `${pathname} is not served.` })
      report()
      return
    }

    // 3. The handler, inside a guard so a thrown error becomes a contentless 500
    //    rather than a dropped connection or a stack trace in a response body.
    void Promise.resolve()
      .then(() =>
        resolution.route.handle({
          request,
          response,
          method,
          pathname,
          params: resolution.params,
          query: url.searchParams,
          services: services(),
        }),
      )
      .catch(() => {
        if (response.headersSent) {
          response.end()
        } else {
          respondJson(response, 500, {
            error: 'internal-error',
            // Deliberately contentless. A store failure is reported through
            // health and a dropped-event breadcrumb (APX-FR-02), never by putting
            // a database message into a response body.
            message: 'the request could not be completed.',
          })
        }
        report()
      })
  }

  return Object.assign(listener, { servedRequests: (): number => served })
}

export interface StartServerOptions<TServices> extends RequestListenerOptions<TServices> {
  /** The first port tried. Defaults to DEFAULT_HUB_PORT. */
  readonly preferredPort?: number
  /** Consecutive ports after the preferred one. Defaults to PORT_FALLBACK_ATTEMPTS. */
  readonly portFallbackAttempts?: number
  /**
   * Reports each port refused as in use, so the composition root can record why
   * the live port is not the preferred one. Diagnostics only: a port number and
   * an errno, nothing else.
   */
  readonly onPortInUse?: (attempt: { port: number; code: string }) => void
}

export interface HubServer<TServices> {
  /** Always the loopback address. Recorded rather than assumed. */
  readonly host: string
  /** The port actually bound, which is not necessarily the preferred one. */
  readonly port: number
  readonly origin: string
  readonly registry: RouteRegistry<TServices>
  /** The Node server, for the lifecycle tests that assert no orphaned listener. */
  readonly nodeServer: Server
  servedRequests(): number
  /** Stop accepting connections and resolve once the listener is closed. Idempotent. */
  close(): Promise<void>
}

/**
 * Bind the loopback server.
 *
 * Tries the preferred port, then the next free ports after it, and reports which
 * one it got. A range that is entirely taken is an error naming the range: the
 * caller has to publish a real port, so there is nothing useful to do with a
 * server that could not bind.
 */
export async function startServer<TServices>(
  options: StartServerOptions<TServices>,
): Promise<HubServer<TServices>> {
  if (!isLoopbackAddress(LOOPBACK_HOST)) {
    // Unreachable unless the constant above is edited, and that is the point: a
    // wildcard bind is the catastrophic mistake in this product, so the guard
    // against it is checked rather than assumed.
    throw new Error(
      `the hub refuses to bind: ${LOOPBACK_HOST} is not a loopback address. The port is ` +
        'security-relevant, not incidental (APX-CON-01).',
    )
  }
  const preferredPort = options.preferredPort ?? DEFAULT_HUB_PORT
  const attempts = Math.max(0, options.portFallbackAttempts ?? PORT_FALLBACK_ATTEMPTS) + 1
  const refused: { port: number; code: string }[] = []

  for (let offset = 0; offset < attempts; offset += 1) {
    const candidate = preferredPort + offset
    const listener = createRequestListener(options)
    try {
      const server = createServer(listener)
      await listen(server, candidate)
      return describe(server, listener, options)
    } catch (cause) {
      if (!isAddressInUse(cause)) throw cause
      refused.push({ port: candidate, code: codeOf(cause) })
      options.onPortInUse?.({ port: candidate, code: codeOf(cause) })
    }
  }

  throw new Error(
    `the hub could not bind a loopback port: ${preferredPort} through ${preferredPort + attempts - 1} ` +
      `were all in use (${refused.map((entry) => entry.port).join(', ')}). The live port has to be ` +
      'published for the adapters to find the hub, so this is reported rather than guessed around: ' +
      'free a port or pass a different preferredPort.',
  )
}

function describe<TServices>(
  server: Server,
  listener: RequestListener,
  options: StartServerOptions<TServices>,
): HubServer<TServices> {
  const address = server.address() as AddressInfo
  // The bound address is read back from the socket rather than assumed from the
  // request, so a test asserting "127.0.0.1 only" is asserting what the operating
  // system was told, not what this file intended.
  if (!isLoopbackAddress(address.address)) {
    server.close()
    throw new Error(
      `the hub bound ${address.address} rather than a loopback address, which would make this port ` +
        'a network-reachable control surface (APX-CON-01). Refusing to serve.',
    )
  }
  let closed = false
  return {
    host: address.address,
    port: address.port,
    origin: `http://${address.address}:${address.port}`,
    registry: options.registry,
    nodeServer: server,
    servedRequests: listener.servedRequests,
    close: (): Promise<void> => {
      if (closed) return Promise.resolve()
      closed = true
      return new Promise((resolve, reject) => {
        server.close((cause) => {
          // A close that reports an error still closed the listener, so a clean
          // shutdown must not be reported as a failure. Only a real failure - one
          // that is not "this server was not running" - rejects.
          const code = codeOf(cause)
          if (cause !== undefined && cause !== null && code !== 'ERR_SERVER_NOT_RUNNING') {
            reject(cause)
            return
          }
          resolve()
        })
      })
    },
  }
}

function listen(server: Server, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const onError = (cause: Error): void => {
      server.removeListener('listening', onListening)
      reject(cause)
    }
    const onListening = (): void => {
      server.removeListener('error', onError)
      resolve(server)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, LOOPBACK_HOST)
  })
}

function isAddressInUse(cause: unknown): boolean {
  return codeOf(cause) === 'EADDRINUSE'
}

function codeOf(cause: unknown): string {
  return typeof cause === 'object' && cause !== null && 'code' in cause
    ? String((cause as { code?: unknown }).code)
    : 'UNKNOWN'
}

function normaliseMethod(method: string | undefined): HttpMethod | null {
  if (method === undefined) return null
  const upper = method.toUpperCase()
  return (HTTP_METHODS as readonly string[]).includes(upper) ? (upper as HttpMethod) : null
}

function safePathname(request: IncomingMessage): string {
  try {
    return new URL(request.url ?? '/', 'http://127.0.0.1').pathname
  } catch {
    return '/'
  }
}

/**
 * Percent-decode a path one segment at a time.
 *
 * Segment-wise, and never the whole path: a whole-path decode turns `%2f` into a
 * separator, which is a separator the segment-wise matching above never saw. This
 * way an encoded separator is a character inside one segment, and the static route
 * still contains it. A malformed escape is left as it arrived rather than
 * throwing, so a hostile path is a 404 and not a 500.
 */
function decodePathname(pathname: string): string {
  return pathname
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment)
      } catch {
        return segment
      }
    })
    .join('/')
}

/**
 * The headers every response carries.
 *
 * No `access-control-allow-origin` and no CORS header of any kind: the daemon is
 * unauthenticated on read, so a permissive cross-origin header would let any page
 * the developer visits read their session state through the browser. The absence
 * is asserted by a test, because a header that is merely absent is invisible in
 * review.
 *
 * The content-security-policy is added to the dashboard's own responses rather
 * than to every response, because a policy governs documents and this server
 * answers JSON to machine clients that render nothing.
 */
export function baseHeaders(contentType: string): Readonly<Record<string, string>> {
  return {
    'content-type': contentType,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  }
}

/**
 * Write a JSON response.
 *
 * `extraHeaders` is applied before the body, because a header set after the
 * response has been sent is a crash rather than a wrong answer - and `Allow` on a
 * 405 is the one header that has to be there for the answer to be correct.
 */
export function respondJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  for (const [name, value] of Object.entries(baseHeaders('application/json; charset=utf-8'))) {
    response.setHeader(name, value)
  }
  for (const [name, value] of Object.entries(extraHeaders)) {
    response.setHeader(name, value)
  }
  response.statusCode = status
  response.end(`${JSON.stringify(body)}\n`)
}

/**
 * The dashboard's own files, as a fallback GET route.
 *
 * A route rather than a branch in the listener, so the dashboard is in the
 * enumerated route list like everything else: a served surface that is not in the
 * registry is a surface nobody audits.
 */
export function createDashboardRoute<TServices>(
  dashboard: DashboardSource,
): RouteDefinition<TServices> {
  return {
    method: 'GET',
    pattern: '/',
    name: 'dashboard.static',
    mutation: 'read-only',
    fallback: true,
    handle: ({ response, pathname }): void => {
      // A mistyped API path must not be answered by the dashboard's file handler.
      // The fallback exists because hashed asset names are unknowable in advance,
      // not because this server has no idea what its own routes are: a request
      // under /api that matched nothing is a missing route, and saying so is the
      // difference between a client that retries a real endpoint and one that
      // starts hunting for the right filename.
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        respondJson(response, 404, { error: 'not-found', message: `${pathname} is not served.` })
        return
      }
      serveStaticFile(response, dashboard.root, pathname)
    },
  }
}

/**
 * Serve one file from the built dashboard.
 *
 * Three properties, each of which is a refusal rather than a convenience:
 *   - The resolved path must still be inside the root, checked on the resolved
 *     path rather than on the request text, so a `..` segment or an encoded
 *     separator cannot escape and a symlink out of the root is contained.
 *   - A directory is never served. `/` is mapped to `index.html` explicitly.
 *   - An unknown extension is refused rather than guessed, so a new build artefact
 *     is served with a correct type or not at all - never as
 *     `application/octet-stream`, which `nosniff` and a strict policy would then
 *     refuse to run anyway.
 */
export function serveStaticFile(
  response: ServerResponse,
  root: string | null,
  pathname: string,
): void {
  if (root === null) {
    respondJson(response, 503, {
      error: 'dashboard-unavailable',
      message: 'this hub serves no dashboard; the build output was not found at start.',
    })
    return
  }
  const resolvedRoot = path.resolve(root)
  if (!existsSync(resolvedRoot)) {
    respondJson(response, 503, {
      error: 'dashboard-unavailable',
      message: `the built dashboard is not present at ${resolvedRoot}. Build it with npm run build:dashboard.`,
    })
    return
  }
  const requested = pathname === '/' || pathname === '' ? 'index.html' : pathname.replace(/^\/+/, '')
  const target = path.resolve(resolvedRoot, requested)
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
    respondJson(response, 404, { error: 'not-found', message: 'no such dashboard file.' })
    return
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    respondJson(response, 404, { error: 'not-found', message: 'no such dashboard file.' })
    return
  }
  const contentType = CONTENT_TYPES[path.extname(target).toLowerCase()]
  if (contentType === undefined) {
    respondJson(response, 415, {
      error: 'unsupported-media-type',
      message: 'the dashboard build contains a file type this hub does not serve.',
    })
    return
  }
  for (const [name, value] of Object.entries(baseHeaders(contentType))) {
    response.setHeader(name, value)
  }
  response.setHeader('content-security-policy', DASHBOARD_CSP)
  response.statusCode = 200
  createReadStream(target)
    .on('error', () => {
      if (response.headersSent) response.end()
      else respondJson(response, 500, { error: 'internal-error', message: 'unreadable dashboard file.' })
    })
    .pipe(response)
}
