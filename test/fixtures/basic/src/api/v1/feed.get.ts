import { sse } from "clovejs"

/**
 * An open-ended SSE stream with a fast heartbeat: sends one greeting, then holds
 * the connection open until the client disconnects. Used to exercise heartbeats
 * and client-initiated teardown.
 */
export default sse(async ({ ctx, send, onClose }) => {
  ctx.stats.streamsOpened++
  onClose(() => {
    ctx.stats.streamsClosed++
  })
  send({ hello: true })
}).options({ heartbeat: 20 })
