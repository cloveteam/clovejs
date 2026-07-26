import { consume } from "clovejs/bus"

/** A wildcard selector: the envelope still carries the concrete channel. */
export default consume<{ orderId: string }>({
  bus: "events",
  channel: "orders.#",
  subscription: "audit",

  async handler(payload, ctx, message) {
    ctx.log.record({
      channel: message.channel,
      subscription: message.subscription,
      attempt: message.attempt,
      payload,
    })
  },
})
