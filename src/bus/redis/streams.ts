/**
 * A durable bus over Redis Streams.
 *
 * Streams are the Redis primitive that fits the delivery contract: a consumer
 * group is a `subscription`, the pending-entries list is the un-acked set, and
 * `XACK` is the ack. What Redis does not give is a delay, or any protection
 * against a redelivery reaching a channel's *other* groups — both are built
 * here, because getting either wrong is silent.
 */

import { CloveBootError } from "../../errors.js"
import { readFailures } from "../attempts.js"
import { encodeJson } from "../codec.js"
import type {
  BusFactory,
  BusSubscription,
  DeliveredMessage,
  DeliveryOutcome,
  MessageBus,
  PublishOptions,
  SubscriptionHooks,
  SubscriptionSpec,
} from "../types.js"
import {
  asArray,
  asString,
  closeConnection,
  commandRunner,
  connect,
  isConnectionOptions,
  openConnection,
  type RedisCommand,
  type RedisConnectionOptions,
  type RedisLike,
} from "./client.js"
import { keyLayout } from "./keys.js"

export interface RedisStreamsOptions {
  /** Prepended to every stream key. Namespaces one Redis across apps. */
  prefix?: string
  /**
   * `XADD … MAXLEN ~ n`, applied to published, retried and dead-lettered
   * entries alike. Omit to let streams grow without bound.
   *
   * Trimming is how entries are reclaimed: `XACK` clears the pending list but
   * leaves the entry in the stream, and `XDEL` is not an option because one
   * stream may feed several consumer groups.
   */
  maxLen?: number
  /**
   * Stream that rejected messages are copied to, under `prefix`. `false` drops
   * them. Defaults to `clove.dead`.
   */
  deadLetter?: string | false
  /**
   * Hand-overs before a message is dead-lettered without running the handler
   * again. Defaults to 10.
   *
   * This is the redrive policy, and it is deliberately not
   * `retry({ attempts })`: it counts deliveries that never reached a verdict —
   * the process that crashed, the handler that outlived the drain timeout —
   * which nothing inside the app can see.
   */
  maxDeliveries?: number
  /**
   * How long a delivery may sit un-acked before another consumer may claim it,
   * in milliseconds. Defaults to 60s.
   *
   * Redis's equivalent of a visibility timeout, and the same trade: shorter
   * recovers faster from a dead worker, longer tolerates a slow handler. A
   * handler that regularly runs longer than this will be processed twice.
   */
  claimIdle?: number
  /** How often to sweep the delay set and the pending list. Defaults to 5s. */
  sweepInterval?: number
  /** `XREADGROUP … BLOCK` in milliseconds. Defaults to 5s. */
  blockTimeout?: number
  /**
   * `"immediate"` skips the delay set, redelivering as fast as the loop comes
   * round. The declared capability follows, so a consumer asking for a backoff
   * then fails at boot instead of spinning.
   */
  retries?: "delayed" | "immediate"
  /** This process's name inside every consumer group. Defaults to host-pid. */
  consumer?: string
  /** Pause before a failed driver loop tries again. Defaults to 1s. */
  reconnectDelay?: number
}

const decoder = new TextDecoder()

const DEFAULTS = {
  maxDeliveries: 10,
  claimIdle: 60_000,
  sweepInterval: 5_000,
  blockTimeout: 5_000,
  reconnectDelay: 1_000,
  deadLetter: "clove.dead",
} as const

/** Field names on a stream entry. Short, because every entry carries them. */
const FIELD = {
  /** The JSON payload. */
  data: "d",
  /** User headers, JSON, present only when there are any. */
  headers: "h",
  /** `PublishOptions.key`. */
  key: "k",
  /** `PublishOptions.id`, the producer's own message id. */
  id: "i",
  /** The entry this one is a redelivery of. Also what keeps a delayed member unique. */
  source: "s",
} as const

/**
 * Moves every due member of the delay set into the retry stream, atomically.
 *
 * Atomicity is the whole point. Read-then-write loses a redelivery to a crash
 * between the two, and two replicas sweeping the same set both fire. Inside
 * `EVAL` the pop and the `XADD` are one step, so a message is delayed exactly
 * once and never dropped.
 */
const SWEEP_DELAYED = `
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
for i = 1, #due do
  local fields = cjson.decode(due[i])
  redis.call('XADD', KEYS[2], '*', unpack(fields))
  redis.call('ZREM', KEYS[1], due[i])
end
return #due
`

