import { consume } from "clovejs/bus"

/**
 * Every order event at once, via a wildcard selector: `*` matches one
 * dot-separated segment, `#` matches zero or more. So this sees
 * `orders.created`, `orders.cancelled` and anything added later without a code
 * change here.
 *
 * A pattern is only allowed when the bus advertises `patterns: true`; otherwise
 * this is a boot error naming both files. `message.channel` is always the
 * concrete channel the producer published to, never the pattern — that is what
 * makes a wildcard consumer able to tell its events apart.
 *
 * `maxInFlight` raises concurrency, which is an explicit trade: it forfeits
 * per-key ordering, so it belongs on a counter and not on anything that cares
 * whether "created" was processed before "cancelled".
 */
export default consume<{ orderId: string }>({
  bus: "events",
  channel: "orders.#",
  subscription: "analytics",
  maxInFlight: 8,

  async handler(order, ctx, message) {
    ctx.ledger.record(message.channel, order.orderId)
  },
})
