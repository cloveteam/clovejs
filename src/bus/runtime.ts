import type { Container } from "../container/container.js"
import type { Logger } from "../container/logger.js"
import type { Registry } from "../container/registry.js"
import { CloveBootError } from "../errors.js"
import { isReject } from "./definitions.js"
import { asValidationError, type Validator } from "./schema.js"
import { computeDelay } from "./retry.js"
import type { PublishRecord } from "./memory.js"
import type {
  BusSubscription,
  ConsumerHandler,
  DeliveryOutcome,
  MessageBus,
  MessageEnvelope,
  Publisher,
  RetryPolicy,
} from "./types.js"

/** A `bus/` file, resolved into a registry provider. */
export interface LoadedBus {
  /** Derived from the filename: `bus/events.ts` is `events`. */
  name: string
  /** Registry key the resolved {@link MessageBus} lives under. */
  key: string
  file: string
}

/** A `consumers/` file, validated and ready to subscribe. */
export interface LoadedConsumer {
  /** Path-derived display name, e.g. `billing/orderCreated`. Not an identity. */
  name: string
  bus: string
  channel: string
  subscription: string
  maxInFlight: number
  input: Validator | null
  handler: ConsumerHandler<unknown>
  retry: RetryPolicy | null
  file: string
}

export interface BusScan {
  buses: LoadedBus[]
  consumers: LoadedConsumer[]
}

export interface BusRuntimeOptions {
  scan: BusScan
  root: Container
  registry: Registry
  logger: Logger
  /** How long shutdown waits for in-flight deliveries. Defaults to 30s. */
  drainTimeout?: number
}

/**
 * Bus instances are registered under a namespaced key so they resolve, connect
 * and tear down with every other singleton, without occupying a `ctx` name a
 * user file could ever claim — `deriveContextKey` only ever produces
 * identifiers, so a colon cannot collide.
 */
export const BUS_PROVIDER_PREFIX = "bus:"

export function busProviderKey(name: string): string {
  return BUS_PROVIDER_PREFIX + name
}

