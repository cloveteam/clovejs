# Definitions

The functions that mark a module's default export as something the scanner
should pick up. All are exported from `clovejs`, except the MCP definitions,
which come from `clovejs/mcp`.

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

### `.cache(policy)`

Caches the terminal handler outcome for a `GET` or `HEAD` route while the full
middleware interceptor chain continues to run on every request.

```ts
export default get(handler).cache({
  ttl: "1m",
  staleWhileRevalidate: "5m",
  tags: ["notes"],
  client: { maxAge: "30s" },
})
```

See [Caching](/guide/caching) for keys, HTTP validators, safety rules and store
adapters.

### `.invalidates(tags)`

Invalidates cache tags after the handler and middleware chain complete
successfully:

```ts
export default post(handler).invalidates(["notes"])
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
service<M>(
  factory: (ctx, hooks) => (M & ThisType<M>) | Promise<M & ThisType<M>>,
): ServiceDefinition<M>
```

A singleton, created once at boot and exposed as `ctx.<filename>`. `hooks`
provides `onDestroy(fn)`. `M` is the resolved service value — the object of
methods.

## `di(spec)`

```ts
di<T>(spec: {
  lifetime: Lifetime
  value: T | ValueFactory<T>
  eager?: boolean
}): DiDefinition<T>
```

An injected value, exposed as `ctx.<filename>`.

