import type { CloveRequest } from "./http/request.js"
import type { CloveResponse } from "./http/response.js"

/**
 * The dependency injection context.
 *
 * This interface is intentionally empty in the framework itself. User projects
 * get it augmented by the generated `.clove/types.d.ts`, which declares one
 * property per file in `services/` and `di/`.
 */
export interface Ctx {
  /** Built-in route-cache invalidation facade. */
  readonly cache: CacheController
}

/**
 * `ctx` as seen at runtime: the augmented interface plus arbitrary keys. The
 * index signature is `any` so reading a resolved dependency off `ctx` needs no
 * cast; the generated `.clove/types.d.ts` gives known keys their real types.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RuntimeCtx = Ctx & Record<string, any>

export type Lifetime = "singleton" | "session" | "request"

export const KIND = Symbol.for("clovejs.kind")

export type DefinitionKind =
  | "route"
  | "middleware"
  | "service"
  | "di"
  | "ws"
  | "views"
  | "mcpTool"
  | "mcpResource"
  | "mcpPrompt"
  | "mcpAuth"

export interface Definition<K extends DefinitionKind> {
  readonly [KIND]: K
}

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS"

/** Hook registrar handed to service / di / ws factories. */
export interface LifecycleHooks {
  onDestroy(fn: () => void | Promise<void>): void
}

export type RouteHandlerFn = (
  req: CloveRequest,
  res: CloveResponse,
  ctx: RuntimeCtx,
) => unknown | Promise<unknown>

/** A cache duration in milliseconds or as a compact human-readable value. */
export type CacheDuration =
  | number
  | `${number}ms`
  | `${number}s`
  | `${number}m`
  | `${number}h`
  | `${number}d`

/** Values available when computing a route's cache identity and tags. */
export interface CacheContext {
  req: CloveRequest
  res: CloveResponse
  ctx: RuntimeCtx
  route: Route
}

/** Browser and shared-proxy caching applied to the finalized response. */
export interface ClientCachePolicy {
  maxAge?: CacheDuration
  sharedMaxAge?: CacheDuration
  staleWhileRevalidate?: CacheDuration
  /** Defaults to true unless `sharedMaxAge` is configured. */
  private?: boolean
  immutable?: boolean
}

/**
 * Caches the terminal handler outcome while still running the complete
 * middleware interceptor chain on every request.
 */
export interface CachePolicy {
  /** How long the handler outcome remains fresh. */
  ttl: CacheDuration
  /**
   * Public entries intentionally ignore caller identity. Private is the safe
   * default and requires a custom key when credentials are present.
   */
  scope?: "public" | "private"
  /**
   * How long an expired entry may serve followers while one request refreshes
   * it. The first request after expiry refreshes synchronously.
   */
  staleWhileRevalidate?: CacheDuration
  /** Request headers included in the cache key and emitted through `Vary`. */
  vary?: readonly string[]
  /** Adds an application-specific identity component to the default key. */
  key?: (args: CacheContext) => string | Promise<string>
  /** Tags used for bulk invalidation. */
  tags?:
    | readonly string[]
    | ((args: CacheContext & { result: unknown }) =>
        readonly string[] | Promise<readonly string[]>)
  /**
   * Browser/CDN policy. Omit for `private, no-cache`; pass false for
   * `no-store`.
   */
  client?: false | ClientCachePolicy
}

/** Values available after a mutation handler and all interceptors complete. */
export interface CacheInvalidationContext extends CacheContext {
  result: unknown
}

export type CacheInvalidation =
  | readonly string[]
  | ((args: CacheInvalidationContext) =>
      readonly string[] | Promise<readonly string[]>)

/** Imperative cache operations exposed as `ctx.cache`. */
export interface CacheController {
  invalidate(tags: readonly string[]): Promise<void>
}

export interface RouteMeta {
  /** Set `false` to disable the built-in JSON middleware for this route. */
  json?: boolean
  [key: string]: unknown
}

export const META = Symbol.for("clovejs.meta")
export const CACHE = Symbol.for("clovejs.cache")
export const INVALIDATES = Symbol.for("clovejs.invalidates")

