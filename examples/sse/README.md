# CloveJS — Server-Sent Events example

A live activity feed. `sse()` endpoints are files under `src/api/` — they run
through the middleware chain like any GET route, but stream events to the client
instead of returning a body, and stay open until the client disconnects. The
runtime handles the `text/event-stream` framing, heartbeats and reconnect.

[`../websocket`](../websocket) covers the two-way case; [`../rest`](../rest)
covers routing, DI and sessions.

## Run it

From the repository root (this example is an npm workspace, so one install
covers it):

```bash
npm install
npm run dev -w clovejs-example-sse
```

Or from this directory once the root install has run:

```bash
cd examples/sse
npm run dev
```

Then open **<http://localhost:3000/api>** — a self-contained page that streams
the `demo` channel over `EventSource`. Open it in two tabs and publish from one;
the event appears in both.

## What to look at

| File | Demonstrates |
| --- | --- |
| [`src/api/clock.get.ts`](./src/api/clock.get.ts) | The smallest stream: `send()` a value on a timer, clean up in `onClose` |
| [`src/api/channels/[channel]/stream.get.ts`](./src/api/channels/%5Bchannel%5D/stream.get.ts) | Named `emit()` events, `Last-Event-ID` resume, heartbeats, a parameterised path |
| [`src/services/feed.ts`](./src/services/feed.ts) | Fan-out: a singleton every stream shares |
| [`src/api/channels/[channel].post.ts`](./src/api/channels/%5Bchannel%5D.post.ts) | Pushing into a stream from an HTTP route |
| [`src/middlewares/requestLog.0.ts`](./src/middlewares/requestLog.0.ts) | Middlewares run for SSE — unlike WebSocket upgrades |

## Try it from the terminal

`curl -N` disables buffering so events print as they arrive:

```bash
# The minimal stream — server time, once a second
curl -N http://localhost:3000/api/clock

# The channel stream — leave it running in one terminal…
curl -N http://localhost:3000/api/channels/demo/stream
```

…then publish into it from another terminal, with the stream still open:

```bash
curl -X POST localhost:3000/api/channels/demo \
  -H 'content-type: application/json' \
  -d '{"type":"alert","data":{"text":"Deploy finished"}}'
```

The event arrives on the open stream. Its recent state is readable over HTTP too:

```bash
curl localhost:3000/api/channels/demo
```

## Reconnect resume

Every event carries a sequence number, sent as the SSE `id:`. When a client
reconnects, the browser sends the last id it saw as the `Last-Event-ID` header,
and the handler replays what was missed:

```bash
# Publish a few events, then ask for everything after #2
curl -N -H 'Last-Event-ID: 2' http://localhost:3000/api/channels/demo/stream
```

In [`stream.get.ts`](./src/api/channels/%5Bchannel%5D/stream.get.ts) that is:

```ts
const cursor = lastEventId ? Number(lastEventId) : 0
for (const event of ctx.feed.since(channel, cursor)) {
  emit({ event: event.type, id: String(event.seq), data: event })
}
```

## How fan-out works

An `sse()` handler gets its own request-scoped container per connection, disposed
when the stream ends. Singletons live above that and are shared by every
connection — so [`src/services/feed.ts`](./src/services/feed.ts) holds the
subscriber registry, and each stream just registers a callback and removes it in
`onClose`. An HTTP `POST` calls the same singleton, so it lands in every open
stream. Nothing global of your own, and no way to leak a subscriber past a
disconnect.

Full explanations live in the [guide](https://cloveteam.github.io/clovejs/guide/sse).
