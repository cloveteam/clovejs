import type {
  BusSubscription,
  MessageBus,
  MessageEnvelope,
  SubscriptionSpec,
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
    deliver(message: MessageEnvelope): Promise<unknown>
    closed: boolean
  }>()

  return {
    capabilities: {
      // An un-acked message never comes back: there is no queue behind this.
      redelivery: false,
      // With no redelivery there is no counter to keep.
      attempts: false,
      delayedRetry: false,
      // `PSUBSCRIBE`-style wildcards.
      patterns: true,
      // Fire-and-forget: publish() resolves before anyone has received it.
      confirms: false,
    },

    async publish(channel, payload) {
      for (const subscriber of subscribers) {
        if (subscriber.closed || !matches(subscriber.spec.channel, channel)) continue
        // Deliberately not awaited: a publisher does not wait for subscribers,
        // and the outcome is discarded because there is nothing to ack.
        void subscriber.deliver({
          channel,
          subscription: subscriber.spec.subscription,
          payload,
          attempt: 1,
          headers: {},
          timestamp: new Date(),
        })
      }
    },

    async subscribe(spec, deliver) {
      const subscriber = { spec, deliver, closed: false }
      subscribers.add(subscriber)
      const subscription: BusSubscription = {
        async close() {
          subscriber.closed = true
          subscribers.delete(subscriber)
        },
      }
      return subscription
    },
  }
}

/** `*` matches one dot-separated segment, `#` matches zero or more. */
function matches(selector: string, channel: string): boolean {
  if (!selector.includes("*") && !selector.includes("#")) return selector === channel
  return matchSegments(selector.split("."), channel.split("."))
}

function matchSegments(pattern: string[], value: string[]): boolean {
  if (pattern.length === 0) return value.length === 0
  const [head, ...rest] = pattern
  if (head === "#") {
    for (let i = 0; i <= value.length; i++) {
      if (matchSegments(rest, value.slice(i))) return true
    }
    return false
  }
  if (value.length === 0) return false
  if (head !== "*" && head !== value[0]) return false
  return matchSegments(rest, value.slice(1))
}
