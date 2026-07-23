import { post, error } from "clovejs"

// Pushes an event into a channel from plain HTTP. `ctx.feed` is the same
// singleton the stream handlers hold, so a POST here lands in every browser
// connected to /api/channels/:channel/stream.
export default post(async (req, res, ctx) => {
  const { type, data } = (req.body ?? {}) as { type?: string; data?: unknown }
  if (!type) {
    throw error(400, { message: "type is required" })
  }

  const event = ctx.feed.publish(req.params.channel, type, data ?? {})
  res.status(201)
  return event
})
