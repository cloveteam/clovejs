import { consume } from "clovejs/bus"
import { z } from "zod"

/**
 * The same channel as `consumers/billing/orderCreated.ts`, under a different
 * subscription — one event, two independent readers, each with its own retry
 * budget and its own failures.
 *
 * This is why the channel is not derived from the file path: both of these
 * would have to be the same file for that to work.
 *
 * `input` validates the payload at the process boundary, because the producer
 * is not this codebase. Anything that fails is rejected rather than retried: a
 * payload that does not parse on attempt one will not parse on attempt two.
 */
export default consume({
  bus: "events",
  channel: "orders.created",
  subscription: "email",
  input: z.object({
    orderId: z.string(),
    customer: z.string().email(),
    total: z.number().nonnegative(),
  }),

  async handler(order, ctx, message) {
    ctx.deliveryLog.note(`email: order ${order.orderId} (attempt ${message.attempt})`)
    ctx.inbox.send(order.customer, `Thanks for order ${order.orderId}`)
  },
})
