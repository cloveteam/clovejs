# WebSockets

Files in `ws/` map to socket endpoints the same way routes do, `[param]`
segments included. `ws/echo.ts` serves `/ws/echo`:

```ts
import { ws } from "clovejs"

export default ws(async ({ onMessage, onDestroy, send, ctx, params }) => {
  onMessage((msg) => {
    ctx.logger.info("message received: " + msg)
    send(msg)
  })
  onDestroy(async () => {
    ctx.logger.info("socket closed")
  })
})
```

The handler runs **once per connection**, when the socket opens. Register your
listeners and return; the connection stays alive until either side closes it.

## What the handler receives

| Field | What it is |
| --- | --- |
| `onMessage(fn)` | Called for each inbound frame with `string \| Buffer` |
| `onClose(fn)` | Called when the socket closes |
| `onDestroy(fn)` | Teardown, run when the connection's scope is disposed |
| `send(data)` | Sends a string, Buffer, or object (JSON-serialised) |
| `close(code?, reason?)` | Closes the connection |
| `ctx` | The DI context for this connection |
| `req` | The upgrade [request](/reference/clove-request) |
| `params` | `[param]` segments from the path |

## Path parameters

```ts
// src/ws/rooms/[room].ts
import { ws } from "clovejs"

export default ws(async ({ params, send, onMessage, ctx }) => {
  const room = await ctx.rooms.join(params.room)
  onMessage((msg) => room.broadcast(msg))
  send(JSON.stringify({ joined: params.room }))
})
```

`/ws/rooms/general` matches, with `params.room === "general"`.

## Scoping and lifecycle

Each connection gets its **own request-scoped container**, disposed when the
socket closes. That means `request`-lifetime `di/` values behave per-connection
rather than per-message: resolved once when first read, torn down on close.

`singleton` values are shared with the HTTP side as usual. `session` values
resolve from the session cookie sent with the upgrade request, if there is one.

## Authentication

::: warning HTTP middlewares do not run for upgrades
Nothing in `middlewares/` is invoked for a WebSocket handshake. Authenticate
inside the handler.
:::

```ts
import { ws } from "clovejs"

export default ws(async ({ req, ctx, close, onMessage }) => {
  const user = await ctx.auth.verify(req.cookie.token)
  if (!user) {
    close(4401, "unauthorized")
    return
  }
  onMessage((msg) => { /* … */ })
})
```

Closing with a code in the `4000–4999` range is the conventional way to signal
an application-level reason to the client.

## Sending structured messages

`send()` serialises objects for you:

```ts
send({ type: "tick", at: Date.now() })   // sent as JSON text
```

Strings and Buffers pass through untouched.

## Attaching the upgrade handler

Under [`bootstrap()`](/guide/bootstrap) this is automatic. If you are mounting
Clove inside another server, wire the upgrade yourself:

```ts
const clove = await engine(app)
const server = app.listen(3000)
clove.attachUpgrade(server)   // only if you use WebSockets
```

See [Express interop](/guide/express-interop).
