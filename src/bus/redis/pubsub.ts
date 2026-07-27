/**
 * A fire-and-forget bus over Redis Pub/Sub.
 *
 * The interesting case, because of what it cannot do: a message goes to every
 * live subscriber and is then forgotten. Nothing is acknowledged, nothing is
 * redelivered, and a subscriber that was offline never sees it. Declaring
 * `retries: "none"` is what lets CloveJS refuse, at boot, to let a consumer
 * here ask for a retry — a promise this transport cannot keep.
 */

import { CloveBootError } from "../../errors.js"
import { encodeJson } from "../codec.js"
import type {
  BusFactory,
  BusSubscription,
  DeliveredMessage,
  MessageBus,
} from "../types.js"
import {
  closeConnection,
  commandRunner,
  connect,
  invoke,
  isConnectionOptions,
  openConnection,
  type RedisConnectionOptions,
  type RedisLike,
} from "./client.js"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export interface RedisPubSubOptions {
  /** Prepended to every channel name. Namespaces one Redis across apps. */
  prefix?: string
  /**
   * Wrap each message as `{"d":payload,"h":headers}` so headers survive.
   *
   * Off by default: Redis Pub/Sub has no header frame, and the bare payload is
   * what a producer outside this app publishes and expects to read. Turning it
   * on changes the wire format, so both ends have to agree.
   */
  envelope?: boolean
}

/**
 * A message bus backed by Redis Pub/Sub.
 *
 * ```ts
 * // src/bus/presence.ts
 * import { bus } from "clovejs/bus"
 * import { redisPubSub } from "clovejs/bus/redis"
 *
 * export default bus(redisPubSub({ url: process.env.REDIS_URL! }))
 * ```
 *
 * For work that must not be lost, use {@link redisStreams} instead — the two
 * are ordinary sibling files in `bus/`, and a project commonly has both.
 */
export function redisPubSub(
  client: RedisLike,
  options?: RedisPubSubOptions,
): MessageBus
export function redisPubSub(
  connection: RedisConnectionOptions,
  options?: RedisPubSubOptions,
): BusFactory
export function redisPubSub(
  source: RedisLike | RedisConnectionOptions,
  options: RedisPubSubOptions = {},
): MessageBus | BusFactory {
  if (isConnectionOptions(source)) {
    return async (_ctx, { onDestroy }) => {
      const client = await connect(source)
      onDestroy(() => closeConnection(client))
      return build(client, options)
    }
  }
  return build(source, options)
}

function build(client: RedisLike, options: RedisPubSubOptions): MessageBus {
  const command = commandRunner(client)
  const prefix = options.prefix ?? ""
  const envelope = options.envelope === true

  return {
    capabilities: {
      // Nothing is acknowledged, so an un-acked message is simply gone.
      retries: "none",
      // `PSUBSCRIBE`, in glob syntax rather than AMQP's — see assertGlob.
      patterns: true,
    },

    async publish(channel, payload, publishOptions) {
      const headers = publishOptions?.headers
      if (headers && Object.keys(headers).length > 0 && !envelope) {
        throw new Error(
          `Cannot publish to "${channel}" with headers: Redis Pub/Sub has no ` +
            "header frame, so they would be silently dropped. Pass " +
            "`redisPubSub(client, { envelope: true })` to wrap each message in " +
            "one that carries them, or move the values into the payload.",
        )
      }

      const body = envelope
        ? JSON.stringify({ d: payload ?? null, ...(headers ? { h: headers } : {}) })
        : decoder.decode(encodeJson(payload))
      await command(["PUBLISH", prefix + channel, body])
    },

    async subscribe(spec, deliver, { report }) {
      if (spec.pattern) assertGlob(spec.channel, spec.subscription)

      // A connection in subscriber mode accepts nothing but (un)subscribes, so
      // it cannot be the one the app publishes on.
      const connection = await openConnection(client)
      let closed = false
      let active = 0
      const queue: Array<() => void> = []

      /** Honors `maxInFlight` even though nothing here can apply backpressure. */
      function run(work: () => Promise<void>): void {
        const launch = (): void => {
          active += 1
          void work().finally(() => {
            active -= 1
            queue.shift()?.()
          })
        }
        if (active < spec.maxInFlight) launch()
        else queue.push(launch)
      }

      function onMessage(channel: string, message: string): void {
        if (closed) return
        run(async () => {
          // The outcome is discarded: there is no ack, and a retry cannot
          // happen — which is exactly what `retries: "none"` promised.
          await deliver(decodeMessage(channel.slice(prefix.length), spec.subscription, message, envelope))
        })
      }

      await listen(connection, spec.channel, spec.pattern, prefix, onMessage)
      report("consuming")

      const subscription: BusSubscription = {
        async close() {
          closed = true
          queue.length = 0
          await closeConnection(connection)
          report("stopped")
        },
      }
      return subscription
    },
  }
}

