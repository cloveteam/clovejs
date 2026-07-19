# Middlewares

Any file in `middlewares/` wraps every route. Code before `handler.execute()`
runs on the way in, code after it on the way out; returning without calling it
short-circuits.

```ts
// src/middlewares/authorize.ts
import { middleware, error } from "clovejs"

export default middleware(async ({ route, handler, ctx }) => {
  if (route.meta.adminOnly && !ctx.currentUser?.isAdmin) {
    throw error(403, { message: "Forbidden for non-admins" })
  }
  return handler.execute()
})
```

## What the handler receives

```ts
middleware(async ({ route, handler, req, res, ctx }) => { … })
```

| Field | What it is |
| --- | --- |
| `route` | The matched route: `method`, `path`, `meta`, and the source `file` |
| `handler` | `{ execute(): Promise<unknown> }` — runs the rest of the chain |
| `req` | [`CloveRequest`](/reference/clove-request) |
| `res` | [`CloveResponse`](/reference/clove-response) |
| `ctx` | The DI context for this request |

## The three shapes

**Around** — the common case. Do work, delegate, do more work:

```ts
export default middleware(async ({ handler, ctx }) => {
  const started = Date.now()
  const result = await handler.execute()
  ctx.logger.info(`took ${Date.now() - started}ms`)
  return result
})
```

**Short-circuit** — never call `execute()`. Whatever you return becomes the
response:

```ts
export default middleware(async ({ req, handler }) => {
  if (req.header("x-maintenance") === "1") {
    return { message: "Down for maintenance" }
  }
  return handler.execute()
})
```

**Reject** — throw an [`error()`](/guide/errors). The pipeline renders it:

```ts
throw error(401, { message: "Not signed in" })
```

::: warning Return what `execute()` returns
A middleware that calls `handler.execute()` but returns something else — or
nothing — replaces the handler's result. Unless that is the intent, always
`return handler.execute()` or return the awaited value.
:::

## Ordering

Middlewares run alphabetically by default, which stops scaling quickly. Add a
numeric suffix to pin the order — lower runs first:

```
middlewares/
  trace.0.ts         first
  authenticate.1.ts
  audit.1.2.ts       between .1 and .2, no renames needed
  authorize.2.ts
  stamp.ts           unnumbered: after everything numbered
```

The fractional form is the point of the scheme: inserting a step between two
existing ones never means renumbering the file that comes after it.

Ordering is *outermost first*: `trace.0.ts` sees the request before
`authorize.2.ts` and sees the response after it.

## Per-route application

There is no per-route registration — every middleware wraps every route.
Opt out from inside the middleware, using [route metadata](/guide/route-metadata):

```ts
export default middleware(async ({ route, handler }) => {
  if (route.meta.public) return handler.execute()
  // …authenticate…
  return handler.execute()
})
```

Keeping the decision in one file means you can read the whole policy at once,
instead of chasing registrations across a route table.

## Middlewares and WebSockets

HTTP middlewares do **not** run for WebSocket upgrades. Authenticate inside the
`ws()` handler using `ctx`. See [WebSockets](/guide/websockets).
