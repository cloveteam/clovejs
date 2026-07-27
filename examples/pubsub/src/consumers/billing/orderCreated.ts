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
  // The bus advertises `retries: "delayed"`, so both the redelivery and the
  // backoff are honored. Against a bus advertising anything less, this line is a
  // boot error naming both files — see bus/presence.ts.
  //
  // `attempts` caps *handler failures*, which is the only number core can see.
  // A delivery lost to a crash or to an expired drain timeout never ran the
  // handler to a verdict, so it never spent an attempt — bounding those is the
  // broker's job, via a redrive policy or a max-delivery setting on the queue.
  .retry({ attempts: 4, backoff: { base: 250, factor: 2, max: 5_000 } })