/** Characters that mean "wildcard" to AMQP and NATS. */
const WILDCARD = /[*#>]/

export const DEFAULT_DRAIN_TIMEOUT = 30_000

export interface DispatchInput {
  /** Required only when the channel is ambiguous across buses. */
  bus?: string
  channel: string
  /** Required only when several consumers share the channel. */
  subscription?: string
  payload: unknown
  /** Simulate a redelivery. Defaults to 1. */
  attempt?: number
  headers?: Record<string, string>
  id?: string
  key?: string
}

/**
 * Drives `consumers/` against the buses declared in `bus/`.
 *
 * Built like `WsRuntime`: it owns the delivery lifecycle — a fresh isolated
 * request scope per message, validation, the handler, and the ack/retry/reject
 * decision — and knows nothing about any broker.
 */
export class BusRuntime {
  #options: BusRuntimeOptions
  #instances = new Map<string, MessageBus>()
  #subscriptions: BusSubscription[] = []
  #inflight = new Set<Promise<unknown>>()
  #eagerKeys: string[] = []
  #started = false
  #closed = false

  constructor(options: BusRuntimeOptions) {
    this.#options = options
  }

  get empty(): boolean {
    return this.#options.scan.buses.length === 0
  }

  get names(): string[] {
    return this.#options.scan.buses.map((b) => b.name)
  }

  get counts(): { buses: number; consumers: number } {
    return {
      buses: this.#options.scan.buses.length,
      consumers: this.#options.scan.consumers.length,
    }
  }

  get started(): boolean {
    return this.#started
  }

  /**
   * Resolves every bus and checks it against the consumers bound to it.
   *
   * Runs after `root.ensure()` and before anything subscribes, so a project
   * asking for a guarantee its broker cannot provide fails at boot, naming both
   * files, rather than at 3am on a poison message.
   */
  async init(): Promise<void> {
    const { scan, root, registry, logger } = this.#options
    this.#eagerKeys = registry.eagerKeys("request")

    for (const entry of scan.buses) {
      const instance = await root.resolveAsync(entry.key)
      assertBusShape(instance, entry)
      this.#instances.set(entry.name, instance as MessageBus)
    }

    for (const consumer of scan.consumers) {
      const bus = this.#instances.get(consumer.bus)
      if (!bus) continue // Unreachable: the scanner already matched the names.
      const caps = bus.capabilities
      const busFile = scan.buses.find((b) => b.name === consumer.bus)!.file
      const attempts = consumer.retry?.attempts ?? 1

      if (attempts > 1 && !caps.redelivery) {
        throw new CloveBootError(
          `Consumer "${consumer.name}" declares retry({ attempts: ${attempts} }), but ` +
            `bus "${consumer.bus}" advertises redelivery: false — an un-acked ` +
            `message never comes back, so retrying cannot happen. Drop the ` +
            `retry() call, or bind this consumer to a bus that redelivers.`,
          [consumer.file, busFile],
        )
      }
      if (attempts > 1 && !caps.attempts) {
        throw new CloveBootError(
          `Consumer "${consumer.name}" declares retry({ attempts: ${attempts} }), but ` +
            `bus "${consumer.bus}" advertises attempts: false — it cannot report ` +
            `an accurate delivery count, so the cap would never fire and a ` +
            `failing message would redeliver forever. Carry the counter with ` +
            `stampAttempt()/readAttempt() in the adapter, or drop the retry() call.`,
          [consumer.file, busFile],
        )
      }
      if ((consumer.retry?.backoff?.base ?? 0) > 0 && !caps.delayedRetry) {
        throw new CloveBootError(
          `Consumer "${consumer.name}" declares a retry backoff, but bus ` +
            `"${consumer.bus}" advertises delayedRetry: false — the delay would ` +
            `be silently dropped and redeliveries would spin at broker speed. ` +
            `Drop the backoff, or give the adapter a delay mechanism.`,
          [consumer.file, busFile],
        )
      }
      if (WILDCARD.test(consumer.channel) && !caps.patterns) {
        throw new CloveBootError(
          `Consumer "${consumer.name}" subscribes to the pattern ` +
            `"${consumer.channel}", but bus "${consumer.bus}" advertises ` +
            `patterns: false. Subscribe to a concrete channel instead.`,
          [consumer.file, busFile],
        )
      }
    }

    for (const entry of scan.buses) {
      if (!this.#instances.get(entry.name)!.capabilities.confirms) {
        logger.warn(
          `Bus "${entry.name}" advertises confirms: false — ` +
            `\`ctx.bus.${entry.name}.publish()\` resolves before the broker has ` +
            `accepted the message, so a publish can be silently lost.`,
        )
      }
    }
  }

  /** The resolved bus by name. Throws when the project defines no such file. */
  bus(name: string): MessageBus {
    const instance = this.#instances.get(name)
    if (!instance) {
      const known = this.names
      throw new Error(
        `No bus named "${name}". ` +
          (known.length
            ? `This project defines: ${known.join(", ")}.`
            : "This project defines no bus/ files."),
      )
    }
    return instance
  }

  /** The narrow publish-only facade exposed as `ctx.bus.<name>`. */
  publisher(name: string): Publisher {
    return {
      publish: (channel, payload, options) =>
        this.bus(name).publish(channel, payload, options),
    }
  }

  /** Messages published through an in-memory bus. For assertions in tests. */
  published(name: string): readonly PublishRecord[] {
    const instance = this.bus(name) as Partial<{ published: PublishRecord[] }>
    if (!Array.isArray(instance.published)) {
      throw new Error(
        `Bus "${name}" does not record published messages. ` +
          "This is available on memoryBus(); a real broker adapter cannot provide it.",
      )
    }
    return instance.published
  }

  /** Subscribes every consumer. Idempotent. */
  async start(): Promise<void> {
    if (this.#started || this.#closed) return
    this.#started = true

    for (const consumer of this.#options.scan.consumers) {
      const bus = this.bus(consumer.bus)
      const subscription = await bus.subscribe(
        {
          channel: consumer.channel,
          subscription: consumer.subscription,
          maxInFlight: consumer.maxInFlight,
        },
        (message) => this.#track(this.#deliver(consumer, message)),
      )
      this.#subscriptions.push(subscription)
    }
  }

  /**
   * Runs one message through the full delivery path with no broker involved:
   * scope creation, eager values, validation, handler, outcome.
   */
  async dispatch(input: DispatchInput): Promise<DeliveryOutcome> {
    const consumer = this.#resolveTarget(input)
    return await this.#deliver(consumer, {
      channel: input.channel,
      subscription: consumer.subscription,
      payload: input.payload,
      attempt: input.attempt ?? 1,
      headers: Object.freeze({ ...input.headers }),
      ...(input.id ? { id: input.id } : {}),
      ...(input.key ? { key: input.key } : {}),
      timestamp: new Date(),
    })
  }

  /** Waits for queued and in-flight deliveries to settle. */
  async drain(timeout = this.#options.drainTimeout ?? DEFAULT_DRAIN_TIMEOUT): Promise<number> {
    const deadline = Date.now() + timeout

    // Let in-process buses flush anything queued but not yet handed over.
    const queued = [...this.#instances.values()]
      .filter(isDrainable)
      .map((instance) => instance.drain())
    if (queued.length > 0) {
      await Promise.race([Promise.allSettled(queued), sleep(timeout)])
    }

    while (this.#inflight.size > 0) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      await Promise.race([Promise.allSettled([...this.#inflight]), sleep(remaining)])
    }
    return this.#inflight.size
  }

  /**
   * Stops subscriptions, then drains what is already running.
   *
   * Deliveries still in flight when the timeout expires are abandoned un-acked,
   * so an at-least-once broker redelivers them. Each is logged rather than
   * quietly acked, because acking work that did not finish is data loss.
   */
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true

    await Promise.all(
      this.#subscriptions.map((subscription) =>
        subscription.close().catch((err) =>
          this.#options.logger.error("Error closing bus subscription:", err),
        ),
      ),
    )
    this.#subscriptions = []

    const abandoned = await this.drain()
    if (abandoned > 0) {
      this.#options.logger.warn(
        `Shutdown timed out with ${abandoned} delivery/deliveries still running. ` +
          "They were not acknowledged and will be redelivered.",
      )
    }
  }

  /**
   * Registers a delivery so `drain()` can wait for it.
   *
   * The bookkeeping handler is attached *before* anything `drain()` adds, so by
   * the time an `allSettled` over the set resolves, the settled entries have
   * already been removed — otherwise the drain loop could spin on a set that
   * still looks full. The adapter gets the original promise back untouched.
   */
  #track<T>(work: Promise<T>): Promise<T> {
    const tracked: Promise<void> = work.then(
      () => void this.#inflight.delete(tracked),
      () => void this.#inflight.delete(tracked),
    )
    this.#inflight.add(tracked)
    return work
  }

  async #deliver(
    consumer: LoadedConsumer,
    envelope: MessageEnvelope,
  ): Promise<DeliveryOutcome> {
    const attempt = normalizeAttempt(envelope.attempt)
    // Isolated: a delivery has no session, and resolving a session-lifetime
    // value into the singleton root would leak it into every later delivery.
    const container = this.#options.root.createChild("request", { isolated: true })

    try {
      if (this.#eagerKeys.length > 0) await container.ensure(this.#eagerKeys)

      let payload = envelope.payload
      if (consumer.input) {
        try {
          payload = await consumer.input(payload)
        } catch (err) {
          const failure = asValidationError(err)
          this.#log(consumer, attempt, "reject", failure, true)
          return { action: "reject", reason: failure.message, attempt, error: failure }
        }
      }

      const message: MessageEnvelope = { ...envelope, attempt, payload }
      await consumer.handler(payload, container.ctx, message)
      return { action: "ack" }
    } catch (err) {
      if (isReject(err)) {
        this.#log(consumer, attempt, "reject", err, true)
        return { action: "reject", reason: err.reason, attempt, error: err }
      }
      return this.#failure(consumer, attempt, err)
    } finally {
      await container
        .dispose()
        .catch((err) =>
          this.#options.logger.error(
            `Error disposing delivery scope for "${consumer.name}":`,
            err,
          ),
        )
    }
  }

  #failure(consumer: LoadedConsumer, attempt: number, err: unknown): DeliveryOutcome {
    const attempts = consumer.retry?.attempts ?? 1
    const reason = messageOf(err)

    if (attempts <= 1 || !this.bus(consumer.bus).capabilities.redelivery) {
      this.#log(consumer, attempt, "reject", err)
      return { action: "reject", reason, attempt, error: err }
    }

    if (attempt >= attempts) {
      this.#log(consumer, attempt, "reject", err)
      return {
        action: "reject",
        reason: `Retries exhausted after ${attempts} attempt(s): ${reason}`,
        attempt,
        error: err,
      }
    }

    this.#log(consumer, attempt, "retry", err)
    return {
      action: "retry",
      attempt: attempt + 1,
      delay: computeDelay(attempt, consumer.retry),
      error: err,
    }
  }

  /**
   * `expected` separates control flow from crashes: a `reject()` or a payload
   * that failed validation is a decision the code made on purpose, and printing
   * its stack buries the genuine failures. Anything unexpected keeps the stack.
   */
  #log(
    consumer: LoadedConsumer,
    attempt: number,
    action: "retry" | "reject",
    err: unknown,
    expected = false,
  ): void {
    const prefix =
      `[bus:${consumer.bus}] ${consumer.name} (${consumer.channel} → ` +
      `${consumer.subscription}) attempt ${attempt} ` +
      `${action === "retry" ? "retried" : "rejected"}:`

    if (action === "retry") this.#options.logger.warn(prefix, messageOf(err))
    else if (expected) this.#options.logger.warn(prefix, messageOf(err))
    else this.#options.logger.error(prefix, err)
  }

  #resolveTarget(input: DispatchInput): LoadedConsumer {
    const candidates = this.#options.scan.consumers.filter(
      (consumer) =>
        (input.bus === undefined || consumer.bus === input.bus) &&
        (input.subscription === undefined ||
          consumer.subscription === input.subscription) &&
        channelMatches(consumer.channel, input.channel),
    )

    if (candidates.length === 1) return candidates[0]!

    const target = [
      input.bus ? `bus "${input.bus}"` : null,
      `channel "${input.channel}"`,
      input.subscription ? `subscription "${input.subscription}"` : null,
    ]
      .filter(Boolean)
      .join(", ")

    if (candidates.length === 0) {
      throw new Error(`No consumer matches ${target}.`)
    }
    throw new Error(
      `${candidates.length} consumers match ${target}: ` +
        `${candidates.map((c) => c.name).join(", ")}. ` +
        "Pass `bus` and `subscription` to pick one.",
    )
  }
}

