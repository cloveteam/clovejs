import { bus, type MessageBus } from "clovejs/bus"

/** A fire-and-forget bus: no redelivery, no counter, no confirms. */
const fanout: MessageBus = {
  capabilities: {
    redelivery: false,
    attempts: false,
    delayedRetry: false,
    patterns: false,
    confirms: false,
  },
  async publish() {
    /* dropped: nothing subscribes in the fixture */
  },
  async subscribe() {
    return { async close() {} }
  },
}

export default bus(fanout)
