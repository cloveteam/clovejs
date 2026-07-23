import type { CloveRequest } from "./http/request.js"
import type { CloveResponse } from "./http/response.js"

/**
 * The dependency injection context.
 *
 * This interface is intentionally empty in the framework itself. User projects
 * get it augmented by the generated `.clove/types.d.ts`, which declares one
 * property per file in `services/` and `di/`.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Ctx {}

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

export interface RouteMeta {
  /** Set `false` to disable the built-in JSON middleware for this route. */
  json?: boolean
  [key: string]: unknown
}

export const META = Symbol.for("clovejs.meta")

export interface RouteDefinition extends Definition<"route"> {
  method: HttpMethod | "ALL"
  handler: RouteHandlerFn
  /** Collected metadata. Read by the scanner, written by `.meta()`. */
  [META]: RouteMeta
  /** Attach route metadata. Chainable; merges with any previous call. */
  meta(meta: RouteMeta): RouteDefinition
}

/** A route as registered in the router, with its resolved path and origin. */
export interface Route {
  method: HttpMethod | "ALL"
  path: string
  handler: RouteHandlerFn
  meta: Readonly<RouteMeta>
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
