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

/** `ctx` as seen at runtime: the augmented interface plus arbitrary keys. */
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
 * The return type is a bare `T` rather than `T | Promise<T>` on purpose: with a
 * union, `this` inside the returned object literal widens to include
 * `PromiseLike`, and calling a sibling method (`this.sign(user)`) stops
 * type-checking. Callers unwrap with `Awaited<T>` instead.
 */
export type ServiceFactory<T = any> = (
  ctx: RuntimeCtx,
  hooks: LifecycleHooks,
) => T

export interface ServiceDefinition<T = any> extends Definition<"service"> {
  factory: ServiceFactory<T>
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
