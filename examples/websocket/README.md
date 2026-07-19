# CloveJS — WebSocket example

A chat server in about sixty lines: sockets are files under `src/ws/`, their
paths become URLs the same way HTTP routes do, and they share services with the
rest of the app.

[`../rest`](../rest) covers routing, DI and sessions; [`../mcp`](../mcp) covers
the Model Context Protocol.

## Run it

From the repository root (this example is an npm workspace, so one install
covers it):

```bash
npm install
npm run dev -w clovejs-example-websocket
```

Or from this directory once the root install has run:

```bash
cd examples/websocket
npm run dev
```

## What to look at

| File | Demonstrates |
| --- | --- |
| [`src/ws/echo.ts`](./src/ws/echo.ts) | The smallest socket: `send`, `onMessage`, `onDestroy` |
| [`src/ws/chat/[room].ts`](./src/ws/chat/%5Broom%5D.ts) | A parameterised socket route, `params` and `req.query`, per-connection cleanup |
| [`src/services/chat.ts`](./src/services/chat.ts) | Broadcast: a singleton every connection shares |
| [`src/api/rooms/[room].post.ts`](./src/api/rooms/%5Broom%5D.post.ts) | Pushing into a socket room from an HTTP route |
| [`src/api/rooms/[room].get.ts`](./src/api/rooms/%5Broom%5D.get.ts) | Reading the same live state over HTTP |

## Try it

Two terminals, using [`wscat`](https://github.com/websockets/wscat) (no install
needed — `npx` fetches it):

```bash
# Terminal 1
npx wscat -c 'ws://localhost:3000/ws/chat/lobby?as=ada'

# Terminal 2
npx wscat -c 'ws://localhost:3000/ws/chat/lobby?as=grace'
```

Type in either one and it arrives in the other. Now push a message in from
HTTP, with both still connected:

```bash
curl -X POST localhost:3000/api/rooms/lobby \
  -H 'content-type: application/json' \
  -d '{"from":"ops","text":"Deploy finished"}'
```

Both sockets receive it. The room's state is readable over HTTP too:

```bash
curl localhost:3000/api/rooms/lobby
```

The plain echo socket is there as the minimal case:

```bash
npx wscat -c ws://localhost:3000/ws/echo
```

If you use a JetBrains IDE, [`requests.http`](./requests.http) has all of this
as clickable blocks, WebSocket ones included.

## How broadcasting works

A `ws()` handler gets its own request-scoped container per connection, disposed
when the socket closes. Singletons live above that and are shared by every
connection — so `src/services/chat.ts` holds the subscriber registry, and each
socket just registers a callback and unregisters it in `onDestroy`. Nothing
global of your own, and no way to leak a subscriber past a disconnect.

One thing to note: **HTTP middlewares do not run for WebSocket upgrades.** A
socket that needs an identity reads `ctx` directly inside the handler rather
than relying on a middleware to have populated it.

Full explanations live in the [guide](https://cloveteam.github.io/clovejs/).
