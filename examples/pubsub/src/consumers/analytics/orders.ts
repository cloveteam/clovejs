import { consume, pattern } from "clovejs/bus"

/**
 * Every order event at once, via a wildcard selector: `*` matches one
 * dot-separated segment, `#` matches zero or more. So this sees
 * `orders.created`, `orders.cancelled` and anything added later without a code
 * change here.
 *
 * `pattern()` is required rather than inferred from the `#`. Sniffing for
 * wildcard punctuation is wrong in both directions — a literal channel named
 * `user.#1` would silently become a subscription to far more than intended, and
 * there would be no way to say otherwise — so the two readings are asked for by
 * name, `pattern()` and `literal()`.
 *
 * A selector is only allowed when the bus advertises `patterns: true`; otherwise
 * this is a boot error naming both files. `message.channel` is always the
 * concrete channel the producer published to, never the pattern — that is what
 * makes a wildcard consumer able to tell its events apart.
 *
 * `maxInFlight` raises concurrency within this process. It is a concurrency
 * limit and not an ordering guarantee: a second replica has its own, so order
 * is a property of the broker topology, never of this number.
 */
export default consume<{ orderId: string }>({
  bus: "events",
  channel: pattern("orders.#"),
  subscription: "analytics",
  maxInFlight: 8,

  async handler(order, ctx, message) {
    ctx.ledger.record(message.channel, order.orderId)
  },
})
