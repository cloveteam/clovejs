import { post } from "clovejs"

/**
 * The other bus. Same call shape, different guarantees: this one advertises
 * `confirms: false`, so `publish()` resolves before anything has received the
 * message — which is why the app logs a warning naming it at boot.
 */
export default post(async (req, res, ctx) => {
  const body = req.body as { userId?: string }
  const userId = body.userId ?? "u-1"

  await ctx.bus.presence.publish("user.active", { userId })

  res.status(202)
  return { published: "user.active", userId }
})