/**
 * A message bus backed by Redis Streams.
 *
 * Pass a connected client — `redis`, `ioredis`, a cluster client — and the
 * adapter uses it directly, duplicating a connection per subscription for the
 * blocking read. Pass `{ url }` instead and it loads whichever of those two
 * packages is installed and owns the connection itself.
 *
 * ```ts
 * // src/bus/events.ts
 * import { bus } from "clovejs/bus"
 * import { redisStreams } from "clovejs/bus/redis"
 *
 * export default bus(redisStreams({ url: process.env.REDIS_URL! }))
 * ```
 *
 * Requires Redis 6.2 or later, for `XPENDING … IDLE`.
 */
export function redisStreams(
  client: RedisLike,
  options?: RedisStreamsOptions,
): RedisStreamsBus
export function redisStreams(
  connection: RedisConnectionOptions,
  options?: RedisStreamsOptions,
): BusFactory
export function redisStreams(
  source: RedisLike | RedisConnectionOptions,
  options: RedisStreamsOptions = {},
): RedisStreamsBus | BusFactory {
  if (isConnectionOptions(source)) {
    return async (_ctx, { onDestroy }) => {
      const client = await connect(source)
      onDestroy(() => closeConnection(client))
      return build(client, options)
    }
  }
  return build(source, options)
}

export interface RedisStreamsBus extends MessageBus {
  /**
   * Waits for deliveries this process started, *including their acks*.
   *
   * Core tracks the `deliver()` promise, which settles when the handler does —
   * one step before `XACK`. Without this the process could exit in that gap,
   * leaving a finished message pending until the claim timeout brought it back
   * for a second run. Core calls it during shutdown; a test may await it too.
   */
  drain(): Promise<void>
}

/** One entry as it came off a stream. */
interface Entry {
  /** The stream it was read from — the channel's, or this subscription's retry. */
  stream: string
  id: string
  /** Flat `[name, value, …]`, kept as read so a copy can be written verbatim. */
  fields: string[]
}

function build(client: RedisLike, options: RedisStreamsOptions): RedisStreamsBus {
  const command = commandRunner(client)
  const keys = keyLayout(options.prefix ?? "")
  const mode = options.retries ?? "delayed"
  const maxLen = options.maxLen
  const maxDeliveries = options.maxDeliveries ?? DEFAULTS.maxDeliveries
  const claimIdle = options.claimIdle ?? DEFAULTS.claimIdle
  const sweepInterval = options.sweepInterval ?? DEFAULTS.sweepInterval
  const blockTimeout = options.blockTimeout ?? DEFAULTS.blockTimeout
  const reconnectDelay = options.reconnectDelay ?? DEFAULTS.reconnectDelay
  const consumerName = options.consumer ?? defaultConsumerName()
  const deadLetter =
    options.deadLetter === false
      ? null
      : (options.prefix ?? "") + (options.deadLetter ?? DEFAULTS.deadLetter)

  /** Every delivery this process has started, so `drain()` can wait for it. */
  const running = new Set<Promise<void>>()

  function trimming(args: (string | number)[]): (string | number)[] {
    return maxLen === undefined ? args : [...args, "MAXLEN", "~", maxLen]
  }

  async function add(stream: string, fields: string[]): Promise<void> {
    await command([...trimming(["XADD", stream]), "*", ...fields])
  }

  return {
    capabilities: {
      // A message that is not acked comes back — via the pending list, claimed
      // by the sweeper — and the delay set makes `outcome.delay` real.
      retries: mode,
      // A stream is one key. There is no `XREADGROUP` across a key pattern, so
      // a consumer asking for one fails at boot rather than silently reading
      // from a stream literally named "orders.*".
      patterns: false,
    },

    async publish(channel, payload, publishOptions) {
      await add(keys.stream(channel), encodeFields(payload, publishOptions))
    },

    async subscribe(spec, deliver, hooks) {
      return await start({
        spec,
        deliver,
        hooks,
        client,
        command,
        keys,
        mode,
        consumerName,
        claimIdle,
        sweepInterval,
        blockTimeout,
        reconnectDelay,
        maxDeliveries,
        deadLetter,
        trimming,
        running,
      })
    },

    async drain() {
      while (running.size > 0) await Promise.allSettled([...running])
    },
  }
}

