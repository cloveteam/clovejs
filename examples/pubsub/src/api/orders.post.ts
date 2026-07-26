import { post } from "clovejs"
import type { OrderCreated } from "../consumers/billing/orderCreated.js"

/**
 * The producer side: publishing is just `ctx.bus.<name>.publish(...)`.
 *
 * The bus is named explicitly — there is no default — so this reads the same
 * whether the project has one bus or four, and adding a second one never
 * silently retargets an existing call.
 *
 * Try `customer: "flaky@example.com"` to watch billing retry with backoff, and
 * a negative `total` to watch it reject outright.
 */
export default post(async (req, res, ctx) => {
  const body = req.body as Partial<OrderCreated>
  const order: OrderCreated = {
    orderId: body.orderId ?? `ord-${Date.now()}`,
    customer: body.customer ?? "customer@example.com",
    total: body.total ?? 42,
  }

  await ctx.bus.events.publish("orders.created", order, { key: order.orderId })

  res.status(202)
  return { published: "orders.created", order }
})
