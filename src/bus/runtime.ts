import type { Container } from "../container/container.js"
import type { Logger } from "../container/logger.js"
import type { Registry } from "../container/registry.js"
import { CloveBootError } from "../errors.js"
import type { Trigger } from "../types.js"
import { reservedHeadersIn, stampFailures, stripReserved } from "./attempts.js"
import { matchChannel } from "./channel.js"
import { decodeJson, MessageDecodeError } from "./codec.js"
import { isReject } from "./definitions.js"
import { asValidationError, type Validator } from "./schema.js"
import { computeDelay } from "./retry.js"
import type {
  BusSubscription,
  ConsumerHandler,
  DeliveredMessage,
  DeliveryOutcome,
  MessageBus,
  MessageEnvelope,
  Publisher,
  RetryPolicy,
  SubscriptionState,
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
  /** True when `channel` is a selector for the broker to expand. */
  pattern: boolean
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

export const DEFAULT_DRAIN_TIMEOUT = 30_000

export interface DispatchInput {
  /** Required only when the channel is ambiguous across buses. */
  bus?: string
  channel: string
  /** Required only when several consumers share the channel. */
  subscription?: string
  payload: unknown
  /**
   * Simulate a redelivery by stating how many times the handler has already
   * failed. Defaults to 0, a first delivery.
   */
  failures?: number
  headers?: Record<string, string>
  id?: string
  key?: string
}

/** What one subscription's driver loop is reporting. */
export interface SubscriptionHealth {
  bus: string
  consumer: string
  channel: string
  subscription: string
  state: SubscriptionState
  detail?: string
  /** When the state last changed. */
  since: Date
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
  #health = new Map<string, SubscriptionHealth>()
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
    const { scan, root, registry } = this.#options
    // A delivery opens a request scope of its own, so every eager
    // `request`-lifetime `di/` value fires per delivery too.
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
      const at = [consumer.file, busFile]
      const fail = (message: string): never => {
        throw new CloveBootError(
          `Consumer "${consumer.name}" ${message}`,
          at,
        )
      }

      if (attempts > 1 && caps.retries === "none") {
        fail(
          `declares retry({ attempts: ${attempts} }), but bus ` +
            `"${consumer.bus}" advertises retries: "none" — an un-acked ` +
            "message never comes back, so retrying cannot happen. Drop the " +
            "retry() call, or bind this consumer to a bus that redelivers.",
        )
      }
      if ((consumer.retry?.backoff?.base ?? 0) > 0 && caps.retries !== "delayed") {
        fail(
          `declares a retry backoff, but bus "${consumer.bus}" advertises ` +
            `retries: "${caps.retries}" — the delay would be silently dropped ` +
            "and redeliveries would spin at broker speed. Drop the backoff, or " +
            'give the adapter a delay mechanism and advertise "delayed".',
        )
      }
      if (consumer.pattern && !caps.patterns) {
        fail(
          `subscribes to the pattern "${consumer.channel}", but bus ` +
            `"${consumer.bus}" advertises patterns: false. Subscribe to a ` +
            "concrete channel instead.",
        )
      }
    }
  }

  /**
   * What each subscription's driver loop is doing, for a readiness probe.
   *
   * The adapter owns the loop, so core cannot tell a healthy subscription from
   * one whose connection dropped and never came back. Adapters report state
   * through the hooks passed to `subscribe()`; anything that never reports reads
   * as `consuming` until it is closed.
   */
  health(): SubscriptionHealth[] {
    return [...this.#health.values()]
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
      publish: (channel, payload, options) => {
        // Control metadata and user headers share one map on every broker, so a
        // producer setting `x-clove-attempt` would hand the consumer a failure
        // count it never earned — spending its whole retry budget on the first
        // delivery. Always a bug, so it fails loudly at the call site.
        const reserved = reservedHeadersIn(options?.headers)
        if (reserved.length > 0) {
          throw new Error(
            `Cannot publish to "${channel}" with reserved header(s) ` +
              `${reserved.join(", ")}: the "x-clove-" prefix belongs to the ` +
              "framework's own delivery bookkeeping. Rename them.",
          )
        }
        return this.bus(name).publish(channel, payload, options)
      },
    }
  }

  /** Subscribes every consumer. Idempotent. */
  async start(): Promise<void> {
    if (this.#started || this.#closed) return
    this.#started = true

    for (const consumer of this.#options.scan.consumers) {
      const bus = this.bus(consumer.bus)
      const id = `${consumer.bus}\0${consumer.name}`
      this.#health.set(id, {
        bus: consumer.bus,
        consumer: consumer.name,
        channel: consumer.channel,
        subscription: consumer.subscription,
        state: "consuming",
        since: new Date(),
      })

      const subscription = await bus.subscribe(
        {
          channel: consumer.channel,
          pattern: consumer.pattern,
          subscription: consumer.subscription,
          maxInFlight: consumer.maxInFlight,
        },
        (message) => this.#track(this.#deliver(consumer, message)),
        {
          report: (state, detail) => {
            const previous = this.#health.get(id)
            if (previous?.state === state) return
            this.#health.set(id, {
              ...this.#health.get(id)!,
              state,
              ...(detail ? { detail } : {}),
              since: new Date(),
            })
            const note = `[bus:${consumer.bus}] ${consumer.name} is ${state}`
            if (state === "consuming") this.#options.logger.info(note)
            else this.#options.logger.warn(detail ? `${note}: ${detail}` : note)
          },
        },
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
      failures: input.failures ?? 0,
      ...(input.headers ? { headers: input.headers } : {}),
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
    for (const [id, entry] of this.#health) {
      this.#health.set(id, { ...entry, state: "stopped", since: new Date() })
    }

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
    incoming: DeliveredMessage,
  ): Promise<DeliveryOutcome> {
    const failures = normalizeFailures(incoming.failures)
    const attempt = failures + 1
    // Reserved keys never reach a handler: `x-clove-attempt` is Clove's
    // bookkeeping, not a header the producer set, and leaking it would invite
    // code to read or forward it.
    const headers = Object.freeze(stripReserved(incoming.headers))

    // A delivery is one unit of work, so it opens a request scope of its own —
    // isolated, because it has no session, and resolving a session-lifetime
    // value into the singleton root would cache one delivery's state for the
    // life of the process.
    const trigger: Trigger = {
      kind: "delivery",
      bus: consumer.bus,
      channel: incoming.channel,
      subscription: consumer.subscription,
      consumer: consumer.name,
    }
    const container = this.#options.root.createChild("request", {
      isolated: true,
      trigger,
    })

    try {
      if (this.#eagerKeys.length > 0) await container.ensure(this.#eagerKeys)

      let payload: unknown
      try {
        payload = this.#decode(consumer, incoming)
      } catch (err) {
        // Undecodable bytes will not decode on the next delivery either, so the
        // verdict is terminal — the same reasoning, and the same outcome, as a
        // payload that fails validation. Doing this in the adapter instead is
        // what leaves a message un-acked and looping forever.
        const failure =
          err instanceof MessageDecodeError
            ? err
            : new MessageDecodeError(messageOf(err), { cause: err })
        const reason = `Payload failed to decode: ${failure.message}`
        this.#log(consumer, attempt, "reject", failure, true)
        return { action: "reject", reason, failures, error: failure }
      }

      if (consumer.input) {
        try {
          payload = await consumer.input(payload)
        } catch (err) {
          const failure = asValidationError(err)
          this.#log(consumer, attempt, "reject", failure, true)
          return {
            action: "reject",
            reason: failure.message,
            failures,
            error: failure,
          }
        }
      }

      const message: MessageEnvelope = {
        channel: incoming.channel,
        subscription: consumer.subscription,
        payload,
        failures,
        attempt,
        headers,
        ...(incoming.id !== undefined ? { id: incoming.id } : {}),
        ...(incoming.key !== undefined ? { key: incoming.key } : {}),
        ...(incoming.timestamp !== undefined ? { timestamp: incoming.timestamp } : {}),
      }
      await consumer.handler(payload, container.ctx, message)
      return { action: "ack" }
    } catch (err) {
      if (isReject(err)) {
        this.#log(consumer, attempt, "reject", err, true)
        return { action: "reject", reason: err.reason, failures, error: err }
      }
      return this.#failure(consumer, { failures, headers: incoming.headers }, err)
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

  /** Bytes when the adapter passed them, otherwise whatever it decoded itself. */
  #decode(consumer: LoadedConsumer, incoming: DeliveredMessage): unknown {
    if (incoming.body === undefined) return incoming.payload
    const bus = this.bus(consumer.bus)
    const decode = bus.decode?.bind(bus) ?? decodeJson
    const { payload: _ignored, ...meta } = incoming
    return decode(incoming.body, meta)
  }

  #failure(
    consumer: LoadedConsumer,
    state: { failures: number; headers: Record<string, string> | undefined },
    err: unknown,
  ): DeliveryOutcome {
    const attempts = consumer.retry?.attempts ?? 1
    const reason = messageOf(err)
    // The failure that just happened is now part of the count.
    const failures = state.failures + 1
    const attempt = state.failures + 1

    if (attempts <= 1 || this.bus(consumer.bus).capabilities.retries === "none") {
      this.#log(consumer, attempt, "reject", err)
      return { action: "reject", reason, failures, error: err }
    }

    if (failures >= attempts) {
      this.#log(consumer, attempt, "reject", err)
      return {
        action: "reject",
        reason: `Retries exhausted after ${attempts} attempt(s): ${reason}`,
        failures,
        error: err,
      }
    }

    this.#log(consumer, attempt, "retry", err)
    return {
      action: "retry",
      // Named so an adapter cannot mistake a retry for a re-publish: sending the
      // message back to the exchange or topic would re-route it to every other
      // subscription bound there, duplicating work in this consumer's siblings.
      subscription: consumer.subscription,
      delay: computeDelay(attempt, consumer.retry),
      // Stamped by core rather than by each adapter, so the counter cannot be
      // lost by an adapter that forgot to increment it — the failure mode that
      // makes a retry cap silently stop capping.
      headers: stampFailures(stripReserved(state.headers), failures),
      failures,
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
        // A literal must match exactly; a selector is expanded, so that a test
        // can dispatch a concrete channel to a pattern subscriber.
        (consumer.pattern
          ? matchChannel(consumer.channel, input.channel)
          : consumer.channel === input.channel),
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
  const retries = caps!.retries
  if (retries !== "none" && retries !== "immediate" && retries !== "delayed") {
    fail(
      `capabilities.retries is ${JSON.stringify(retries)}, not one of ` +
        '"none", "immediate" or "delayed"',
    )
  }
  if (typeof caps!.patterns !== "boolean") {
    fail(`capabilities.patterns is ${typeof caps!.patterns}, not a boolean`)
  }
}

interface Drainable {
  drain(): Promise<void>
}

function isDrainable(value: MessageBus): value is MessageBus & Drainable {
  return typeof (value as Partial<Drainable>).drain === "function"
}

/**
 * A corrupt counter must not disable the cap, so anything odd reads as zero.
 *
 * The direction is deliberate: a garbled count that read as a huge number would
 * reject a healthy message on its first try, whereas reading it as a first
 * delivery costs at most a few extra attempts.
 */
function normalizeFailures(value: number | undefined): number {
  if (value === undefined) return 0
  return Number.isInteger(value) && value >= 0 ? value : 0
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