export interface RouteDefinition extends Definition<"route"> {
  method: HttpMethod | "ALL"
  handler: RouteHandlerFn
  /** Collected metadata. Read by the scanner, written by `.meta()`. */
  [META]: RouteMeta
  [CACHE]?: CachePolicy
  [INVALIDATES]?: CacheInvalidation
  /** Attach route metadata. Chainable; merges with any previous call. */
  meta(meta: RouteMeta): RouteDefinition
  /** Cache this route's terminal handler outcome. */
  cache(policy: CachePolicy): RouteDefinition
  /** Invalidate cache tags after this handler completes successfully. */
  invalidates(tags: CacheInvalidation): RouteDefinition
}

/** A route as registered in the router, with its resolved path and origin. */
export interface Route {
  method: HttpMethod | "ALL"
  path: string
  handler: RouteHandlerFn
  meta: Readonly<RouteMeta>
  cache?: Readonly<CachePolicy>
  invalidates?: CacheInvalidation
  /** Absolute path of the file this route came from. Used in error messages. */
  file: string
}

export interface MiddlewareArgs {
  route: Route
  handler: { execute(): Promise<unknown> }
  req: CloveRequest
  res: CloveResponse
  ctx: RuntimeCtx
}

export type MiddlewareFn = (args: MiddlewareArgs) => unknown | Promise<unknown>

export interface MiddlewareDefinition extends Definition<"middleware"> {
  fn: MiddlewareFn
}

/**
 * A service factory.
 *
 * `M` is the resolved service value (the object of methods), not the raw return
 * of the factory. Weaving `ThisType<M>` *inside* the `Promise` is what keeps
 * `this` typed as `M` in an `async` factory: without it, the object literal sits
 * at the async return position, where its contextual type widens to
 * `M | PromiseLike<M>` and calling a sibling method (`this.sign(user)`) stops
 * type-checking. Applying `ThisType<M>` to the awaited type — rather than to the
 * outer union — makes `this` resolve to `M` for both sync and async factories.
 */
// The generic defaults below are `any` on purpose: the concrete type is inferred
// from each `service()`/`di()` call, and the default only applies to bare, un-
// parameterised references, where `any` keeps `this`/value access unconstrained.
/* eslint-disable @typescript-eslint/no-explicit-any */
export type ServiceFactory<M = any> = (
  ctx: RuntimeCtx,
  hooks: LifecycleHooks,
) => (M & ThisType<M>) | Promise<M & ThisType<M>>

export interface ServiceDefinition<M = any> extends Definition<"service"> {
  factory: ServiceFactory<M>
}

export type ValueFactory<T = any> = (ctx: RuntimeCtx, hooks: LifecycleHooks) => T

export interface DiSpec<T = any> {
  lifetime: Lifetime
  value: T | ValueFactory<T>
}

