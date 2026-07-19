import { post, error } from "clovejs"

// An HTTP route that pushes into a WebSocket room. `ctx.chat` is the same
// singleton the socket handlers hold, so a POST here lands in every browser
// connected to /ws/chat/:room.
export default post(async (req, res, ctx) => {
  const { from, text } = (req.body ?? {}) as { from?: string; text?: string }
  if (!text) {
    throw error(400, { message: "text is required" })
  }

  const msg = ctx.chat.publish(req.params.room, from ?? "http", text)
  res.status(201)
  return msg
})
