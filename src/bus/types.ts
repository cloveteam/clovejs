import type {
  BusRegistry,
  Definition,
  LifecycleHooks,
  RuntimeCtx,
} from "../types.js"

/**
 * The subset of a validation library this module relies on.
 *
 * Typed structurally rather than imported, so a project that never declares a
 * consumer `input` needs no schema library installed. The twin of these types
 * lives in `src/mcp/types.ts`; they are deliberately duplicated rather than
 * shared, so that `clovejs/bus` and `clovejs/mcp` stay independent modules.
 */
export interface SchemaLike<Output = unknown> {
  readonly _output?: Output
  parse(value: unknown): Output
}

/** An issue reported by a Standard Schema validator. */
export interface StandardIssue {
  readonly message: string
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>
}

export type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<StandardIssue> }

/**
 * A [Standard Schema](https://standardschema.dev) validator — the shape zod 4,
 * valibot and arktype all expose, so any of them works as a consumer `input`.
 */
export interface StandardSchemaLike<Output = unknown> {
  readonly "~standard": {
    readonly version: number
    validate(
      value: unknown,
    ): StandardResult<Output> | Promise<StandardResult<Output>>
  }
}

/**
 * What a consumer accepts as `input`.
 *
 * Unlike an MCP tool — whose arguments are always named — a message payload can
 * legitimately be a scalar or an array, so a bare `z.array(...)` is allowed
 * alongside `z.object({...})`.
 */
export type MessageSchema<Output = unknown> =
  | SchemaLike<Output>
  | StandardSchemaLike<Output>

/** Infers the payload type a handler receives from its declared schema. */
export type InferPayload<S> =
  S extends StandardSchemaLike<infer O>
    ? O
    : S extends SchemaLike<infer O>
      ? O
      : unknown

/** Brands a channel selector, so a pattern is never inferred from punctuation. */
export const PATTERN = Symbol.for("clovejs.pattern")

/**
 * A channel selector the broker expands, as produced by {@link pattern}.
 *
 * Wrapping is required because sniffing for `*`, `#` and `>` is wrong in both
 * directions: it promotes a literal channel that happens to contain one of them
 * into a subscription to far more than was meant, and it can never be certain
 * the other way either. A plain string is always a literal channel.
 */
export interface ChannelPattern {
  readonly [PATTERN]: "pattern" | "literal"
  readonly selector: string
}

/**
 * Marks a channel as a selector for the broker to expand.
 *
 * The syntax is the broker's, not Clove's — the string is passed to
 * `subscribe()` verbatim. In the AMQP and NATS conventions that `memoryBus()`
 * and most adapters follow, `*` matches one dot-separated segment and `#`
 * matches zero or more.
 *
 * ```ts
 * consume({ bus: "events", channel: pattern("orders.#"), subscription: "analytics" })
 * ```
 */
export function pattern(selector: string): ChannelPattern {
  return { [PATTERN]: "pattern", selector }
}

/**
 * Marks a channel as a literal, for the rare literal containing `*`, `#` or `>`.
 *
 * Only needed to silence the boot error that a bare string with wildcard
 * punctuation raises, which exists so that neither reading is ever a guess.
 */
export function literal(selector: string): ChannelPattern {
  return { [PATTERN]: "literal", selector }
}

export type ChannelSelector = string | ChannelPattern

export function isChannelPattern(value: unknown): value is ChannelPattern {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<PropertyKey, unknown>)[PATTERN] === "string"
  )
}

/** What an adapter passes to `deliver()`. */
export interface DeliveredMessage {
  /** The concrete channel the producer published to. Never the selector. */
  channel: string
  subscription: string
  /**
   * The decoded payload. Pass `body` instead to let core decode, which is the
   * only way a malformed message reaches a `reject` verdict rather than
   * throwing inside the adapter's own callback and never being acked at all.
   */
  payload?: unknown
  /** Raw bytes, decoded inside the delivery path by {@link MessageBus.decode}. */
  body?: Uint8Array
  /**
   * How many times a handler has already run and failed on this message. Read
   * it with {@link readFailures}; omit it on a bus that cannot carry a counter.
   */
  failures?: number
  /** User headers. Reserved `x-clove-*` keys are stripped before the handler. */
  headers?: Record<string, string>
  id?: string
  key?: string
  timestamp?: Date
}

