import { post } from "clovejs"

/**
 * The other bus. Same call shape, different guarantees: this one is
 * fire-and-forget, so nothing is queued and a subscriber that is offline never
 * sees the message. `202` rather than `201` says so.
 */
export default post(async (req, res, ctx) => {
  const body = req.body as { userId?: string }
  const userId = body.userId ?? "u-1"

  await ctx.bus.presence.publish("user.active", { userId })

  res.status(202)
  return { published: "user.active", userId }
})
