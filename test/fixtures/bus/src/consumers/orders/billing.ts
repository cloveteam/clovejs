import { consume, reject } from "clovejs/bus"

export default consume<{ orderId: string; total: number }>({
  bus: "events",
  channel: "orders.created",
  subscription: "billing",

  async handler(order, ctx, message) {
    ctx.log.record({
      channel: message.channel,
      subscription: message.subscription,
      attempt: message.attempt,
      failures: message.failures,
      payload: order,
    })

    if (order.total < 0) throw reject(`negative total on ${order.orderId}`)
    if (ctx.log.shouldFail(order.orderId, 2)) {
      throw new Error(`transient failure on ${order.orderId}`)
    }
    await ctx.bus.events.publish("invoice.created", { orderId: order.orderId })
  },
}).retry({ attempts: 3 })
