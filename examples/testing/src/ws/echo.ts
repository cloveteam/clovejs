import { ws } from "clovejs"

// A minimal echo socket. The websocket test connects to it in memory — no real
// upgrade — sends a message and asserts on what comes back.
export default ws(async ({ onMessage, send, ctx }) => {
  send(JSON.stringify({ hello: true }))

  onMessage((msg) => {
    ctx.logger.debug("echoing: " + msg)
    send(msg)
  })
})
