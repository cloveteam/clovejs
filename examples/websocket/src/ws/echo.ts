import { ws } from "clovejs"

// The simplest possible socket, served at /ws/echo — the file path becomes the
// URL exactly as it does for HTTP routes.
//
// HTTP middlewares do not run for upgrades, so a socket that needs an identity
// reads `ctx` directly rather than relying on a middleware.
export default ws(async ({ onMessage, onDestroy, send, ctx }) => {
  ctx.logger.info("socket connected")
  send("connected")

  onMessage((msg) => {
    send(msg)
  })

  onDestroy(async () => {
    ctx.logger.info("socket closed")
  })
})
