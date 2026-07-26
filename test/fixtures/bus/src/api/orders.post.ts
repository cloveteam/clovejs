import { post } from "clovejs"

export default post(async (req, _res, ctx) => {
  const order = req.body as { orderId: string; total: number }
  await ctx.bus.events.publish("orders.created", order, { key: order.orderId })
  return { published: true }
})
