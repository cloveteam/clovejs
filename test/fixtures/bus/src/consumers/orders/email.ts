import { consume } from "clovejs/bus"
import { z } from "zod"

/** The same channel as `billing.ts`, under its own subscription. */
export default consume({
  bus: "events",
  channel: "orders.created",
  subscription: "email",
  input: z.object({ orderId: z.string(), total: z.number().nonnegative() }),

  async handler(order, ctx, message) {
    ctx.log.record({
      channel: message.channel,
      subscription: message.subscription,
      attempt: message.attempt,
      payload: order,
    })
  },
})