interface DriverOptions {
  spec: SubscriptionSpec
  deliver(message: DeliveredMessage): Promise<DeliveryOutcome>
  hooks: SubscriptionHooks
  client: RedisLike
  command: RedisCommand
  keys: ReturnType<typeof keyLayout>
  mode: "delayed" | "immediate"
  consumerName: string
  claimIdle: number
  sweepInterval: number
  blockTimeout: number
  reconnectDelay: number
  maxDeliveries: number
  deadLetter: string | null
  trimming(args: (string | number)[]): (string | number)[]
  running: Set<Promise<void>>
}

/**
 * Subscribes one consumer: two streams, one group on each, a blocking read loop
 * and a sweeper.
 */
async function start(o: DriverOptions): Promise<BusSubscription> {
  const { spec, command, keys, running } = o
  const channel = spec.channel
  const group = spec.subscription
  const main = keys.stream(channel)
  const retry = keys.retry(channel, group)
  const delayed = keys.delayed(channel, group)
  const encoder = new TextEncoder()

  await ensureGroup(command, main, group)
  await ensureGroup(command, retry, group)

  // The read connection spends most of its life blocked inside XREADGROUP, so
  // acks, retries and dead-letter writes all go over the shared client. Sharing
  // one would serialize every ack behind the current BLOCK.
  const reader = await openConnection(o.client)
  const read = commandRunner(reader)

  let closed = false
  let active = 0
  let healthy = false
  /** Entries this process is handling, so the sweeper does not reclaim them. */
  const inflight = new Set<string>()
  let slot: (() => void) | null = null

  function release(): void {
    active -= 1
    const wake = slot
    slot = null
    wake?.()
  }

  function report(state: "consuming" | "reconnecting", detail?: string): void {
    if (state === "consuming") {
      if (healthy) return
      healthy = true
    } else {
      healthy = false
    }
    o.hooks.report(state, detail)
  }

  /** One entry, from `deliver()` through to the broker-side verdict. */
  async function handle(entry: Entry): Promise<void> {
    const fields = readFields(entry.fields)
    const headers = parseHeaders(fields[FIELD.headers])
    const data = fields[FIELD.data] ?? ""

    const outcome = await o.deliver({
      channel,
      subscription: group,
      // Bytes rather than a parsed value: decoding belongs inside the delivery
      // path, where a malformed payload becomes a reject instead of throwing
      // here, where nothing would ack it.
      body: encoder.encode(data),
      headers,
      failures: readFailures(headers),
      // The producer's own id when there is one — that is what an idempotency
      // key is written against — and the entry id otherwise.
      id: fields[FIELD.id] ?? entry.id,
      ...(fields[FIELD.key] !== undefined ? { key: fields[FIELD.key] } : {}),
      timestamp: entryTimestamp(entry.id),
    })

    if (outcome.action === "retry") {
      await scheduleRetry(entry, outcome.headers, outcome.delay)
    } else if (outcome.action === "reject") {
      await deadLetter(entry, outcome.reason, outcome.failures)
    }
    // Acked last, and only once the copy is durable. The other order turns a
    // crash mid-verdict into a lost message rather than a duplicated one.
    await command(["XACK", entry.stream, group, entry.id])
  }

  /**
   * Writes the redelivery, then lets the caller ack the original.
   *
   * It goes to this subscription's own retry stream, never back to the channel:
   * one stream commonly feeds several consumer groups, and re-`XADD`ing there
   * would hand a copy to every one of them — so billing's retry would make
   * email process the order a second time.
   */
  async function scheduleRetry(
    entry: Entry,
    headers: Record<string, string>,
    delay: number,
  ): Promise<void> {
    const fields = withHeaders(entry, headers)
    if (o.mode === "delayed" && delay > 0) {
      await command([
        "ZADD",
        delayed,
        Date.now() + delay,
        JSON.stringify(fields),
      ])
      return
    }
    await command([...o.trimming(["XADD", retry]), "*", ...fields])
  }

  async function deadLetter(
    entry: Entry,
    reason: string,
    failures: number,
  ): Promise<void> {
    if (!o.deadLetter) return
    await command([
      ...o.trimming(["XADD", o.deadLetter]),
      "*",
      ...entry.fields,
      "reason",
      reason,
      "failures",
      String(failures),
      "channel",
      channel,
      "subscription",
      group,
    ])
  }

  /** Launches a delivery, keeping the whole thing — ack included — drainable. */
  function dispatch(entry: Entry): void {
    active += 1
    const marker = `${entry.stream}\0${entry.id}`
    inflight.add(marker)

    const work = handle(entry)
      .catch(() => {
        // `deliver()` does not throw, so this is a Redis command that failed:
        // the entry stays pending and the claim sweep brings it back.
      })
      .finally(() => {
        inflight.delete(marker)
        release()
      })

    const tracked: Promise<void> = work.finally(() => void running.delete(tracked))
    running.add(tracked)
  }

  /** Blocks until a delivery finishes, so `maxInFlight` is a real ceiling. */
  function waitForSlot(): Promise<void> {
    return new Promise<void>((resolve) => {
      slot = resolve
    })
  }

  async function loop(): Promise<void> {
    while (!closed) {
      const free = o.spec.maxInFlight - active
      if (free <= 0) {
        await waitForSlot()
        continue
      }

      try {
        const reply = await read([
          "XREADGROUP",
          "GROUP",
          group,
          o.consumerName,
          "COUNT",
          free,
          "BLOCK",
          o.blockTimeout,
          "STREAMS",
          main,
          retry,
          ">",
          ">",
        ])
        report("consuming")
        for (const entry of parseRead(reply)) dispatch(entry)
      } catch (err) {
        if (closed) return
        report("reconnecting", messageOf(err))
        await sleep(o.reconnectDelay)
      }
    }
  }

  /**
   * The half of redelivery that no read loop can do: releasing messages whose
   * consumer died, and moving delayed ones once they come due.
   */
  async function sweep(): Promise<void> {
    if (closed) return
    try {
      if (o.mode === "delayed") {
        await command(["EVAL", SWEEP_DELAYED, 2, delayed, retry, Date.now(), 100])
      }
      for (const stream of [main, retry]) await reclaim(stream)
    } catch {
      // Transient: the read loop reports connection health, and the next tick
      // tries again. A throw here would take out the interval.
    }
  }

  /**
   * Claims what a dead consumer left pending, and dead-letters what has been
   * handed over too many times.
   *
   * `XPENDING … IDLE` rather than `XAUTOCLAIM`, because the delivery count is
   * the redrive policy and only `XPENDING` reports it.
   */
  async function reclaim(stream: string): Promise<void> {
    const free = o.spec.maxInFlight - active
    if (free <= 0) return

    const pending = parsePending(
      await command(["XPENDING", stream, group, "IDLE", o.claimIdle, "-", "+", free]),
    )

    for (const { id, deliveries } of pending) {
      if (closed) return
      if (inflight.has(`${stream}\0${id}`)) continue

      if (deliveries > o.maxDeliveries) {
        const entry = await fetch(stream, id)
        if (entry) {
          await deadLetter(
            entry,
            `Delivered ${deliveries} times without an acknowledgement`,
            deliveries,
          )
        }
        await command(["XACK", stream, group, id])
        continue
      }

      const claimed = parseEntries(
        stream,
        await command(["XCLAIM", stream, group, o.consumerName, o.claimIdle, id]),
      )
      for (const entry of claimed) dispatch(entry)
    }
  }

  async function fetch(stream: string, id: string): Promise<Entry | null> {
    const entries = parseEntries(stream, await command(["XRANGE", stream, id, id]))
    return entries[0] ?? null
  }

  report("consuming")
  void loop()
  const sweeper = setInterval(() => void sweep(), o.sweepInterval)
  sweeper.unref?.()

  return {
    async close() {
      closed = true
      clearInterval(sweeper)
      // Closing the reader is what interrupts the BLOCK in progress; the loop
      // sees `closed` and returns instead of reporting the failure.
      await closeConnection(reader)
      const wake = slot
      slot = null
      wake?.()
      o.hooks.report("stopped")
    },
  }
}

