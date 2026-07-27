/**
 * The Redis adapters against a real server.
 *
 * Skipped unless `REDIS_URL` is set, because the suite must run on a laptop
 * with nothing installed. CI provides one; locally,
 * `docker run -p 6379:6379 redis:7` and `REDIS_URL=redis://127.0.0.1:6379`
 * is enough.
 *
 * What it covers is what the in-process double cannot: that `redis` and
 * `ioredis` really do behave the way the command shim assumes, and that the
 * command sequences are valid Redis rather than merely valid according to a
 * stand-in this repo also wrote.
 */

import { afterAll, afterEach, describe, expect, it } from "vitest"
import { createClient } from "redis"
import { Redis } from "ioredis"
import { redisPubSub, redisStreams } from "../../src/bus/redis/index.js"
import type { RedisLike } from "../../src/bus/redis/client.js"
import type {
  BusSubscription,
  DeliveredMessage,
  DeliveryOutcome,
  MessageBus,
  SubscriptionSpec,
} from "../../src/bus/types.js"

/**
 * A compile-time check, not a runtime one: both real clients have to satisfy
 * the structural port, or the adapter is unusable from the two packages it
 * exists for. Never called — `tsc` is the assertion.
 */
function accepts(_client: RedisLike): void {}
export function _assignability(
  node: ReturnType<typeof createClient>,
  io: Redis,
): void {
  accepts(node)
  accepts(io)
}

const url = process.env.REDIS_URL
const hooks = { report: () => {} }

/** Every run gets its own keyspace, so a rerun never reads the last one's mess. */
const prefix = `clove-test:${process.pid}:${Date.now()}:`

const opened: BusSubscription[] = []
const clients: Array<{ close(): Promise<void> }> = []

afterEach(async () => {
  await Promise.all(opened.splice(0).map((s) => s.close()))
})

afterAll(async () => {
  if (!url) return
  const client = createClient({ url })
  await client.connect()
  const keys = await client.keys(`${prefix}*`)
  const derived = await client.keys(`{${prefix}*`)
  if (keys.length + derived.length > 0) await client.del([...keys, ...derived])
  await client.quit()
  await Promise.all(clients.splice(0).map((c) => c.close()))
})

async function nodeRedis(): Promise<RedisLike> {
  const client = createClient({ url })
  await client.connect()
  clients.push({ close: () => client.quit().then(() => undefined) })
  return client
}

async function ioredis(): Promise<RedisLike> {
  const client = new Redis(url!)
  clients.push({ close: async () => void client.disconnect() })
  return client
}

function spec(overrides: Partial<SubscriptionSpec> = {}): SubscriptionSpec {
  return {
    channel: "orders.created",
    pattern: false,
    subscription: "billing",
    maxInFlight: 1,
    ...overrides,
  }
}

async function listen(
  bus: MessageBus,
  outcome: (message: DeliveredMessage) => DeliveryOutcome,
  overrides: Partial<SubscriptionSpec> = {},
): Promise<DeliveredMessage[]> {
  const seen: DeliveredMessage[] = []
  opened.push(
    await bus.subscribe(
      spec(overrides),
      async (message) => {
        seen.push(message)
        return outcome(message)
      },
      hooks,
    ),
  )
  return seen
}

async function until(check: () => void, timeout = 8000): Promise<void> {
  const deadline = Date.now() + timeout
  for (;;) {
    try {
      check()
      return
    } catch (err) {
      if (Date.now() > deadline) throw err
      await new Promise((r) => setTimeout(r, 25))
    }
  }
}

describe.skipIf(!url)("redis streams, against a real server", () => {
  for (const [name, connect] of [
    ["redis", nodeRedis],
    ["ioredis", ioredis],
  ] as const) {
    it(`delivers, acks and redelivers through ${name}`, async () => {
      const client = await connect()
      const channel = `${prefix}${name}.orders`
      const bus = redisStreams(client, {
        blockTimeout: 100,
        sweepInterval: 50,
        claimIdle: 500,
        deadLetter: `${prefix}dead`,
      })

      const seen = await listen(
        bus,
        (message) =>
          message.failures === 0
            ? {
                action: "retry",
                subscription: "billing",
                delay: 50,
                headers: { "x-clove-attempt": "2" },
                failures: 1,
                error: new Error("boom"),
              }
            : { action: "ack" },
        { channel },
      )

      await bus.publish(channel, { orderId: "o1" }, { id: "m1", key: "o1" })

      await until(() => expect(seen).toHaveLength(2))
      expect(JSON.parse(new TextDecoder().decode(seen[0]!.body))).toEqual({
        orderId: "o1",
      })
      expect(seen[0]).toMatchObject({ channel, id: "m1", key: "o1", failures: 0 })
      // The redelivery waited out the backoff in the delay set, then came back
      // through this subscription's private stream carrying the counter.
      expect(seen[1]!.failures).toBe(1)
      await bus.drain()
    })
  }

  it("dead-letters a rejected message", async () => {
    const client = await nodeRedis()
    const channel = `${prefix}reject.orders`
    const dead = `${prefix}dead`
    const bus = redisStreams(client, {
      blockTimeout: 100,
      sweepInterval: 50,
      deadLetter: dead,
    })

    await listen(bus, () => ({ action: "reject", reason: "unknown tenant", failures: 1 }), {
      channel,
    })
    await bus.publish(channel, { orderId: "o2" })

    const reader = createClient({ url })
    await reader.connect()
    try {
      await until(async () => {
        const entries = await reader.xRange(dead, "-", "+")
        expect(entries.length).toBeGreaterThan(0)
        expect(entries.at(-1)!.message).toMatchObject({
          reason: "unknown tenant",
          channel,
        })
      })
    } finally {
      await reader.quit()
    }
  })

  it("connects itself when given a url rather than a client", async () => {
    const channel = `${prefix}url.orders`
    // The `{ url }` form is a factory, so it is resolved the way `bus()` would.
    const factory = redisStreams({ url: url! }, { blockTimeout: 100 })
    const teardown: Array<() => void | Promise<void>> = []
    const bus = await factory({} as never, { onDestroy: (fn) => teardown.push(fn) })

    try {
      const seen = await listen(bus, () => ({ action: "ack" }), { channel })
      await bus.publish(channel, { orderId: "o3" })
      await until(() => expect(seen).toHaveLength(1))
    } finally {
      for (const fn of teardown) await fn()
    }
  })
})

describe.skipIf(!url)("redis pub/sub, against a real server", () => {
  for (const [name, connect] of [
    ["redis", nodeRedis],
    ["ioredis", ioredis],
  ] as const) {
    it(`fans out to a glob subscriber through ${name}`, async () => {
      const client = await connect()
      const bus = redisPubSub(client, { prefix })
      const seen = await listen(bus, () => ({ action: "ack" }), {
        channel: `${name}.*`,
        pattern: true,
        subscription: "presence",
      })

      // Pub/Sub drops anything published before SUBSCRIBE has landed.
      await new Promise((r) => setTimeout(r, 100))
      await bus.publish(`${name}.ping`, { at: 1 })

      await until(() => expect(seen).toHaveLength(1))
      expect(seen[0]!.channel).toBe(`${name}.ping`)
    })
  }
})
