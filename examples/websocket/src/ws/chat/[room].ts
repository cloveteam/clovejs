import { ws } from "clovejs"
import type { ChatMessage } from "../../services/chat.js"

// Serves /ws/chat/:room — `[room]` is a parameter, same as in an HTTP route,
// and arrives on `params`.
//
// Each connection gets its own request-scoped container, disposed when the
// socket closes, so `unsubscribe` in `onDestroy` is all the cleanup needed.
export default ws(async ({ params, req, send, onMessage, onDestroy, ctx }) => {
  const room = params.room
  const who = req.query.as ?? `guest-${Math.random().toString(36).slice(2, 6)}`

  // Replay what was said before this socket joined.
  for (const msg of ctx.chat.recent(room)) send(msg)

  const unsubscribe = ctx.chat.subscribe(room, (msg: ChatMessage) => send(msg))
  ctx.logger.info(`${who} joined ${room} (${ctx.chat.occupants(room)} here)`)
  ctx.chat.publish(room, "system", `${who} joined`)

  onMessage((raw) => {
    // Returning an object from `send` serializes it as JSON; incoming frames
    // arrive as a string (or Buffer, when the client sends binary).
    ctx.chat.publish(room, who, String(raw))
  })

  onDestroy(async () => {
    unsubscribe()
    ctx.chat.publish(room, "system", `${who} left`)
    ctx.logger.info(`${who} left ${room}`)
  })
})
