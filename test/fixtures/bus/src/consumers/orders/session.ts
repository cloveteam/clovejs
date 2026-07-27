import { consume } from "clovejs/bus"

/** Reaches for a session-lifetime value, which a delivery does not have. */
export default consume<{ orderId: string }>({
  bus: "events",
  channel: "orders.session",
  subscription: "session-probe",

  async handler(_payload, ctx) {
    ctx.log.record({
      channel: "orders.session",
      subscription: "session-probe",
      attempt: 1,
      failures: 0,
      payload: ctx.sessionOnly,
    })
  },
})
