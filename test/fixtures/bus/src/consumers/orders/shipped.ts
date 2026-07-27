import { consume } from "clovejs/bus"
import { z } from "zod"

/**
 * A schema that names the fields it keeps, so anything else in the payload is
 * dropped before the handler — and before `message.payload`.
 */
export default consume({
  bus: "events",
  channel: "orders.shipped",
  subscription: "shipping",
  input: z.object({ orderId: z.string() }),

  async handler(order, ctx, message) {
    ctx.log.record({
      channel: message.channel,
      subscription: message.subscription,
      attempt: message.attempt,
      failures: message.failures,
      payload: order,
    })
  },
})
