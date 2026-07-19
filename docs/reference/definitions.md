# Definitions

The functions that mark a module's default export as something the scanner
should pick up. All are exported from `clovejs`.

## Route wrappers

```ts
import { get, post, put, patch, del, head, options, all } from "clovejs"
```

```ts
get(handler: RouteHandlerFn): RouteDefinition
```

| Function | Method |
| --- | --- |
| `get` | `GET` |
| `post` | `POST` |
| `put` | `PUT` |
| `patch` | `PATCH` |
| `del` | `DELETE` |
| `head` | `HEAD` |
| `options` | `OPTIONS` |
| `all` | Matches every method |

The handler receives `(req, res, ctx)`. Its return value is interpreted by the
[JSON middleware](/guide/json-middleware).

### `.meta(meta)`

Attaches [route metadata](/guide/route-metadata). Chainable; merges with any
previous call.

```ts
export default get(handler).meta({ adminOnly: true, json: false })
```

## `middleware(fn)`

```ts
middleware(fn: MiddlewareFn): MiddlewareDefinition
```

`fn` receives `{ route, handler, req, res, ctx }` and should return
`handler.execute()` unless it means to short-circuit. Files in `middlewares/`
run in [priority order](/guide/middlewares#ordering).

## `service(factory)`

```ts
service<T>(factory: (ctx, hooks) => T | Promise<T>): ServiceDefinition<T>
```

A singleton, created once at boot and exposed as `ctx.<filename>`. `hooks`
provides `onDestroy(fn)`.

The factory's declared return type is a bare `T` rather than `T | Promise<T>`
on purpose: with a union, `this` inside a returned object literal widens to
include `PromiseLike`, and calling a sibling method stops type-checking.
Callers unwrap with `Awaited<T>`.

## `di(spec)`

```ts
di<T>(spec: { lifetime: Lifetime; value: T | ValueFactory<T> }): DiDefinition<T>
```

An injected value, exposed as `ctx.<filename>`.

| Field | Type | Meaning |
| --- | --- | --- |
| `lifetime` | `"singleton" \| "session" \| "request"` | [Scope](/guide/dependency-injection#the-three-lifetimes) |
| `value` | `T` or `(ctx, hooks) => T` | A plain value, or a factory |

A `value` that is a function is treated as a **factory**. To inject a function
as a value, return it from a factory: `value: () => myFn`.

## `ws(handler)`

```ts
ws(handler: (args: WsArgs) => void | Promise<void>): WsDefinition
```

A WebSocket endpoint. The handler runs once per connection; see
[WebSockets](/guide/websockets) for the fields on `args`.

## `error(status, body?)`

```ts
error(status: number, body?: unknown): HttpError
```

Creates an error the pipeline renders as a response instead of a `500`.

```ts
throw error(400, { message: "username and password are required" })
```

If `body` is an object with a `message` property, that value also becomes the
`Error.message`. A string body is used as the message directly. Omitting the
body produces `{ message: "HTTP <status>" }`.

## `isHttpError(value)`

```ts
isHttpError(value: unknown): value is HttpError
```

Prefer this over `instanceof HttpError`. A project can end up with more than
one copy of the framework loaded (ESM alongside CJS, or a hoisting miss); this
checks a shared symbol brand, so it works across copies.

## Also exported

| Export | What it is |
| --- | --- |
| `bootstrap`, `engine` | Entry points — see [Bootstrap](/guide/bootstrap) |
| `createApp`, `CloveApp` | Boot without listening |
| `CloveRequest`, `CloveResponse` | The [request](/reference/clove-request) and [response](/reference/clove-response) wrappers |
| `HttpError`, `CloveBootError` | Error classes |
| `MemorySessionStore` | The default in-process [session store](/guide/sessions#custom-stores) |
| `createLogger` | Builds the console logger used by default |
| `CloveService<T>`, `CloveDi<T>` | Type helpers used by the [generated declarations](/guide/typed-context) |