/** One message as a consumer sees it. Never a native broker message. */
export interface MessageEnvelope<T = unknown> {
  /** The concrete channel the producer published to. Never a pattern. */
  channel: string
  subscription: string
  payload: T
  /** Times a handler has already run and failed. 0 on a first delivery. */
  failures: number
  /**
   * `failures + 1` — which run of the handler this is, and the number
   * `retry({ attempts })` is compared against. Derived, and provided because it
   * is what a log line wants.
   */
  attempt: number
  /** UTF-8 decoded, with reserved `x-clove-*` keys removed. */
  headers: Readonly<Record<string, string>>
  id?: string
  key?: string
  timestamp?: Date
}

export interface PublishOptions {
  /** Broker-level message id, when the adapter supports one. */
  id?: string
  /** Partition / ordering key, for brokers that have one. */
  key?: string
  headers?: Record<string, string>
}

/** What core asks a bus to subscribe to. */
export interface SubscriptionSpec {
  /** The channel, literal or selector according to `pattern`. */
  channel: string
  /**
   * True when `channel` is a selector the broker must expand. Declared by the
   * consumer via {@link pattern}, never inferred, and only ever true on a bus
   * that advertises `patterns`.
   */
  pattern: boolean
  subscription: string
  /** Concurrent deliveries. Always set by core; defaults to 1. */
  maxInFlight: number
}

/**
 * What core hands back for each delivery. The adapter translates it into
 * whatever its broker calls the same thing.
 */
export type DeliveryOutcome =
  | { action: "ack" }
  | {
      action: "retry"
      /**
       * The one subscription that may see this message again.
       *
       * A retry is a redelivery to a single subscriber, never a re-publish to
       * the channel: republishing to an exchange or topic re-routes the message
       * to every *other* subscription bound to it as well, so one consumer's
       * retry silently duplicates work in its siblings.
       */
      subscription: string
      /** Milliseconds to wait first. Core computes it; the adapter waits it. */
      delay: number
      /**
       * The headers to attach to the redelivered message, with the failure
       * counter already stamped. Write these verbatim.
       */
      headers: Record<string, string>
      /** Failures including the one that just happened. */
      failures: number
      error: unknown
    }
  | {
      action: "reject"
      reason: string
      /** Failures including the one that just happened. */
      failures: number
      error?: unknown
    }

/**
 * How much of a retry this bus can actually perform.
 *
 * One question rather than three, because the three answers were never
 * independent. Carrying the failure counter is not a separate capability: core
 * stamps it onto `outcome.headers`, so any adapter that redelivers the message
 * core handed back carries it for free — and one that drops the headers instead
 * (a bare `nack(requeue)`) is a bug, not a transport limit.
 */
export type RetrySupport =
  /** An un-acked message never comes back. Redis Pub/Sub. */
  | "none"
  /** It comes back carrying `outcome.headers`, but `outcome.delay` is ignored. */
  | "immediate"
  /** It comes back, and the adapter honors `outcome.delay`. */
  | "delayed"

/**
 * What a bus can actually do. Both fields are required: an adapter author has to
 * answer them, and core turns each "no" into a boot error rather than a runtime
 * surprise.
 *
 * Deliberately short. A capability earns its place only if core changes what it
 * does based on the answer — everything else is a property of the topology, and
 * belongs in the adapter that sets the topology up.
 */
export interface BusCapabilities {
  /** Whether an un-acked message comes back, and whether a delay is honored. */
  retries: RetrySupport
  /** `SubscriptionSpec.channel` may be a selector when `spec.pattern` is set. */
  patterns: boolean
}

/** The publish half of a bus, which is all `ctx.bus.<name>` exposes. */
export interface Publisher {
  publish<T>(channel: string, payload: T, options?: PublishOptions): Promise<void>
}

export interface BusSubscription {
  close(): Promise<void>
}

/** How a subscription's driver loop is doing, as the adapter reports it. */
export type SubscriptionState = "consuming" | "reconnecting" | "stopped"

/**
 * The reporting side of a subscription, handed to `subscribe()`.
 *
 * The adapter owns the driver loop, which means core cannot tell a healthy
 * subscription from one whose connection dropped and never came back. Rather
 * than poll — which would need broker knowledge core does not have — the
 * adapter pushes state transitions here, and core exposes the result through
 * `app.bus.health()` for a readiness probe.
 *
 * Always passed, so an adapter can destructure it — `subscribe(spec, deliver,
 * { report })`. An adapter that never calls `report` reads as `consuming` until
 * it is closed.
 */
export interface SubscriptionHooks {
  /** Report a state change. */
  report(state: SubscriptionState, detail?: string): void
}

/**
 * The transport port. One implementation per connection, written in the
 * application and registered from a file in `bus/`.
 *
 * The adapter owns the driver loop: core never polls and never acknowledges. It
 * hands over a `deliver` callback and translates whatever comes back.
 */
