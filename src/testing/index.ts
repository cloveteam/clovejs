import { createApp, CloveApp, type AppOptions } from "../app.js"
import { Container } from "../container/container.js"
import { createLogger } from "../container/logger.js"
import { Registry } from "../container/registry.js"
import { isHttpError } from "../errors.js"
import { CloveRequest } from "../http/request.js"
import { CloveResponse } from "../http/response.js"
import type { McpInvokeOptions, McpResourceResult } from "../mcp/runtime.js"
import { applyJsonResult, jsonEnabled } from "../pipeline/json.js"
import {
  META,
  definitionKind,
  type Ctx,
  type MiddlewareArgs,
  type MiddlewareDefinition,
  type Route,
  type RouteDefinition,
  type RuntimeCtx,
  type ValueFactory,
} from "../types.js"
import { MockRequest, MockResponse, readResponse, type TestResponse } from "./http.js"
import { makeSseStream, type TestSseStream } from "./sse.js"
import { connectSocket, type TestSocket } from "./ws.js"

export type { TestResponse } from "./http.js"
export type { SseMessage, TestSseStream } from "./sse.js"
export type { TestSocket } from "./ws.js"
export type { McpInvokeOptions, McpResourceResult } from "../mcp/runtime.js"

/**
 * A fake for one dependency: a value or a factory with the `service`/`di`
 * contract. Typed as `Partial<T>` because a test override is a full replacement
 * that need only provide what the code under test actually touches — a stub
 * with two of a service's ten methods is the common, intended case.
 */
type Override<T> = Partial<T> | ValueFactory<Partial<T>>

/**
 * Dependency overrides, keyed by their `ctx` name and checked against the
 * generated context — so a renamed service breaks the test at compile time.
 * Unknown keys are allowed, for seeding what a middleware would set.
 */
export type TestOverrides = { [K in keyof Ctx]?: Override<Ctx[K]> } & Record<string, unknown>

export interface TestAppOptions extends Omit<AppOptions, "overrides"> {
  overrides?: TestOverrides
}

export interface TestRequestInit {
  method?: string
  headers?: Record<string, string>
  /** A string/Buffer is sent as-is; anything else is JSON-encoded. */
  body?: unknown
}

/** A cookie jar carried across requests on one {@link TestApp}. */
export interface CookieJar {
  set(name: string, value: string): void
  get(name: string): string | undefined
  clear(): void
  all(): Record<string, string>
}

/** The MCP surface, dispatched without a JSON-RPC transport. */
export interface TestMcp {
  callTool(name: string, input?: unknown, opts?: McpInvokeOptions): Promise<unknown>
  readResource(uri: string, opts?: McpInvokeOptions): Promise<McpResourceResult>
  getPrompt(name: string, input?: unknown, opts?: McpInvokeOptions): Promise<unknown>
}

/**
 * A booted application wired for in-memory testing: HTTP verbs that dispatch
 * through the real request path with no socket, a cookie jar, and the MCP and
 * WebSocket surfaces.
 */
export interface TestApp {
  /** The underlying booted app, for anything the harness does not wrap. */
  readonly app: CloveApp
  request(path: string, init?: TestRequestInit): Promise<TestResponse>
  get(path: string, init?: TestRequestInit): Promise<TestResponse>
  post(path: string, body?: unknown, init?: TestRequestInit): Promise<TestResponse>
  put(path: string, body?: unknown, init?: TestRequestInit): Promise<TestResponse>
  patch(path: string, body?: unknown, init?: TestRequestInit): Promise<TestResponse>
  del(path: string, init?: TestRequestInit): Promise<TestResponse>
  head(path: string, init?: TestRequestInit): Promise<TestResponse>
  options(path: string, init?: TestRequestInit): Promise<TestResponse>
  /** Opens a Server-Sent Events stream against an `sse()` route. */
  sse(path: string, init?: TestRequestInit): TestSseStream
  readonly cookies: CookieJar
  readonly mcp: TestMcp
  readonly ws: { connect(path: string): TestSocket }
  /** Clears the cookie jar without rebooting the app. */
  reset(): void
  /** Runs the real shutdown path: MCP, sockets, sessions, then singletons. */
  close(): Promise<void>
}

/**
 * Boots the project in-memory and returns a harness over it.
 *
 * Requests go through the real router, middleware chain, DI containers and JSON
 * rules — no server, no port. Pair `close()` with the runner's teardown so each
 * test gets a clean singleton scope.
 */
export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const app = await createApp({
    logLevel: "silent",
    sessionSecret: "test-secret",
    ...(options as AppOptions),
  })
  return new TestAppHarness(app)
}

