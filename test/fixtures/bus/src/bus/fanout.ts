import { bus, type MessageBus } from "clovejs/bus"

/** A fire-and-forget bus: nothing comes back, nothing expands. */
const fanout: MessageBus = {
  capabilities: {
    retries: "none",
    patterns: false,
  },
  async publish() {
    /* dropped: nothing subscribes in the fixture */
  },
  async subscribe() {
    return { async close() {} }
  },
}

export default bus(fanout)
