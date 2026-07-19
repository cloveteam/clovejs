# Types

Every type below is exported from `clovejs`.

## `Ctx` and `RuntimeCtx`

```ts
interface Ctx {}
type RuntimeCtx = Ctx & Record<string, any>
```

`Ctx` is intentionally empty in the framework. Your project gets it augmented
by the generated `.clove/types.d.ts`, which declares one property per file in
`services/` and `di/` — see [Typed context](/guide/typed-context).

`RuntimeCtx` is what handlers actually receive: the augmented interface plus
arbitrary keys, so an un-generated or hand-attached value still type-checks.

## `Lifetime`

```ts
type Lifetime = "singleton" | "session" | "request"
```

See [Values and lifetimes](/guide/dependency-injection#the-three-lifetimes).

## `HttpMethod`

```ts
type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"
```

Route definitions widen this to `HttpMethod | "ALL"`.

## Routes

```ts
type RouteHandlerFn = (
  req: CloveRequest,
  res: CloveResponse,
  ctx: RuntimeCtx,
) => unknown | Promise<unknown>
```

```ts
interface RouteMeta {
  /** Set false to disable the built-in JSON middleware for this route. */
  json?: boolean
  [key: string]: unknown
}
```

```ts
interface Route {
  method: HttpMethod | "ALL"
  path: string
  handler: RouteHandlerFn
  meta: Readonly<RouteMeta>
  /** Absolute path of the file this route came from. Used in error messages. */
  file: string
}
```

`Route` is what middlewares receive as `route`, and what `app.routes.list()`
returns.

## Middlewares

```ts
interface MiddlewareArgs {
  route: Route
  handler: { execute(): Promise<unknown> }
  req: CloveRequest
  res: CloveResponse
  ctx: RuntimeCtx
}

type MiddlewareFn = (args: MiddlewareArgs) => unknown | Promise<unknown>
```

## Services and values

```ts
type ServiceFactory<T = any> = (ctx: RuntimeCtx, hooks: LifecycleHooks) => T
type ValueFactory<T = any> = (ctx: RuntimeCtx, hooks: LifecycleHooks) => T

interface DiSpec<T = any> {
  lifetime: Lifetime
  value: T | ValueFactory<T>
}

interface LifecycleHooks {
  onDestroy(fn: () => void | Promise<void>): void
}
```

`ServiceFactory` returns a bare `T` rather than `T | Promise<T>` deliberately:
with a union, `this` inside a returned object literal widens to include
`PromiseLike`, breaking sibling-method calls. Consumers unwrap with `Awaited<T>`.

## WebSockets

```ts
interface WsArgs {
  onMessage(fn: (msg: string | Buffer) => void | Promise<void>): void
  onClose(fn: () => void | Promise<void>): void
  onDestroy(fn: () => void | Promise<void>): void
  send(data: string | Buffer | object): void
  close(code?: number, reason?: string): void
  ctx: RuntimeCtx
  req: CloveRequest
  params: Record<string, string>
}

type WsHandlerFn = (args: WsArgs) => void | Promise<void>
```

## Definition types

The values the wrappers return. You rarely name these directly — they appear in
`typeof import(...)` positions inside generated declarations.

| Type | Produced by |
| --- | --- |
| `RouteDefinition` | `get()`, `post()`, … |
| `MiddlewareDefinition` | `middleware()` |
| `ServiceDefinition<T>` | `service()` |
| `DiDefinition<T>` | `di()` |
| `WsDefinition` | `ws()` |

## Type helpers

```ts
type CloveService<T>   // the awaited value a service() definition resolves to
type CloveDi<T>        // the value a di() definition resolves to, factory or not
```

Used by `.clove/types.d.ts`; available to you for the same purpose.

## Runtime and server types

| Type | Description |
| --- | --- |
| `BootstrapOptions` | Options for [`bootstrap()`](/guide/bootstrap) |
| `AppOptions` | Options for `createApp()` and `engine()` |
| `Clove` | What `bootstrap()` resolves to: `app`, `server`, `port`, `host`, `url`, `close()` |
| `CloveEngine` | What `engine()` resolves to — see [Express interop](/guide/express-interop) |
| `SessionStore` | The `get` / `set` / `touch` / `destroy` contract |
| `CookieOptions` | Options for `res.cookie()` |
| `Logger`, `LogLevel` | The logger interface and its levels |
