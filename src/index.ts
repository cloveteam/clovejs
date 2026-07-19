export {
  all,
  del,
  di,
  get,
  head,
  middleware,
  options,
  patch,
  post,
  put,
  service,
  ws,
} from "./definitions.js"

export { error, HttpError, isHttpError, CloveBootError } from "./errors.js"

export { bootstrap, engine } from "./bootstrap.js"
export type { BootstrapOptions, Clove, CloveEngine } from "./bootstrap.js"

export { createApp, CloveApp } from "./app.js"
export type { AppOptions } from "./app.js"

export { CloveRequest } from "./http/request.js"
export { CloveResponse } from "./http/response.js"
export type { CookieOptions } from "./http/cookies.js"

export { MemorySessionStore } from "./session/store.js"
export type { SessionStore } from "./session/store.js"

export { createLogger } from "./container/logger.js"
export type { Logger, LogLevel } from "./container/logger.js"

export type {
  Ctx,
  DiSpec,
  HttpMethod,
  Lifetime,
  LifecycleHooks,
  MiddlewareArgs,
  MiddlewareFn,
  Route,
  RouteHandlerFn,
  RouteMeta,
  RuntimeCtx,
  ServiceFactory,
  ValueFactory,
  WsArgs,
  WsHandlerFn,
} from "./types.js"

export type {
  DiDefinition,
  MiddlewareDefinition,
  RouteDefinition,
  ServiceDefinition,
  WsDefinition,
} from "./types.js"

/**
 * Extracts the value a `service(...)` definition resolves to. Used by the
 * generated `.clove/types.d.ts`.
 */
export type CloveService<T> =
  T extends import("./types.js").ServiceDefinition<infer R> ? Awaited<R> : never

/**
 * Extracts the value a `di(...)` definition resolves to. Used by the generated
 * `.clove/types.d.ts`.
 */
export type CloveDi<T> =
  T extends import("./types.js").DiDefinition<infer R>
    ? R extends (...args: any[]) => infer F
      ? Awaited<F>
      : R
    : never
