import { consume } from "clovejs/bus"

/**
 * A consumer on the fire-and-forget bus.
 *
 * There is no `.retry(...)` here, and that is not an oversight: `bus/presence`
 * advertises `redelivery: false`, so adding one is a boot error naming this
 * file and the bus file. Retrying on a transport that never redelivers is not a
 * slower success, it is a promise nothing can keep — so CloveJS refuses it at
 * boot rather than letting it look like it works.
 *
 * A handler that throws here is rejected immediately and logged. For presence
 * that is exactly right: the next heartbeat is worth more than this one.
 */
export default consume<{ userId: string }>({
  bus: "presence",
  channel: "user.*",
  subscription: "live",

  async handler(event, ctx, message) {
    ctx.ledger.presence(message.channel, event.userId)
  },
})
