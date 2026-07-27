import {
  bus,
  type DeliveredMessage,
  type DeliveryOutcome,
  type MessageBus,
} from "clovejs/bus"

/**
 * A bus that hands core raw bytes and lets a test choose them.
 *
 * Adapters normally decode in their own consume callback, which is exactly the
 * hole worth testing: bytes that cannot be decoded have to reach a verdict
 * instead of throwing where nothing can ack them.
 */
export interface RawBus extends MessageBus {
  push(message: Partial<DeliveredMessage>): Promise<DeliveryOutcome>
}

let deliver: ((message: DeliveredMessage) => Promise<DeliveryOutcome>) | null = null

const raw: RawBus = {
  capabilities: {
    retries: "immediate",
    patterns: false,
  },

  async publish() {
    /* the test drives `push` directly */
  },

  async subscribe(_spec, hand) {
    deliver = hand
    return {
      async close() {
        deliver = null
      },
    }
  },

  async push(message) {
    if (!deliver) throw new Error("nothing is subscribed to bus/raw")
    return await deliver({
      channel: "raw.probe",
      subscription: "probe",
      ...message,
    })
  },
}

export default bus(raw)