/**
 * Duck-types a bus at boot, so a `bus/` file that default-exports the wrong
 * thing fails while naming itself rather than at first delivery.
 */
function assertBusShape(value: unknown, entry: LoadedBus): void {
  const fail = (detail: string): never => {
    throw new CloveBootError(
      `bus/${entry.name} must resolve to a MessageBus, but ${detail}. It needs ` +
        "`capabilities`, `publish(channel, payload, options)` and " +
        "`subscribe(spec, deliver)`.",
      [entry.file],
    )
  }

  if (typeof value !== "object" || value === null) {
    fail(`it is ${value === null ? "null" : typeof value}`)
  }
  const candidate = value as Partial<MessageBus>
  if (typeof candidate.publish !== "function") fail("it has no publish() method")
  if (typeof candidate.subscribe !== "function") fail("it has no subscribe() method")

  const caps = candidate.capabilities as Record<string, unknown> | undefined
  if (typeof caps !== "object" || caps === null) fail("it declares no capabilities")
  for (const flag of [
    "redelivery",
    "attempts",
    "delayedRetry",
    "patterns",
    "confirms",
  ] as const) {
    if (typeof caps![flag] !== "boolean") {
      fail(`capabilities.${flag} is ${typeof caps![flag]}, not a boolean`)
    }
  }
}

interface Drainable {
  drain(): Promise<void>
}

function isDrainable(value: MessageBus): value is MessageBus & Drainable {
  return typeof (value as Partial<Drainable>).drain === "function"
}

/**
 * A selector matches a concrete channel, or itself when a test dispatches
 * straight to a pattern subscriber.
 */
function channelMatches(selector: string, channel: string): boolean {
  if (selector === channel) return true
  if (!WILDCARD.test(selector)) return false
  return matchSegments(selector.split("."), channel.split("."))
}

function matchSegments(pattern: string[], value: string[]): boolean {
  if (pattern.length === 0) return value.length === 0
  const [head, ...rest] = pattern
  if (head === "#" || head === ">") {
    for (let i = 0; i <= value.length; i++) {
      if (matchSegments(rest, value.slice(i))) return true
    }
    return false
  }
  if (value.length === 0) return false
  if (head !== "*" && head !== value[0]) return false
  return matchSegments(rest, value.slice(1))
}

/** A corrupt counter must not disable the cap, so anything odd reads as 1. */
function normalizeAttempt(attempt: number): number {
  return Number.isInteger(attempt) && attempt >= 1 ? attempt : 1
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}
