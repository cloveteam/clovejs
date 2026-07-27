import { consume } from "clovejs/bus"

/** Always fails, so `retry({ attempts })` has something to exhaust. */
export default consume<{ orderId: string }>({
  bus: "events",
  channel: "orders.flaky",
  subscription: "flaky",

  async handler(order) {
    throw new Error(`always fails: ${order.orderId}`)
  },
}).retry({ attempts: 3 })
