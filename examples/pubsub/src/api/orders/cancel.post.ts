import { post } from "clovejs"

/**
 * A second channel under the same prefix, to show the wildcard consumer
 * picking it up. Nothing in `consumers/analytics/orders.ts` changes to see it:
 * it subscribes to `orders.#`.
 */
export default post(async (req, res, ctx) => {
  const body = req.body as { orderId?: string }
  const orderId = body.orderId ?? "ord-unknown"

  await ctx.bus.events.publish("orders.cancelled", { orderId }, { key: orderId })

  res.status(202)
  return { published: "orders.cancelled", orderId }
})
