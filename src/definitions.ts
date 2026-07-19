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

export function service<T>(factory: ServiceFactory<T>): ServiceDefinition<T> {
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
