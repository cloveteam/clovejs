import { serveSse } from "./http/sse.js"
import {
  KIND,
  META,
  type DiDefinition,
  type DiSpec,
  type HttpMethod,
  type MiddlewareDefinition,
  type MiddlewareFn,
  type RouteDefinition,
  type RouteHandlerFn,
  type RouteMeta,
  type ServiceDefinition,
  type ServiceFactory,
  type SseHandlerFn,
  type SseOptions,
  type SseRouteDefinition,
  type WsDefinition,
  type WsHandlerFn,
} from "./types.js"

function route(method: HttpMethod | "ALL", handler: RouteHandlerFn): RouteDefinition {
  const def: RouteDefinition = {
    [KIND]: "route",
    [META]: {},
    method,
    handler,
    meta(meta: RouteMeta) {
      Object.assign(def[META], meta)
      return def
    },
  }
  return def
}

export const get = (handler: RouteHandlerFn) => route("GET", handler)
export const post = (handler: RouteHandlerFn) => route("POST", handler)
export const put = (handler: RouteHandlerFn) => route("PUT", handler)
export const patch = (handler: RouteHandlerFn) => route("PATCH", handler)
export const del = (handler: RouteHandlerFn) => route("DELETE", handler)
export const head = (handler: RouteHandlerFn) => route("HEAD", handler)
export const options = (handler: RouteHandlerFn) => route("OPTIONS", handler)
/** Matches every HTTP method at this path. */
export const all = (handler: RouteHandlerFn) => route("ALL", handler)

export function middleware(fn: MiddlewareFn): MiddlewareDefinition {
  return { [KIND]: "middleware", fn }
}

export function service<M>(factory: ServiceFactory<M>): ServiceDefinition<M> {
  return { [KIND]: "service", factory }
}

export function di<T>(spec: DiSpec<T>): DiDefinition<T> {
  return {
    [KIND]: "di",
    lifetime: spec.lifetime,
    value: spec.value,
    isFactory: typeof spec.value === "function",
  }
}

export function ws(handler: WsHandlerFn): WsDefinition {
  return { [KIND]: "ws", handler }
}

/**
 * Declares a Server-Sent Events endpoint. Lives in `api/` like any GET route —
 * it flows through the HTTP middleware chain and supports path params — but the
 * handler receives a push-oriented {@link SseArgs} instead of `(req, res)`, and
 * the connection stays open until the client disconnects or `close()` is called.
 *
 * Stream options are set with a chainable `.options()`, the way routes carry
 * `.meta()`: `sse(handler).options({ heartbeat: 15_000 })`.
 */
export function sse(handler: SseHandlerFn): SseRouteDefinition {
  // Read by `serveSse` per connection, so `.options()` can populate it any time
  // before the first request — exactly like `.meta()` mutating `def[META]`.
  const opts: SseOptions = {}
  const def = route("GET", serveSse(handler, opts)) as SseRouteDefinition
  // The stream owns the response; the JSON middleware must not try to write one.
  def[META].json = false
  def.options = (options: SseOptions) => {
    Object.assign(opts, options)
    return def
  }
  return def
}
