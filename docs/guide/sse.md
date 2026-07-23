# Server-Sent Events

`sse()` declares a one-way streaming endpoint over plain HTTP. It lives in
`api/` like any GET route — so it flows through the middleware chain and
supports `[param]` segments — but the handler receives a push-oriented
`SseArgs` instead of `(req, res)`, and the connection stays open until the
client disconnects or you call `close()`.

```ts
// src/api/notifications/[userId]/stream.ts
import { sse } from "clovejs"

export default sse(async ({ ctx, params, send, onClose }) => {
  const feed = ctx.notifications.subscribe(params.userId)
  onClose(() => feed.unsubscribe())
  await feed.forEach((n) => send(n))   // objects are JSON-serialised
})
```

`GET /api/notifications/:userId/stream` responds with `text/event-stream`. The
runtime writes the SSE framing (`data:`, `event:`, `id:`, blank-line
terminators) for you — you never format the wire protocol by hand.

## What the handler receives

| Field | What it is |
| --- | --- |
| `send(data)` | Sends a `message` event; objects are JSON-serialised |
| `emit(event)` | Sends a named event, see [Typed events](#typed-events) |
| `comment(text)` | Writes a `: comment` line (an explicit keep-alive) |
| `lastEventId` | The client's `Last-Event-ID` on reconnect, else `undefined` |
| `onClose(fn)` | Called when the connection ends, from either side |
| `onDestroy(fn)` | Teardown, run after `onClose` at final cleanup |
| `close()` | Ends the stream from the server side |
| `open` | `false` once the connection has ended — check before heavy work |
| `ctx` | The DI context for this connection |
| `req` | The [request](/reference/clove-request) |
| `params` | `[param]` segments from the path |

The handler may return early after wiring up subscriptions — like a `ws()`
handler, the stream stays open until it is closed.

## Typed events

`emit()` sends a named event with an optional `id` and per-event `retry` hint:

```ts
emit({ event: "price", id: "42", data: { symbol: "ACME", bid: 12.3 } })
```

On the client:

```js
const es = new EventSource("/api/prices/stream")
es.addEventListener("price", (e) => console.log(JSON.parse(e.data)))
```

`send(data)` is shorthand for `emit({ data })` — the default `message` event.

## Reconnect and resume

Browsers reconnect automatically and send the last `id:` they saw as the
`Last-Event-ID` header. Read it from `lastEventId` to resume without gaps:

```ts
export default sse(async ({ lastEventId, emit }) => {
  const cursor = lastEventId ?? "0"
  for await (const evt of eventLog.since(cursor)) {
    emit({ id: evt.seq, event: evt.type, data: evt.payload })
  }
})
```

## Heartbeats and reconnect hints

Idle-timeout proxies drop a quiet connection. A heartbeat writes a comment line
on an interval to keep it alive — set it (and an initial `retry:` hint) with a
chainable `.options()`, the way routes carry `.meta()`:

```ts
export default sse(handler).options({
  heartbeat: 15_000,   // send `: ping` every 15s while idle
  retry: 3_000,        // tell the client to wait 3s before reconnecting
})
```

## Scoping and lifecycle

Each connection runs inside its **own request-scoped container**, disposed when
the stream ends — so `request`-lifetime `di/` values behave per-connection, and
their `onDestroy` hooks run on disconnect. `singleton` values are shared with the
rest of the app; `session` values resolve from the request's session cookie.

Because `sse()` is an ordinary route, everything in `middlewares/` runs first —
authenticate, rate-limit, or set CORS there exactly as you would for a JSON
endpoint. A middleware that throws (say, a 401) short-circuits before the stream
opens, so the client gets a normal error response rather than an empty stream.

## Testing

The [test harness](/guide/testing) opens a stream in memory — no socket, no
port — and hands back a reader:

```ts
const stream = app.sse("/api/v1/ticker")
expect((await stream.next()).data).toBe('{"n":1}')

await stream.close()      // simulates a client disconnect; runs onClose
```

`stream.messages` and `stream.comments` collect everything received so far;
`stream.next()` waits for the next event.

## Dropping to raw Node

`sse()` is a convenience layer over the response stream. For full control you can
still write the stream yourself from an ordinary route — see
[Request and response](/guide/request-response#dropping-to-raw-node).