/** Creates the group unless it is already there. */
async function ensureGroup(
  command: RedisCommand,
  stream: string,
  group: string,
): Promise<void> {
  try {
    // `$` — a new subscription starts at the next message. Starting at `0`
    // would replay the whole stream the first time a consumer is deployed.
    // To replay deliberately, create the group yourself before boot.
    await command(["XGROUP", "CREATE", stream, group, "$", "MKSTREAM"])
  } catch (err) {
    if (!/BUSYGROUP/i.test(messageOf(err))) {
      throw new CloveBootError(
        `Could not create consumer group "${group}" on Redis stream ` +
          `"${stream}": ${messageOf(err)}`,
      )
    }
  }
}

/** `[name, value, …]` for one published message. */
export function encodeFields(
  payload: unknown,
  options: PublishOptions | undefined,
): string[] {
  const fields = [FIELD.data, decoder.decode(encodeJson(payload))]
  if (options?.headers && Object.keys(options.headers).length > 0) {
    fields.push(FIELD.headers, JSON.stringify(options.headers))
  }
  if (options?.key !== undefined) fields.push(FIELD.key, options.key)
  if (options?.id !== undefined) fields.push(FIELD.id, options.id)
  return fields
}

/** The entry's fields with the retry counter core stamped written over them. */
function withHeaders(entry: Entry, headers: Record<string, string>): string[] {
  const fields = readFields(entry.fields)
  fields[FIELD.headers] = JSON.stringify(headers)
  // Unique per redelivery, which is what keeps two identical payloads from
  // collapsing into one member of the delay set.
  fields[FIELD.source] = entry.id
  return Object.entries(fields).flat()
}