export interface MessageBus extends Publisher {
  readonly capabilities: BusCapabilities
  /**
   * Bytes to value. Optional; core uses JSON when a bus does not define it.
   *
   * Decoding belongs inside the delivery path rather than in the adapter's
   * consume callback, because a message that cannot be decoded needs a verdict:
   * done in the adapter it throws where nothing can ack, and the broker
   * redelivers the same unparseable bytes forever.
   */
  decode?(body: Uint8Array, message: Omit<DeliveredMessage, "payload">): unknown
  subscribe(
    spec: SubscriptionSpec,
    deliver: (message: DeliveredMessage) => Promise<DeliveryOutcome>,
    hooks: SubscriptionHooks,
  ): Promise<BusSubscription>
}

export type BusFactory = (
  ctx: RuntimeCtx,
  hooks: LifecycleHooks,
) => MessageBus | Promise<MessageBus>

export interface BusDefinition extends Definition<"bus"> {
  bus: MessageBus | BusFactory
  /** True when the bus was supplied as a factory function. */
  isFactory: boolean
}

/** Exponential backoff between redeliveries. Requires `retries: "delayed"`. */
export interface BackoffPolicy {
  /** Delay before the second attempt, in milliseconds. */
  base: number
  /** Multiplier applied per attempt. Defaults to 2. */
  factor?: number
  /** Upper bound on any single delay. Defaults to 30s. */
  max?: number
  /** Spread delays to avoid a thundering herd. Defaults to true. */
  jitter?: boolean
}

export interface RetryPolicy {
  /**
   * Total *handler runs*, including the first. `1` disables retrying.
   *
   * This caps handler failures. A delivery lost to a crash or a drain timeout
   * never ran the handler to a verdict, so it does not spend the budget —
   * bounding those is the broker's job, via a redrive policy or a max-delivery
   * setting on the queue itself.
   */
  attempts: number
  backoff?: BackoffPolicy
}

export type ConsumerHandler<Payload> = (
  payload: Payload,
  ctx: RuntimeCtx,
  message: MessageEnvelope<Payload>,
) => unknown | Promise<unknown>

/**
 * The names of the buses this project defines.
 *
 * Resolves to the keys of the generated `BusRegistry`, so `bus: "typo"` is a
 * type error. Falls back to `string` before codegen has run.
 */
export type BusName = keyof BusRegistry extends never
  ? string
  : keyof BusRegistry & string

/** What every consumer declares, whether or not it validates its payload. */
export interface ConsumeSpecBase {
  /** Which bus in `bus/` this consumer binds to. */
  bus: BusName
  /**
   * The channel to subscribe to. Explicit rather than derived from the file
   * path: a channel is a contract shared with the producer, and one channel
   * commonly has several independent consumers.
   *
   * A plain string is a literal channel; wrap it in {@link pattern} for a
   * selector the broker expands.
   */
  channel: ChannelSelector
  /**
   * The durable subscriber identity — a Rabbit queue, a Kafka consumer group.
   * Never derived: renaming one silently replays a topic from the beginning.
   */
  subscription: string
  /**
   * Concurrent deliveries within one process. Defaults to 1.
   *
   * This is a concurrency limit, not an ordering guarantee — a second replica
   * has its own, so ordering is a property of the broker topology rather than
   * of this number.
   */
  maxInFlight?: number
}

/**
 * A consumer that validates. The handler's payload type is inferred from
 * `input`, so `consume({ input: z.object(...) })` takes no type argument.
 */
export interface ConsumeSpecWithInput<S extends MessageSchema>
  extends ConsumeSpecBase {
  /** Runtime payload validation. Omit it and use `consume<T>({...})` instead. */
  input: S
  handler: ConsumerHandler<InferPayload<S>>
}

/**
 * A consumer that does not validate. The payload type is asserted by the caller
 * as `consume<Payload>({...})`, the same trade a handler makes reading
 * `req.body`.
 */
export interface ConsumeSpecWithoutInput<Payload> extends ConsumeSpecBase {
  input?: undefined
  handler: ConsumerHandler<Payload>
}

export const RETRY = Symbol.for("clovejs.retry")

export interface ConsumerDefinition extends Definition<"consumer"> {
  bus: string
  channel: ChannelSelector
  subscription: string
  input: MessageSchema | null
  maxInFlight: number | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: ConsumerHandler<any>
  [RETRY]: RetryPolicy | null
  /** Redeliver on failure, up to `attempts` total. Chainable, like `.meta()`. */
  retry(policy: RetryPolicy): ConsumerDefinition
}