/**
 * Turns one pushed message into a delivery.
 *
 * An envelope that will not parse is handed over as-is rather than dropped, so
 * core reaches the same `Payload failed to decode` verdict — and logs it — that
 * a malformed payload gets on any other bus.
 */
function decodeMessage(
  channel: string,
  subscription: string,
  message: string,
  envelope: boolean,
): DeliveredMessage {
  const base = { channel, subscription, timestamp: new Date() }
  if (!envelope) return { ...base, body: encoder.encode(message), headers: {} }

  try {
    const parsed = JSON.parse(message) as { d?: unknown; h?: unknown }
    if (typeof parsed !== "object" || parsed === null || !("d" in parsed)) {
      throw new Error("not an envelope")
    }
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(
      (parsed.h ?? {}) as Record<string, unknown>,
    )) {
      if (typeof value === "string") headers[name] = value
    }
    return {
      ...base,
      body: encoder.encode(JSON.stringify(parsed.d ?? null)),
      headers,
    }
  } catch {
    return { ...base, body: encoder.encode(message), headers: {} }
  }
}

/** Whichever of the two clients' subscribe APIs this connection speaks. */
async function listen(
  connection: RedisLike,
  channel: string,
  pattern: boolean,
  prefix: string,
  onMessage: (channel: string, message: string) => void,
): Promise<void> {
  const selector = prefix + channel

  // node-redis, identified by its camelCase pattern method, takes the listener
  // per subscription and calls it with the message first.
  if (typeof connection.pSubscribe === "function") {
    await invoke(
      connection,
      pattern ? "pSubscribe" : "subscribe",
      selector,
      (message: string, ch: string) => onMessage(ch, message),
    )
    return
  }

  // ioredis subscribes, then pushes everything through one event per kind.
  if (typeof connection.on !== "function") {
    throw new CloveBootError(
      "This Redis client supports neither node-redis's pSubscribe(channel, " +
        'listener) nor ioredis\'s on("message"), so the Pub/Sub bus cannot ' +
        "receive anything from it.",
    )
  }
  if (pattern) {
    await invoke(connection, "psubscribe", selector)
    invoke(
      connection,
      "on",
      "pmessage",
      (_p: string, ch: string, message: string) => onMessage(ch, message),
    )
    return
  }
  await invoke(connection, "subscribe", selector)
  invoke(connection, "on", "message", (ch: string, message: string) =>
    onMessage(ch, message),
  )
}

/**
 * Redis matches patterns with shell globs, not AMQP topics.
 *
 * The difference is invisible until production: `pattern("orders.#")` is legal
 * everywhere CloveJS looks — it passes the boot checks, and `app.bus.dispatch()`
 * routes to it in tests, because those use AMQP semantics. `PSUBSCRIBE` reads
 * the `#` as a literal character, so the subscription silently receives
 * nothing at all. It is worth a boot error.
 */
export function assertGlob(selector: string, subscription: string): void {
  const offending = [...new Set([...selector].filter((c) => c === "#" || c === ">"))]
  if (offending.length === 0) return

  throw new CloveBootError(
    `Subscription "${subscription}" uses pattern("${selector}"), but Redis ` +
      `Pub/Sub matches with glob syntax, where ${offending
        .map((c) => `\`${c}\``)
        .join(" and ")} ${offending.length > 1 ? "are" : "is"} an ordinary ` +
      "character rather than a wildcard — so this would match nothing. Use " +
      `\`*\` for any run of characters: pattern("${selector.replace(/[#>]/g, "*")}").`,
  )
}
