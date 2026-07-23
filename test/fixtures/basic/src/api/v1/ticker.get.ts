import { sse } from "clovejs"

/**
 * A finite SSE stream: emits three numbered `tick` events, then closes. When the
 * client reconnects with `Last-Event-ID`, it resumes from the next number, so a
 * test can exercise the reconnect cursor.
 */
export default sse(async ({ ctx, lastEventId, emit, onClose, close }) => {
  ctx.stats.streamsOpened++
  onClose(() => {
    ctx.stats.streamsClosed++
  })

  const start = lastEventId ? Number(lastEventId) + 1 : 1
  for (let n = start; n < start + 3; n++) {
    emit({ event: "tick", id: String(n), data: { n } })
  }
  close()
})
