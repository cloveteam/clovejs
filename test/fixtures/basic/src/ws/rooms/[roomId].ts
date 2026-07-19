import { ws } from "clovejs"

/** Socket routes support `[param]` segments just like HTTP routes. */
export default ws(async ({ onMessage, send, params }) => {
  send(JSON.stringify({ room: params.roomId }))
  onMessage((msg) => {
    send(`${params.roomId}: ${msg}`)
  })
})
