import { KIND } from "../types.js"
import {
  RETRY,
  type BusDefinition,
  type BusFactory,
  type ConsumeSpecWithInput,
  type ConsumeSpecWithoutInput,
  type ConsumerDefinition,
  type MessageBus,
  type MessageSchema,
  type RetryPolicy,
} from "./types.js"

/**
 * Registers one message bus — one connection to one broker.
 *
 * Lives in `bus/`, one file per connection, and the filename becomes the name
 * the rest of the project addresses it by: `bus/events.ts` is `ctx.bus.events`
 * and `consume({ bus: "events" })`.
 *
 * Clove ships no broker client. The value is whatever object satisfies
 * {@link MessageBus}, written in your own code against your own SDK. Pass a
 * factory — `(ctx, hooks)`, exactly like `di()` — when the connection needs
 * dependency injection or a teardown hook.
 *
 * ```ts
 * // src/bus/events.ts
 * import { bus } from "clovejs/bus"
 *
 * export default bus(async (ctx, { onDestroy }) => {
 *   const conn = await amqplib.connect(ctx.config.amqpUrl)
 *   onDestroy(() => conn.close())
 *   return { capabilities: {...}, publish, subscribe }
 * })
 * ```
 */
export function bus(source: MessageBus | BusFactory): BusDefinition {
  return {
    [KIND]: "bus",
    bus: source,
    isFactory: typeof source === "function",
  }
}

/**
 * Declares a consumer — a handler for one channel on one bus.
 *
 * Unlike routes and MCP tools, nothing here is derived from the file path. A
 * channel is a contract shared with the producer, and one channel usually has
 * several independent consumers, so both `channel` and `subscription` are
 * written out. The file path only names the consumer in logs and boot errors.
 *
 * ```ts
 * // src/consumers/billing/orderCreated.ts
 * export default consume({
 *   bus: "events",
 *   channel: "orders.created",
 *   subscription: "billing",
 *   input: z.object({ orderId: z.string(), total: z.number() }),
 *   async handler({ orderId, total }, ctx) {
 *     await ctx.invoices.createForOrder(orderId, total)
 *   },
 * }).retry({ attempts: 5 })
 * ```
 *
 * Without `input`, name the payload type instead — `consume<OrderCreated>({...})`
 * — and no schema library is needed at all. The payload is then typed by
 * assertion rather than checked, which is the same trade a handler makes when
 * it reads `req.body`.
 */
export function consume<S extends MessageSchema>(
  spec: ConsumeSpecWithInput<S>,
): ConsumerDefinition
export function consume<Payload = unknown>(
  spec: ConsumeSpecWithoutInput<Payload>,
): ConsumerDefinition
/**
 * Two overloads rather than one signature with an optional schema parameter,
 * and the reason is a TypeScript inference rule worth not rediscovering.
 *
 * A single `consume<Payload = unknown, S extends MessageSchema | undefined =
 * undefined>` needs that `= undefined` default, so that `consume<Order>({...})`
 * can supply only the first type argument. But method shorthand in an object
 * literal is context-sensitive — the method has an implicit `this` — so an
 * `input` written as `{ parse(v: unknown): Order {...} }` is deferred to a later
 * inference pass, and type parameters with no candidate are fixed to their
 * defaults before it runs. `S` became `undefined`, and the schema was then
 * checked against `undefined`: "Type '{ parse… }' is not assignable to type
 * 'undefined'". The arrow-property spelling of the same validator inferred
 * fine, which is not a distinction anyone should have to know about.
 *
 * Splitting the signature lets the schema overload drop the default entirely.
 */
export function consume(
  spec: ConsumeSpecWithInput<MessageSchema> | ConsumeSpecWithoutInput<unknown>,
): ConsumerDefinition {
  const def: ConsumerDefinition = {
    [KIND]: "consumer",
    [RETRY]: null,
    bus: spec.bus,
    channel: spec.channel,
    subscription: spec.subscription,
    input: (spec.input ?? null) as MessageSchema | null,
    maxInFlight: spec.maxInFlight ?? null,
    handler: spec.handler as ConsumerDefinition["handler"],
    retry(policy: RetryPolicy) {
      def[RETRY] = policy
      return def
    },
  }
  return def
}

/**
 * Brands rejection signals so they survive across module copies, the way
 * `HTTP_ERROR` does for `HttpError`.
 */
export const REJECT = Symbol.for("clovejs.reject")

/**
 * Thrown by {@link reject} to end a delivery without retrying.
 */
export class RejectSignal extends Error {
  readonly reason: string;
  readonly [REJECT] = true

  constructor(reason: string) {
    super(reason)
    this.name = "RejectSignal"
    this.reason = reason
  }
}

/**
 * Rejects the message outright, skipping any remaining retries.
 *
 * For failures that a redelivery cannot fix — an unknown discriminator, a
 * tenant that no longer exists, a payload the handler will never accept. Throw
 * it, in the style of the existing `error()` helper:
 *
 * ```ts
 * if (!tenant) throw reject(`unknown tenant ${payload.tenantId}`)
 * ```
 */
export function reject(reason: string): RejectSignal {
  return new RejectSignal(reason)
}

export function isReject(value: unknown): value is RejectSignal {
  return (
    value instanceof RejectSignal ||
    (typeof value === "object" &&
      value !== null &&
      (value as Record<PropertyKey, unknown>)[REJECT] === true)
  )
}
