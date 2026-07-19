import { ws } from "clovejs"

export default ws(async ({ onMessage, onDestroy, send, ctx }) => {
  ctx.logger.debug("socket connected")
  ctx.stats.socketsOpened++
  send(JSON.stringify({ hello: true }))

  onMessage((msg) => {
    send(msg)
  })

  onDestroy(async () => {
    ctx.stats.socketsDestroyed++
    ctx.logger.debug("socket destroyed")
  })
})
