import { ws } from "clovejs"

// Serves /ws/echo. HTTP middlewares do not run for upgrades, so this reads
// ctx directly rather than relying on the authorize middleware.
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
