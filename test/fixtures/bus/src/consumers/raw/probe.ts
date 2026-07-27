import { consume } from "clovejs/bus"

/** Records what survived decoding, including which headers it was handed. */
export default consume<{ ok: boolean }>({
  bus: "raw",
  channel: "raw.probe",
  subscription: "probe",

  async handler(payload, ctx, message) {
    ctx.log.record({
      channel: message.channel,
      subscription: message.subscription,
      attempt: message.attempt,
      failures: message.failures,
      payload: { payload, headers: message.headers },
    })
  },
})
