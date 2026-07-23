import { sse } from "clovejs"

// The centerpiece: a live event stream for /api/channels/:channel/stream.
//
// `sse()` lives in `api/` like any GET route — it runs through the middleware
// chain and gets `[channel]` from the path — but the handler pushes events
// instead of returning a body, and the connection stays open until the client
// disconnects. The runtime writes the `text/event-stream` framing for you.
export default sse(async ({ params, lastEventId, ctx, emit, onClose }) => {
  const channel = params.channel

  // Reconnect resume: a browser's EventSource sends the last id it saw back as
  // `Last-Event-ID`. Replay everything published since then so no event is
  // missed across a dropped connection.
  const cursor = lastEventId ? Number(lastEventId) : 0
  for (const event of ctx.feed.since(channel, cursor)) {
    emit({ event: event.type, id: String(event.seq), data: event })
  }

  // Then live: subscribe, and forward each new event as a named SSE event with
  // its sequence number as the id.
  const unsubscribe = ctx.feed.subscribe(channel, (event) => {
    emit({ event: event.type, id: String(event.seq), data: event })
  })
  ctx.logger.info(`stream opened on ${channel} (${ctx.feed.live(channel)} live)`)

  // The handler returns here, but the stream stays open. `onClose` runs when
  // the client disconnects (or the server shuts down), so this is the only
  // cleanup needed — the request scope is torn down right after.
  onClose(() => {
    unsubscribe()
    ctx.logger.info(`stream closed on ${channel}`)
  })
})
  // Keep the connection alive through idle-timeout proxies, and tell the client
  // to wait 2s before reconnecting.
  .options({ heartbeat: 15_000, retry: 2_000 })