class TestAppHarness implements TestApp {
  readonly app: CloveApp
  readonly #jar = new Map<string, string>()

  constructor(app: CloveApp) {
    this.app = app
  }

  async request(path: string, init: TestRequestInit = {}): Promise<TestResponse> {
    const method = (init.method ?? "GET").toUpperCase()
    const headers = lowerHeaders(init.headers)

    if (this.#jar.size > 0 && !headers.cookie) {
      headers.cookie = [...this.#jar].map(([k, v]) => `${k}=${v}`).join("; ")
    }

    let body: Buffer | undefined
    if (init.body !== undefined && init.body !== null) {
      const isRaw = typeof init.body === "string" || Buffer.isBuffer(init.body)
      body = Buffer.isBuffer(init.body)
        ? init.body
        : Buffer.from(isRaw ? String(init.body) : JSON.stringify(init.body))
      if (!isRaw && !headers["content-type"]) headers["content-type"] = "application/json"
    }

    const req = new MockRequest({ method, url: path, headers, body })
    const res = new MockResponse()
    // Going through `listener` (not `handle`) exercises the real 404/405
    // fallback for unmatched paths, exactly as production does.
    this.app.listener(req as never, res as never)
    await res.whenEnded

    const result = readResponse(res)
    for (const cookie of result.cookies) this.#absorbCookie(cookie)
    return result
  }

  get = (path: string, init?: TestRequestInit) => this.request(path, { ...init, method: "GET" })
  head = (path: string, init?: TestRequestInit) => this.request(path, { ...init, method: "HEAD" })
  options = (path: string, init?: TestRequestInit) =>
    this.request(path, { ...init, method: "OPTIONS" })
  del = (path: string, init?: TestRequestInit) => this.request(path, { ...init, method: "DELETE" })

  post = (path: string, body?: unknown, init?: TestRequestInit) =>
    this.request(path, { ...init, method: "POST", body })
  put = (path: string, body?: unknown, init?: TestRequestInit) =>
    this.request(path, { ...init, method: "PUT", body })
  patch = (path: string, body?: unknown, init?: TestRequestInit) =>
    this.request(path, { ...init, method: "PATCH", body })

  sse(path: string, init: TestRequestInit = {}): TestSseStream {
    const headers = lowerHeaders(init.headers)
    if (this.#jar.size > 0 && !headers.cookie) {
      headers.cookie = [...this.#jar].map(([k, v]) => `${k}=${v}`).join("; ")
    }
    if (!headers.accept) headers.accept = "text/event-stream"

    const req = new MockRequest({ method: "GET", url: path, headers })
    const { capture, stream } = makeSseStream()
    // Fire and forget: `handle` stays pending for the connection's lifetime, so
    // events surface through the stream rather than a resolved response.
    this.app.listener(req as never, capture as never)
    return stream
  }

  readonly cookies: CookieJar = {
    set: (name, value) => void this.#jar.set(name, value),
    get: (name) => this.#jar.get(name),
    clear: () => this.#jar.clear(),
    all: () => Object.fromEntries(this.#jar),
  }

  readonly mcp: TestMcp = {
    callTool: (name, input, opts) => this.app.mcp.callTool(name, input, opts),
    readResource: (uri, opts) => this.app.mcp.readResource(uri, opts),
    getPrompt: (name, input, opts) => this.app.mcp.getPrompt(name, input, opts),
  }

  readonly ws = {
    connect: (path: string): TestSocket =>
      connectSocket(path, (p, socket) => this.app.ws.openTestConnection(p, socket)),
  }

  reset(): void {
    this.#jar.clear()
  }

  close(): Promise<void> {
    return this.app.close()
  }

  #absorbCookie(cookie: string): void {
    const [pair] = cookie.split(";")
    if (!pair) return
    const eq = pair.indexOf("=")
    if (eq > 0) this.#jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
  }
}

// --- Unit-level helpers ----------------------------------------------------

export interface RunHandlerOptions {
  params?: Record<string, string>
  query?: Record<string, string>
  body?: unknown
  headers?: Record<string, string>
  /** Overrides the method the definition declares (needed only for `all()`). */
  method?: string
  /** The context handed to the handler. Defaults to an empty {@link createMockCtx}. */
  ctx?: RuntimeCtx
}

/**
 * Runs one route handler in isolation and applies the JSON rules, so the result
 * is a real response — 204 on `undefined`, 404 on `null` from a GET, and so on.
 * A thrown `error(status, ...)` is rendered into that status; anything else
 * propagates for the test to catch.
 */
export async function runHandler(
  def: RouteDefinition,
  opts: RunHandlerOptions = {},
): Promise<TestResponse> {
  assertKind(def, "route")
  const method = (opts.method ?? (def.method === "ALL" ? "GET" : def.method)).toUpperCase()

  const req = new CloveRequest(
    new MockRequest({ method, url: buildUrl("/", opts.query), headers: lowerHeaders(opts.headers) }) as never,
  )
  req.params = opts.params ?? {}
  if (opts.body !== undefined) req.body = opts.body

  const mockRes = new MockResponse()
  const res = new CloveResponse(mockRes as never)
  const ctx = opts.ctx ?? createMockCtx()
  const route: Route = {
    method: def.method,
    path: "/",
    handler: def.handler,
    meta: Object.freeze({ ...def[META] }),
    file: "<test>",
  }

  try {
    const result = await def.handler(req, res, ctx)
    if (jsonEnabled(route, res)) {
      applyJsonResult(result, route, res, method)
    } else if (!res.sent) {
      if (result !== undefined && result !== null) res.send(result)
      else res.end()
    }
  } catch (err) {
    renderError(err, res)
  }

  if (!res.sent) res.end()
  await mockRes.whenEnded
  return readResponse(mockRes)
}

export interface RunMiddlewareOptions extends RunHandlerOptions {
  path?: string
  /** Fields to merge onto the `route` the middleware sees (e.g. `meta`). */
  route?: Partial<Route>
  /** Stands in for the next link in the chain. Defaults to a no-op. */
  execute?: () => unknown | Promise<unknown>
}

export interface RunMiddlewareResult {
  /** Whatever the middleware returned. */
  result: unknown
  /** The response, in case the middleware short-circuited and wrote one. */
  response: TestResponse
}

/** Runs one middleware with a stubbed `handler.execute`. */
export async function runMiddleware(
  def: MiddlewareDefinition,
  opts: RunMiddlewareOptions = {},
): Promise<RunMiddlewareResult> {
  assertKind(def, "middleware")
  const method = (opts.method ?? "GET").toUpperCase()
  const path = opts.path ?? "/"

  const req = new CloveRequest(
    new MockRequest({ method, url: buildUrl(path, opts.query), headers: lowerHeaders(opts.headers) }) as never,
  )
  req.params = opts.params ?? {}
  if (opts.body !== undefined) req.body = opts.body

  const mockRes = new MockResponse()
  const res = new CloveResponse(mockRes as never)
  const ctx = opts.ctx ?? createMockCtx()

  const route: Route = {
    method: "GET",
    path,
    handler: async () => undefined,
    meta: Object.freeze({}),
    file: "<test>",
    ...opts.route,
  }

  const args: MiddlewareArgs = {
    route,
    req,
    res,
    ctx,
    handler: { execute: async () => (opts.execute ? opts.execute() : undefined) },
  }

  let result: unknown
  try {
    result = await def.fn(args)
  } catch (err) {
    renderError(err, res)
  }

  if (!res.sent) res.end()
  await mockRes.whenEnded
  return { result, response: readResponse(mockRes) }
}

/**
 * Builds a `ctx`-shaped object backed by the real container proxy, so `get`,
 * `set` and `has` behave exactly as in the pipeline. Every override is a plain
 * value (a concrete stub); a `logger` is provided unless you override it.
 */
export function createMockCtx(overrides: Record<string, unknown> = {}): RuntimeCtx {
  const registry = new Registry()
  registry.override({
    key: "logger",
    kind: "builtin",
    lifetime: "singleton",
    file: "<mock>",
    isFactory: false,
    value: createLogger("silent"),
  })
  for (const [key, value] of Object.entries(overrides)) {
    registry.override({
      key,
      kind: "di",
      lifetime: "singleton",
      file: "<mock>",
      isFactory: false,
      value,
    })
  }
  return new Container(registry, "request").ctx
}

// --- internals -------------------------------------------------------------

function renderError(err: unknown, res: CloveResponse): void {
  if (!isHttpError(err)) throw err
  res.status(err.status)
  if (!res.contentType || res.contentType.includes("json")) res.json(err.body)
  else res.send(String(err.message))
}

function lowerHeaders(headers?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers ?? {})) out[key.toLowerCase()] = value
  return out
}

function buildUrl(path: string, query?: Record<string, string>): string {
  if (!query || Object.keys(query).length === 0) return path
  const search = new URLSearchParams(query).toString()
  return path.includes("?") ? `${path}&${search}` : `${path}?${search}`
}

function assertKind(def: unknown, expected: "route" | "middleware"): void {
  const kind = definitionKind(def)
  if (kind !== expected) {
    throw new TypeError(
      `Expected a ${expected} definition, received ${kind ?? "a plain value"}. ` +
        `Pass the default export of the file under test.`,
    )
  }
}
