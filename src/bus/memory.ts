import type {
  BusSubscription,
  DeliveryOutcome,
  MessageBus,
  MessageEnvelope,
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
  attempt: number
  payload: unknown
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
  deliver(message: MessageEnvelope): Promise<DeliveryOutcome>
  closed: boolean
  active: number
  queue: Array<() => Promise<void>>
}

/**
 * An in-process bus for development, tests and single-process deployments —
 * the analogue of `MemoryCacheStore` and `MemorySessionStore`.
 *
 * Supports everything the contract offers, so a project developed against it
 * behaves the same way once a real broker is dropped in: wildcard selectors,
 * accurate attempt counts, honored retry delays, and `publish()` that resolves
 * only once the message has been accepted.
 *
 * ```ts
 * // src/bus/events.ts
 * import { bus, memoryBus } from "clovejs/bus"
 * export default bus(memoryBus())
 * ```
 */
export function memoryBus(): MemoryBus {
  const subs = new Set<Sub>()
  const published: PublishRecord[] = []
  const dead: DeadRecord[] = []
  const inflight = new Set<Promise<void>>()

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
      track(job().finally(() => {
        sub.active -= 1
        pump(sub)
      }))
    }
  }

  function schedule(sub: Sub, message: MessageEnvelope, delay: number): void {
    sub.queue.push(async () => {
      if (delay > 0) await sleep(delay)
      if (sub.closed) return
      const outcome = await sub.deliver(message)
      if (outcome.action === "retry") {
        schedule(
          sub,
          { ...message, attempt: outcome.attempt },
          outcome.delay,
        )
      } else if (outcome.action === "reject") {
        dead.push({
          channel: message.channel,
          subscription: message.subscription,
          reason: outcome.reason,
          attempt: outcome.attempt,
          payload: message.payload,
        })
      }
    })
    pump(sub)
  }

  return {
    capabilities: {
      redelivery: true,
      attempts: true,
      delayedRetry: true,
      patterns: true,
      confirms: true,
    },

    get published() {
      return published
    },

    get dead() {
      return dead
    },

    async publish(channel, payload, options) {
      published.push({ channel, payload, ...(options ? { options } : {}) })
      for (const sub of subs) {
        if (sub.closed || !matchChannel(sub.spec.channel, channel)) continue
        schedule(
          sub,
          {
            channel,
            subscription: sub.spec.subscription,
            // Structured-clone the payload so a handler mutating it cannot
            // reach back into the publisher's object, as a real broker's
            // serialization boundary would prevent.
            payload: clone(payload),
            attempt: 1,
            headers: Object.freeze({ ...options?.headers }),
            ...(options?.id ? { id: options.id } : {}),
            ...(options?.key ? { key: options.key } : {}),
            timestamp: new Date(),
          },
          0,
        )
      }
    },

    async subscribe(spec, deliver) {
      const sub: Sub = { spec, deliver, closed: false, active: 0, queue: [] }
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

/**
 * AMQP-style topic matching: `*` stands for exactly one dot-separated segment,
 * `#` for zero or more. A selector with neither is compared literally.
 */
export function matchChannel(selector: string, channel: string): boolean {
  if (!selector.includes("*") && !selector.includes("#")) {
    return selector === channel
  }
  return matchSegments(selector.split("."), channel.split("."))
}

function matchSegments(pattern: string[], value: string[]): boolean {
  if (pattern.length === 0) return value.length === 0

  const [head, ...rest] = pattern
  if (head === "#") {
    // `#` is greedy but backtracks: try consuming 0, 1, ... remaining segments.
    for (let i = 0; i <= value.length; i++) {
      if (matchSegments(rest, value.slice(i))) return true
    }
    return false
  }

  if (value.length === 0) return false
  if (head !== "*" && head !== value[0]) return false
  return matchSegments(rest, value.slice(1))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    // Never hold the process open for a pending redelivery.
    timer.unref?.()
  })
}

function clone<T>(value: T): T {
  if (value === null || typeof value !== "object") return value
  try {
    return structuredClone(value)
  } catch {
    // Functions, class instances and other non-cloneable payloads pass through
    // untouched: a memory bus should never be the reason a dev app breaks.
    return value
  }
}
