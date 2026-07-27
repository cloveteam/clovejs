import { matchChannel } from "./channel.js"
import { encodeJson } from "./codec.js"
import { readFailures } from "./attempts.js"
import type {
  BusCapabilities,
  BusSubscription,
  DeliveredMessage,
  DeliveryOutcome,
  MessageBus,
  PublishOptions,
  SubscriptionSpec,
} from "./types.js"

/** One `publish()` call, kept for assertions. */
export interface PublishRecord {
  channel: string
  payload: unknown
  options?: PublishOptions
}

/** One message the runtime rejected, kept instead of a dead-letter queue. */
export interface DeadRecord {
  channel: string
  subscription: string
  reason: string
  failures: number
  payload: unknown
}

export interface MemoryBusOptions {
  /**
   * Claim less than the whole contract, to mirror the broker this project
   * actually deploys against.
   *
   * The default claims everything, which makes the memory bus the most capable
   * bus there is — and so the weakest possible check: no capability mismatch can
   * surface against it, and every one waits for the day a real adapter is
   * dropped in. Passing production's answers here moves those boot errors to
   * where they are cheap.
   */
  capabilities?: Partial<BusCapabilities>
}

export interface MemoryBus extends MessageBus {
  /** Every message published through this bus, in order. */
  readonly published: readonly PublishRecord[]
  /** Every message that ended in `reject`, this bus's dead-letter queue. */
  readonly dead: readonly DeadRecord[]
  /** Resolves once every queued and in-flight delivery has settled. */
  drain(): Promise<void>
  /** Forgets recorded messages without disturbing subscriptions. */
  clear(): void
}

interface Sub {
  spec: SubscriptionSpec
  deliver(message: DeliveredMessage): Promise<DeliveryOutcome>
  closed: boolean
  active: number
  queue: Array<() => Promise<void>>
}

const FULL_CAPABILITIES: BusCapabilities = {
  retries: "delayed",
  patterns: true,
}

/**
 * An in-process bus for development, tests and single-process deployments —
 * the analogue of `MemoryCacheStore` and `MemorySessionStore`.
 *
 * By default it supports the whole contract: wildcard selectors, accurate
 * counters, honored retry delays, and a `publish()` that resolves only once the
 * message is queued for every matching consumer. That makes an app developed
 * against it *portable*, not identical — pass `capabilities` to mirror the
 * broker you deploy against.
 *
 * ```ts
 * // src/bus/events.ts
 * import { bus, memoryBus } from "clovejs/bus"
 * export default bus(memoryBus())
 * ```
 */
export function memoryBus(options: MemoryBusOptions = {}): MemoryBus {
  const capabilities: BusCapabilities = { ...FULL_CAPABILITIES, ...options.capabilities }
  const subs = new Set<Sub>()
  const published: PublishRecord[] = []
  const dead: DeadRecord[] = []
  const inflight = new Set<Promise<void>>()
  /** Stands in for the message id a real broker assigns on publish. */
  let sequence = 0

  function track(work: Promise<void>): void {
    // Settled entries are removed by a handler attached before `drain()`
    // observes the set, so a completed pass never looks like a full one. The
    // rejection arm also keeps a throwing adapter from surfacing as an
    // unhandled rejection.
    const tracked: Promise<void> = work.then(
      () => void inflight.delete(tracked),
      () => void inflight.delete(tracked),
    )
    inflight.add(tracked)
  }

  function pump(sub: Sub): void {
    while (!sub.closed && sub.active < sub.spec.maxInFlight && sub.queue.length > 0) {
      const job = sub.queue.shift()!
      sub.active += 1
      track(
        job().finally(() => {
          sub.active -= 1
          pump(sub)
        }),
      )
    }
  }

  function schedule(sub: Sub, message: DeliveredMessage, delay: number): void {
    sub.queue.push(async () => {
      if (delay > 0 && capabilities.retries === "delayed") await sleep(delay)
      if (sub.closed) return

      const outcome = await sub.deliver({
        ...message,
        // A bus that never redelivers has no counter to carry, so core sees
        // every delivery as the first, exactly as it would in production.
        failures:
          capabilities.retries === "none" ? 0 : readFailures(message.headers),
      })

      if (outcome.action === "retry") {
        if (capabilities.retries === "none") return
        schedule(
          sub,
          // The retry goes back to this subscription alone, carrying the headers
          // core stamped. Re-publishing to the channel instead would hand a copy
          // to every *other* subscription bound to it as well.
          { ...message, headers: outcome.headers },
          outcome.delay,
        )
      } else if (outcome.action === "reject") {
        dead.push({
          channel: message.channel,
          subscription: sub.spec.subscription,
          reason: outcome.reason,
          failures: outcome.failures,
          payload: message.payload,
        })
      }
    })
    pump(sub)
  }

  function fanOut(
    channel: string,
    payload: unknown,
    options: PublishOptions | undefined,
    id: string,
  ): void {
    for (const sub of subs) {
      if (sub.closed) continue
      const selects = sub.spec.pattern
        ? matchChannel(sub.spec.channel, channel)
        : sub.spec.channel === channel
      if (!selects) continue

      schedule(
        sub,
        {
          id,
          channel,
          subscription: sub.spec.subscription,
          // Round-trip through the wire format, so a payload that a real
          // broker could not carry — a class instance, a Date, a function —
          // fails here rather than only in production.
          body: encodeJson(payload),
          headers: { ...options?.headers },
          ...(options?.id ? { id: options.id } : {}),
          ...(options?.key ? { key: options.key } : {}),
          timestamp: new Date(),
        },
        0,
      )
    }
  }

  return {
    capabilities,

    get published() {
      return published
    },

    get dead() {
      return dead
    },

    async publish(channel, payload, options) {
      published.push({ channel, payload, ...(options ? { options } : {}) })
      fanOut(channel, payload, options, `m${++sequence}`)
    },

    async subscribe(spec, deliver) {
      const sub: Sub = {
        spec,
        deliver,
        closed: false,
        active: 0,
        queue: [],
      }
      subs.add(sub)
      const subscription: BusSubscription = {
        async close() {
          sub.closed = true
          sub.queue.length = 0
          subs.delete(sub)
        },
      }
      return subscription
    },

    async drain() {
      // Retries enqueue more work as they settle, so keep draining until a full
      // pass leaves nothing behind.
      while (inflight.size > 0) {
        await Promise.allSettled([...inflight])
      }
    },

    clear() {
      published.length = 0
      dead.length = 0
    },
  }
}

export { matchChannel } from "./channel.js"

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    // Never hold the process open for a pending redelivery.
    timer.unref?.()
  })
}
