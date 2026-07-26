import { consume, reject } from "clovejs/bus"

export interface OrderCreated {
  orderId: string
  customer: string
  total: number
}

/**
 * Billing's view of `orders.created`.
 *
 * Nothing here is derived from the file path. A channel is a contract shared
 * with whoever publishes it, and this same channel has two other consumers —
 * see the sibling files — so `channel` and `subscription` are written out. The
 * path only names this consumer in logs and boot errors.
 */
export default consume<OrderCreated>({
  bus: "events",
  channel: "orders.created",
  subscription: "billing",

  async handler(order, ctx) {
    // A failure a redelivery can never fix: skip the remaining attempts and
    // dead-letter it now rather than burning four more deliveries on it.
    if (order.total < 0) throw reject(`negative total on order ${order.orderId}`)

    const invoice = await ctx.invoices.createForOrder(order)
    await ctx.bus.events.publish("invoice.created", invoice, { key: invoice.orderId })
  },
})
  // The bus advertises `attempts: true` and `delayedRetry: true`, so both of
  // these are honored. Against a bus that advertises either as false, this line
  // is a boot error naming both files — see src/bus/presence.ts.
  .retry({ attempts: 4, backoff: { base: 250, factor: 2, max: 5_000 } })