function readFields(flat: string[]): Record<string, string> {
  const fields: Record<string, string> = {}
  for (let i = 0; i + 1 < flat.length; i += 2) fields[flat[i]!] = flat[i + 1]!
  return fields
}

function parseHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) return {}
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value === "string") headers[name] = value
    }
    return headers
  } catch {
    // Unparseable headers must not sink the message: the payload still gets a
    // verdict, and a lost counter reads as a first delivery.
    return {}
  }
}

/**
 * `XREADGROUP` replies as `[[stream, [[id, [f, v, …]], …]], …]` under RESP2 and
 * as a map of the same under RESP3, and which one arrives depends on how the
 * client was constructed rather than on anything visible here.
 */
export function parseRead(reply: unknown): Entry[] {
  if (reply === null || reply === undefined) return []

  if (!Array.isArray(reply) && typeof reply === "object") {
    const entries: Entry[] = []
    for (const [stream, raw] of Object.entries(reply as Record<string, unknown>)) {
      entries.push(...parseEntries(stream, raw))
    }
    return entries
  }

  const entries: Entry[] = []
  for (const item of asArray(reply)) {
    // `[{ name, messages }, …]`, the shape a RESP3 client produces.
    if (item !== null && !Array.isArray(item) && typeof item === "object") {
      const stream = item as { name?: unknown; messages?: unknown }
      if (stream.name !== undefined) {
        entries.push(...parseEntries(asString(stream.name), stream.messages))
      }
      continue
    }
    const pair = asArray(item)
    if (pair.length < 2) continue
    entries.push(...parseEntries(asString(pair[0]), pair[1]))
  }
  return entries
}

/** `[[id, [name, value, …]], …]`, as `XRANGE`, `XCLAIM` and one stream of a read. */
export function parseEntries(stream: string, reply: unknown): Entry[] {
  const entries: Entry[] = []
  for (const item of asArray(reply)) {
    // RESP3 clients hand back `{ id, message }` for an entry.
    if (item !== null && !Array.isArray(item) && typeof item === "object") {
      const record = item as { id?: unknown; message?: unknown }
      if (record.id !== undefined) {
        entries.push({
          stream,
          id: asString(record.id),
          fields: Object.entries(
            (record.message ?? {}) as Record<string, unknown>,
          ).flatMap(([name, value]) => [name, asString(value)]),
        })
        continue
      }
    }
    const pair = asArray(item)
    if (pair.length < 2) continue
    entries.push({
      stream,
      id: asString(pair[0]),
      fields: asArray(pair[1]).map(asString),
    })
  }
  return entries
}

/** `[[id, consumer, idleMs, deliveries], …]`, from the extended `XPENDING`. */
export function parsePending(
  reply: unknown,
): Array<{ id: string; deliveries: number }> {
  const pending: Array<{ id: string; deliveries: number }> = []
  for (const item of asArray(reply)) {
    const row = asArray(item)
    if (row.length < 4) continue
    pending.push({
      id: asString(row[0]),
      deliveries: Number(asString(row[3])) || 1,
    })
  }
  return pending
}

/** A stream id is `<ms>-<seq>`, which is the only timestamp an entry carries. */
function entryTimestamp(id: string): Date {
  const ms = Number(id.split("-")[0])
  return Number.isFinite(ms) ? new Date(ms) : new Date()
}

function defaultConsumerName(): string {
  const host = process.env.HOSTNAME ?? "host"
  return `${host}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
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