export interface DiDefinition<T = any> extends Definition<"di"> {
  lifetime: Lifetime
  value: T | ValueFactory<T>
  /** True when `value` was supplied as a factory function. */
  isFactory: boolean
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface WsArgs {
  onMessage(fn: (msg: string | Buffer) => void | Promise<void>): void
  onClose(fn: () => void | Promise<void>): void
  onDestroy(fn: () => void | Promise<void>): void
  send(data: string | Buffer | object): void
  close(code?: number, reason?: string): void
  ctx: RuntimeCtx
  req: CloveRequest
  params: Record<string, string>
}

export type WsHandlerFn = (args: WsArgs) => void | Promise<void>

export interface WsDefinition extends Definition<"ws"> {
  handler: WsHandlerFn
}

/**
 * A template engine adapter. Clove ships no engine of its own — a project
 * registers one from `views.ts` at the source root, wrapping whatever library
 * it likes (Eta, EJS, Handlebars, a bare `String.raw`, …).
 *
 * `render` is the single seam: it receives the template name a handler passed
 * to {@link ViewResult}, the data, and `ctx` (so the adapter can fold in
 * request-scoped globals such as the current user or a CSRF token). It owns
 * template resolution and caching; returning a string or a `Buffer`, sync or
 * async, are all accepted.
 */
export interface ViewEngine {
  /**
   * Default `Content-Type` for rendered output, as a
   * {@link CloveResponse.type} shorthand (`"html"`) or a full MIME type. Used
   * only when the handler did not set a type itself. Defaults to `"html"`.
   */
  contentType?: string
  render(
    template: string,
    data: unknown,
    ctx: RuntimeCtx,
  ): string | Buffer | Promise<string | Buffer>
}

export interface ViewsDefinition extends Definition<"views"> {
  engine: ViewEngine
}

export const VIEW = Symbol.for("clovejs.view")

/**
 * What a handler returns to have a template rendered. Produced by `view()`,
 * recognised by the pipeline before JSON handling, and rendered through the
 * registered {@link ViewEngine}. A plain, inspectable value, so a handler that
 * returns it stays unit-testable without touching `res`.
 */
export interface ViewResult {
  readonly [VIEW]: true
  template: string
  data: unknown
}

export function isViewResult(value: unknown): value is ViewResult {
  return (
    typeof value === "object" &&
    value !== null &&
    VIEW in (value as Record<PropertyKey, unknown>)
  )
}

/** One Server-Sent Event, as passed to {@link SseArgs.emit}. */
export interface SseEvent {
  /** The `event:` field. Defaults to `"message"` on the client when omitted. */
  event?: string
  /** The payload. Objects are JSON-serialized; strings are sent verbatim. */
  data: string | object
  /** The `id:` field, echoed back as `Last-Event-ID` when the client reconnects. */
  id?: string
  /** The `retry:` reconnect hint, in milliseconds, for this event. */
  retry?: number
}

/**
 * The arguments handed to an `sse()` handler. A push-oriented view of the
 * response: send events, react to disconnect, and read the reconnect cursor —
 * without touching the raw stream.
 */
export interface SseArgs {
  /** Sends a `message` event. Objects are JSON-serialized; strings sent as-is. */
  send(data: string | object): void
  /** Sends a named/typed event with optional `id` and per-event `retry`. */
  emit(event: SseEvent): void
  /** Writes an SSE comment line (`: text`). Useful as an explicit keep-alive. */
  comment(text: string): void
  /**
   * The `Last-Event-ID` the client sent when reconnecting, or `undefined` on a
   * fresh connection. Pair it with `emit({ id })` to resume without gaps.
   */
  lastEventId: string | undefined
  /** Registers a callback for when the connection ends, from either side. */
  onClose(fn: () => void | Promise<void>): void
  /** Registers a teardown callback, run after {@link onClose} at final cleanup. */
  onDestroy(fn: () => void | Promise<void>): void
  /** Ends the stream from the server side. */
  close(): void
  /** True while the connection is writable; false once it has ended. */
  readonly open: boolean
  ctx: RuntimeCtx
  req: CloveRequest
  params: Record<string, string>
}

export type SseHandlerFn = (args: SseArgs) => void | Promise<void>

/** Options for the `sse()` route builder. */
export interface SseOptions {
  /**
   * Interval in milliseconds at which the runtime writes a comment line to keep
   * the connection alive through idle-timeout proxies. Omit to disable.
   */
  heartbeat?: number
  /**
   * Initial `retry:` reconnect hint, in milliseconds, sent once when the stream
   * opens. Individual events can override it via {@link SseEvent.retry}.
   */
  retry?: number
}

/**
 * The definition `sse()` returns: a GET route carrying a chainable `options()`
 * for its {@link SseOptions}, mirroring how `.meta()` reads on a plain route.
 */
export interface SseRouteDefinition extends RouteDefinition {
  /** Sets stream options (heartbeat, retry). Chainable; merges with prior calls. */
  options(options: SseOptions): SseRouteDefinition
}

export type AnyDefinition =
  | RouteDefinition
  | MiddlewareDefinition
  | ServiceDefinition
  | DiDefinition
  | WsDefinition
  | ViewsDefinition
  // MCP definitions are structurally identified the same way, but their shapes
  // live in `src/mcp/` so the core never has to import the MCP SDK.
  | Definition<"mcpTool">
  | Definition<"mcpResource">
  | Definition<"mcpPrompt">
  | Definition<"mcpAuth">

export function isDefinition(value: unknown): value is AnyDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    KIND in (value as Record<PropertyKey, unknown>)
  )
}

export function definitionKind(value: unknown): DefinitionKind | null {
  return isDefinition(value) ? value[KIND] : null
}