| Field | Type | Meaning |
| --- | --- | --- |
| `lifetime` | `"singleton" \| "session" \| "request"` | [Scope](/guide/dependency-injection#the-three-lifetimes) |
| `value` | `T` or `(ctx, hooks) => T` | A plain value, or a factory |
| `eager` | `boolean` | Resolve when the scope opens, not on first access |

Resolution is lazy by default, so a factory nothing reads never runs. `eager`
turns a `request`-lifetime value into a per-request and
[per-delivery hook](/guide/message-bus#per-delivery-hooks): start the span in
the factory, close it in `onDestroy`. It requires a factory — `eager` on a plain
value is a boot error.

A `value` that is a function is treated as a **factory**. To inject a function
as a value, return it from a factory: `value: () => myFn`.

## `ws(handler)`

```ts
ws(handler: (args: WsArgs) => void | Promise<void>): WsDefinition
```

A WebSocket endpoint. The handler runs once per connection; see
[WebSockets](/guide/websockets) for the fields on `args`.

## `sse(handler)`

```ts
sse(
  handler: (args: SseArgs) => void | Promise<void>,
): SseRouteDefinition

// SseRouteDefinition extends RouteDefinition with:
.options(options: { heartbeat?: number; retry?: number }): SseRouteDefinition
```

A [Server-Sent Events](/guide/sse) endpoint. Lives in `api/` and runs through
the middleware chain like a GET route, but the handler streams events through
`args` and the connection stays open until the client disconnects or `close()`
is called. Stream options are set with a chainable `.options()`, as routes carry
`.meta()`: `heartbeat` sends keep-alive comments on an interval; `retry` sets
the initial reconnect hint.

## `views(engine)`

```ts
views(engine: ViewEngine): ViewsDefinition
```

Registers the project's [template engine](/guide/templates). Lives in `views.ts`
at the source root — one per project. `engine.render(template, data, ctx)` is the
only required member and owns all engine-specific work; it may return a `string`
or `Buffer`, sync or async. An optional `engine.contentType` sets the default
response type (a `res.type()` shorthand or full MIME), defaulting to `html`.

```ts
export default views({
  render: (template, data, ctx) => eta.render(template, data),
})
```

## `view(template, data?)`

```ts
view(template: string, data?: unknown): ViewResult
```

Marks a handler's return value for [template rendering](/guide/templates). The
pipeline hands `template` and `data` to the registered engine before it considers
JSON, so a handler stays a pure function of its inputs.

```ts
export default get(async (req) => view("notes/detail", { id: req.params.id }))
```

## `bus(source)`

```ts
bus(source: MessageBus | BusFactory): BusDefinition
```

From `clovejs/bus`. One broker connection, exposed as `ctx.bus.<filename>`. The
source is either a `MessageBus` object or a `(ctx, hooks)` factory, branching on
`typeof` exactly like `di()`. See [Message bus](/guide/message-bus).

## `consume(spec)`

```ts
// With validation: the payload type is inferred from `input`.
consume<S extends MessageSchema>(spec: {
  bus: BusName
  channel: ChannelSelector
  subscription: string
  input: S
  maxInFlight?: number
  ordered?: "per-key" | "per-partition"
  handler: (payload: InferPayload<S>, ctx, message) => unknown
}): ConsumerDefinition

// Without it: name the payload type.
consume<Payload = unknown>(spec: {
  bus: BusName
  channel: ChannelSelector
  subscription: string
  maxInFlight?: number
  ordered?: "per-key" | "per-partition"
  handler: (payload: Payload, ctx, message) => unknown
}): ConsumerDefinition
```

From `clovejs/bus`. One subscription. Unlike routes, nothing is derived from the
file path — see
[why](/guide/message-bus#nothing-is-derived-from-the-file-path).

| Field | Meaning |
| --- | --- |
| `bus` | Which `bus/` file to bind to. Checked against the generated `BusRegistry` |
| `channel` | A literal string, or `pattern("orders.#")` when the bus advertises `patterns`. A bare string containing `*`, `#` or `>` is a boot error — use `pattern()` or `literal()` |
| `subscription` | The durable subscriber identity — a queue, a consumer group |
| `input` | Optional payload schema. Omit it and use `consume<Payload>({...})` |
| `maxInFlight` | Concurrent deliveries **in this process**. Defaults to 1. A concurrency limit, not an ordering guarantee |

Two overloads rather than one, so pass **either** `input` **or** a type
argument. Supplying both is a type error: the explicit type argument selects the
second overload, which does not accept `input`. See
[Validation](/guide/message-bus#validation).

### `.retry(policy)`

```ts
.retry({
  attempts: number
  backoff?: { base, factor?, max?, jitter? }
})
```

Chainable, like `.meta()`. `attempts` caps **handler failures**, including the
first — a delivery that never ran the handler to a verdict does not spend one,
and bounding those is the broker's job. Boot-checked against the bus's
`retries` capability. See
[Retries](/guide/message-bus#retries).

## `reject(reason)`

```ts
reject(reason: string): RejectSignal
```

From `clovejs/bus`. Thrown from a consumer to end a delivery without retrying,
in the style of `error()`.

## `tool(spec)`

```ts
import { tool } from "clovejs/mcp"

tool(spec: McpToolSpec): McpToolDefinition
```

An [MCP](/guide/mcp) tool — an action a model can invoke. `spec` takes
`description` (required), and optionally `name`, `title` and `input`. The
returned definition has a chainable `.meta()`, as route definitions do.

`input` accepts `z.object({...})` or the bare `{ a: z.string() }` shape it
wraps, and types the handler's first argument from it.

## `resource(spec)`

```ts
import { resource } from "clovejs/mcp"

resource(spec: McpResourceSpec): McpResourceDefinition
```

An MCP resource — data a client reads by URI. `spec` takes `description`
(required), and optionally `uri`, `name`, `title` and `mimeType`. Without an
explicit `uri`, one is [derived from the file path](/guide/mcp#resources).

## `prompt(spec)`

```ts
import { prompt } from "clovejs/mcp"

prompt(spec: McpPromptSpec): McpPromptDefinition
```

An MCP prompt — a template the user picks explicitly. Same fields as `tool()`
minus the annotations. Prompt arguments must be `z.string()`; anything else is
a boot error.

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
| `ScopeUnavailableError` | Thrown when an isolated scope is asked for a lifetime it lacks |

### From `clovejs/bus`

| Export | What it is |
| --- | --- |
| `bus`, `consume`, `reject` | The definitions above |
| `pattern()`, `literal()` | Declare a channel as a broker-expanded selector, or as a literal containing wildcard characters |
| `memoryBus(options?)` | In-process bus for dev, tests and single-process deployments. `capabilities` mirrors the broker you deploy against |
| `readFailures`, `stampFailures`, `ATTEMPT_HEADER` | Carry the failure counter across a retry hop |
| `encodeJson`, `decodeJson`, `MessageDecodeError` | The default wire format, for `publish()` and a custom `decode` |
| `matchChannel(selector, channel)` | The wildcard matcher, for adapters that need one |
| `MessageValidationError` | Raised when a payload fails `input` |

### From `clovejs/testing`

| Export | What it is |
| --- | --- |

The rest of the testing entrypoint — `createTestApp` and friends — is covered in
[Testing](/guide/testing).
