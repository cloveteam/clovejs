import {
  encodeJson,
  matchChannel,
  type BusSubscription,
  type DeliveredMessage,
  type MessageBus,
  type SubscriptionSpec,
} from "clovejs/bus"

/**
 * A hand-written bus adapter, in about fifty lines and with no dependencies.
 *
 * This is what wrapping a real SDK looks like: declare what the transport can
 * actually do, translate `publish`, and drive the delivery loop in `subscribe`
 * — handing each message to `deliver` and turning the outcome it returns into
 * whatever the broker calls the same thing.
 *
 * Modelled on Redis Pub/Sub, which is the interesting case: it fans a message
 * out to every live subscriber and then forgets it. Nothing redelivers, nothing
 * is acknowledged, and a subscriber that was offline never sees the message.
 * Saying so in `capabilities` is what lets CloveJS refuse, at boot, to let a
 * consumer here declare `.retry(...)` — a promise this transport cannot keep.
 */
export function fanoutBus(): MessageBus {
  const subscribers = new Set<{
    spec: SubscriptionSpec
    deliver(message: DeliveredMessage): Promise<unknown>
    closed: boolean
  }>()

  return {
    capabilities: {
      // An un-acked message never comes back: there is no queue behind this,
      // so a consumer here declaring `.retry(...)` is a boot error.
      retries: "none",
      // `PSUBSCRIBE`-style wildcards.
      patterns: true,
    },

    async publish(channel, payload) {
      // Encoded once rather than per subscriber: this is the serialization
      // boundary a real transport has, and passing `body` is what puts decoding
      // inside the delivery path, where a malformed message gets a verdict.
      const body = encodeJson(payload)

      for (const subscriber of subscribers) {
        const selects = subscriber.spec.pattern
          ? matchChannel(subscriber.spec.channel, channel)
          : subscriber.spec.channel === channel
        if (subscriber.closed || !selects) continue

        // Deliberately not awaited: a publisher does not wait for subscribers,
        // and the outcome is discarded because there is nothing to ack.
        void subscriber.deliver({
          channel,
          subscription: subscriber.spec.subscription,
          body,
          headers: {},
          timestamp: new Date(),
        })
      }
    },

    async subscribe(spec, deliver, { report }) {
      const subscriber = { spec, deliver, closed: false }
      subscribers.add(subscriber)
      // Core cannot see this loop, so a real adapter reports here whenever the
      // connection drops and comes back. `app.bus.health()` reads the result,
      // which is what makes a silently dead subscription visible to a probe.
      report("consuming")

      const subscription: BusSubscription = {
        async close() {
          subscriber.closed = true
          subscribers.delete(subscriber)
          report("stopped")
        },
      }
      return subscription
    },
  }
}
