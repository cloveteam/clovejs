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
 * alongside `z.object({...})` and the plain `{ id: z.string() }` shape.
 */
export type MessageSchema<Output = unknown> =
  | SchemaLike<Output>
  | StandardSchemaLike<Output>
  | Record<string, SchemaLike>

/** Infers the payload type a handler receives from its declared schema. */
export type InferPayload<S> =
  S extends StandardSchemaLike<infer O>
    ? O
    : S extends SchemaLike<infer O>
      ? O
      : S extends Record<string, SchemaLike>
        ? { [K in keyof S]: S[K] extends SchemaLike<infer O> ? O : never }
        : unknown

/** One message as a consumer sees it. Never a native broker message. */
export interface MessageEnvelope<T = unknown> {
  /** The concrete channel the producer published to. Never a pattern. */
  channel: string
  subscription: string
  payload: T
  /**
   * 1 on first delivery, incrementing on each redelivery. Accurate whenever the
   * bus advertises `attempts`; see {@link readAttempt}.
   */
  attempt: number
  /** UTF-8 decoded. Adapters drop values they cannot decode. */
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
  /**
   * The selector. May contain broker wildcards only when the bus advertises
   * `patterns`; otherwise core rejects it at boot.
   */
  channel: string
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
  /** `attempt` is the number the *next* delivery must report. */
  | { action: "retry"; attempt: number; delay: number; error: unknown }
  | { action: "reject"; reason: string; attempt: number; error?: unknown }

/**
 * What a bus can actually do. Every field is required: an adapter author has to
 * answer all five, and core turns each "no" into a boot error rather than a
 * runtime surprise.
 */
export interface BusCapabilities {
  /** An un-acked message comes back at all. False for Redis Pub/Sub. */
  redelivery: boolean
  /** `envelope.attempt` is accurate across redeliveries. Implies `redelivery`. */
  attempts: boolean
  /** `outcome.delay` is honored. */
  delayedRetry: boolean
  /** `SubscriptionSpec.channel` may contain wildcards. */
  patterns: boolean
  /** `publish()` resolves only after the broker has accepted the message. */
  confirms: boolean
}

/** The publish half of a bus, which is all `ctx.bus.<name>` exposes. */
export interface Publisher {
  publish<T>(channel: string, payload: T, options?: PublishOptions): Promise<void>
}

export interface BusSubscription {
  close(): Promise<void>
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
  subscribe(
    spec: SubscriptionSpec,
    deliver: (message: MessageEnvelope) => Promise<DeliveryOutcome>,
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

/** Exponential backoff between redeliveries. Requires `delayedRetry`. */
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
  /** Total deliveries, including the first. `1` disables retrying. */
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
   */
  channel: string
  /**
   * The durable subscriber identity — a Rabbit queue, a Kafka consumer group.
   * Never derived: renaming one silently replays a topic from the beginning.
   */
  subscription: string
  /** Concurrent deliveries. Defaults to 1; raising it forfeits ordering. */
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

/**
 * Either form of consumer spec.
 *
 * An alias over the two interfaces the overloads of `consume()` accept, kept
 * because it is part of the public surface. Prefer naming the specific one.
 */
export type ConsumeSpec<
  S extends MessageSchema | undefined = undefined,
  Payload = unknown,
> = S extends MessageSchema
  ? ConsumeSpecWithInput<S>
  : ConsumeSpecWithoutInput<Payload>

export const RETRY = Symbol.for("clovejs.retry")

export interface ConsumerDefinition extends Definition<"consumer"> {
  bus: string
  channel: string
  subscription: string
  input: MessageSchema | null
  maxInFlight: number | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: ConsumerHandler<any>
  [RETRY]: RetryPolicy | null
  /** Redeliver on failure, up to `attempts` total. Chainable, like `.meta()`. */
  retry(policy: RetryPolicy): ConsumerDefinition
}
