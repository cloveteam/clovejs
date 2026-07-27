import { afterEach, describe, expect, it, vi } from "vitest"
import type {
  BusSubscription,
  DeliveredMessage,
  DeliveryOutcome,
  MessageBus,
  SubscriptionHooks,
  SubscriptionSpec,
} from "../../src/bus/types.js"
import { redisPubSub, redisStreams } from "../../src/bus/redis/index.js"
import type {
  RedisStreamsBus,
  RedisStreamsOptions,
} from "../../src/bus/redis/streams.js"
import { hashTag, keyLayout } from "../../src/bus/redis/keys.js"
import { commandRunner } from "../../src/bus/redis/client.js"
import {
  encodeFields,
  parseEntries,
  parsePending,
  parseRead,
} from "../../src/bus/redis/streams.js"
import { assertGlob } from "../../src/bus/redis/pubsub.js"
import { CloveBootError } from "../../src/errors.js"
import { FakeIoredis, FakeNodeRedis, FakeRedisStore } from "./fake-redis.js"

/** Subscriptions opened by a test, closed however the test ends. */
const open: BusSubscription[] = []

afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()))
})

const hooks: SubscriptionHooks = { report: () => {} }

function spec(overrides: Partial<SubscriptionSpec> = {}): SubscriptionSpec {
  return {
    channel: "orders.created",
    pattern: false,
    subscription: "billing",
    maxInFlight: 1,
    ...overrides,
  }
}

/** Subscribes `bus`, recording every delivery and answering with `outcome`. */
async function listen(
  bus: MessageBus,
  outcome: (message: DeliveredMessage) => DeliveryOutcome | Promise<DeliveryOutcome>,
  overrides: Partial<SubscriptionSpec> = {},
): Promise<DeliveredMessage[]> {
  const seen: DeliveredMessage[] = []
  open.push(
    await bus.subscribe(
      spec(overrides),
      async (message) => {
        seen.push(message)
        return await outcome(message)
      },
      hooks,
    ),
  )
  return seen
}

/** Polls until `check` stops throwing, so no test waits a fixed time. */
async function until(check: () => void, timeout = 2000): Promise<void> {
  const deadline = Date.now() + timeout
  for (;;) {
    try {
      check()
      return
    } catch (err) {
      if (Date.now() > deadline) throw err
      await new Promise((r) => setTimeout(r, 5))
    }
  }
}

describe("key layout", () => {
  it("hashes a derived key onto the channel's own slot", () => {
    const keys = keyLayout()
    // An untagged key hashes on the whole key, so the tag on the derived one
    // has to be the channel itself for the two to share a slot.
    expect(keys.stream("orders.created")).toBe("orders.created")
    expect(keys.retry("orders.created", "billing")).toBe(
      "{orders.created}:billing:retry",
    )
    expect(hashTag(keys.retry("orders.created", "billing"))).toBe(
      hashTag(keys.stream("orders.created")),
    )
  })

  it("keeps the prefix inside the tag", () => {
    const keys = keyLayout("app:")
    expect(keys.stream("orders.created")).toBe("app:orders.created")
    expect(hashTag(keys.delayed("orders.created", "billing"))).toBe(
      hashTag(keys.stream("orders.created")),
    )
  })

  it("follows Redis's own tag rule when the channel already has braces", () => {
    // Redis hashes `a{b}c` on "b", so the derived key must be tagged with "b"
    // too — tagging it with the whole channel would land on another slot.
    expect(hashTag("a{b}c")).toBe("b")
    expect(hashTag("a{}c")).toBe("a{}c")
    expect(hashTag("a{bc")).toBe("a{bc")
    expect(keyLayout().retry("a{b}c", "s")).toBe("{b}:s:retry")
  })
})

describe("client shim", () => {
  it("sends through call() on an ioredis-shaped client", async () => {
    const client = new FakeIoredis()
    const call = vi.spyOn(client, "call")
    await commandRunner(client)(["XADD", "s", "*", "d", "1"])
    expect(call).toHaveBeenCalledWith("XADD", "s", "*", "d", "1")
  })

  it("sends through sendCommand() on a node-redis-shaped client", async () => {
    const client = new FakeNodeRedis()
    const send = vi.spyOn(client, "sendCommand")
    await commandRunner(client)(["XADD", "s", "*", "d", 1])
    // Numbers are stringified: node-redis rejects a non-string argument.
    expect(send).toHaveBeenCalledWith(["XADD", "s", "*", "d", "1"])
  })

  it("names both methods when given something that is not a client", () => {
    expect(() => commandRunner({})).toThrow(CloveBootError)
    expect(() => commandRunner({})).toThrow(/call\(\).+sendCommand\(\)/s)
  })
})

describe("reply parsing", () => {
  it("reads the RESP2 shape", () => {
    expect(parseRead([["orders", [["1-0", ["d", "{}"]]]]])).toEqual([
      { stream: "orders", id: "1-0", fields: ["d", "{}"] },
    ])
  })

  it("reads the RESP3 shapes, which depend on how the client was built", () => {
    expect(parseRead([{ name: "orders", messages: [{ id: "1-0", message: { d: "{}" } }] }])).toEqual(
      [{ stream: "orders", id: "1-0", fields: ["d", "{}"] }],
    )
    expect(parseRead({ orders: [["1-0", ["d", "{}"]]] })).toEqual([
      { stream: "orders", id: "1-0", fields: ["d", "{}"] },
    ])
  })

  it("treats a nil reply as nothing to do", () => {
    expect(parseRead(null)).toEqual([])
    expect(parseEntries("s", null)).toEqual([])
    expect(parsePending(null)).toEqual([])
  })

  it("reads the delivery count XPENDING reports", () => {
    expect(parsePending([["1-0", "worker", "5000", "3"]])).toEqual([
      { id: "1-0", deliveries: 3 },
    ])
  })
})

describe("published fields", () => {
  it("carries the payload, and the options a broker has an equivalent for", () => {
    expect(encodeFields({ orderId: "o1" }, undefined)).toEqual([
      "d",
      '{"orderId":"o1"}',
    ])
    expect(
      encodeFields(1, { id: "m1", key: "o1", headers: { tenant: "acme" } }),
    ).toEqual(["d", "1", "h", '{"tenant":"acme"}', "k", "o1", "i", "m1"])
  })
})

describe("redisStreams", () => {
  function setup(options: RedisStreamsOptions = {}): {
    store: FakeRedisStore
    bus: RedisStreamsBus
  } {
    const store = new FakeRedisStore()
    const bus = redisStreams(new FakeNodeRedis(store), {
      blockTimeout: 20,
      sweepInterval: 10,
      claimIdle: 50,
      ...options,
    })
    return { store, bus }
  }

  it("declares what Redis Streams can actually do", () => {
    expect(setup().bus.capabilities).toEqual({ retries: "delayed", patterns: false })
    expect(setup({ retries: "immediate" }).bus.capabilities.retries).toBe("immediate")
  })

  it("delivers a published message and acks it", async () => {
    const { store, bus } = setup()
    const seen = await listen(bus, () => ({ action: "ack" }))

    await bus.publish("orders.created", { orderId: "o1" }, { key: "o1" })

    await until(() => expect(seen).toHaveLength(1))
    expect(new TextDecoder().decode(seen[0]!.body)).toBe('{"orderId":"o1"}')
    expect(seen[0]).toMatchObject({ channel: "orders.created", key: "o1", failures: 0 })
    // Acked, so nothing is left pending for the claim sweep to find.
    await until(() => expect(store.pending("orders.created", "billing").size).toBe(0))
  })

  it("prefers the producer's own id, which is what idempotency keys on", async () => {
    const { bus } = setup()
    const seen = await listen(bus, () => ({ action: "ack" }))

    await bus.publish("orders.created", {}, { id: "invoice-7" })

    await until(() => expect(seen[0]?.id).toBe("invoice-7"))
  })

  it("redelivers to this subscription alone, never back to the channel", async () => {
    const { store, bus } = setup()
    const seen = await listen(bus, (message) =>
      message.failures === 0
        ? {
            action: "retry",
            subscription: "billing",
            delay: 0,
            headers: { "x-clove-attempt": "2" },
            failures: 1,
            error: new Error("boom"),
          }
        : { action: "ack" },
    )

    await bus.publish("orders.created", { orderId: "o1" })
    await until(() => expect(seen).toHaveLength(2))

    // The retry copy went to this subscription's private stream. Re-XADDing to
    // "orders.created" would hand a copy to every other group bound to it.
    expect(store.entries("orders.created")).toHaveLength(1)
    expect(store.entries("{orders.created}:billing:retry")).toHaveLength(1)
    // And it carried the counter core stamped, so the second run knows.
    expect(seen[1]!.headers).toMatchObject({ "x-clove-attempt": "2" })
    expect(seen[1]!.failures).toBe(1)
  })

  it("parks a delayed retry in the delay set until it comes due", async () => {
    const { store, bus } = setup()
    const seen = await listen(bus, (message) =>
      message.failures === 0
        ? {
            action: "retry",
            subscription: "billing",
            delay: 40,
            headers: { "x-clove-attempt": "2" },
            failures: 1,
            error: new Error("boom"),
          }
        : { action: "ack" },
    )

    await bus.publish("orders.created", { orderId: "o1" })
    await until(() => expect(seen).toHaveLength(1))

    // Durable, and not yet visible: the sweeper moves it once it is due.
    const delayed = "{orders.created}:billing:delayed"
    await until(() => expect(store.zsets.get(delayed)?.size).toBe(1))
    expect(store.entries("{orders.created}:billing:retry")).toHaveLength(0)

    await until(() => expect(seen).toHaveLength(2), 3000)
    expect(store.zsets.get(delayed)?.size).toBe(0)
  })

  it("skips the delay set when the bus was built as immediate", async () => {
    const { store, bus } = setup({ retries: "immediate" })
    const seen = await listen(bus, (message) =>
      message.failures === 0
        ? {
            action: "retry",
            subscription: "billing",
            delay: 5000,
            headers: { "x-clove-attempt": "2" },
            failures: 1,
            error: new Error("boom"),
          }
        : { action: "ack" },
    )

    await bus.publish("orders.created", {})

    // The 5s delay is dropped rather than waited out — which is exactly what
    // `retries: "immediate"` declares, and why core refuses a backoff on it.
    await until(() => expect(seen).toHaveLength(2))
    expect(store.zsets.size).toBe(0)
  })

  it("dead-letters a rejected message with why, and acks the original", async () => {
    const { store, bus } = setup()
    await listen(bus, () => ({
      action: "reject",
      reason: "unknown tenant",
      failures: 1,
    }))

    await bus.publish("orders.created", { orderId: "o1" })

    await until(() => expect(store.entries("clove.dead")).toHaveLength(1))
    expect(store.fields("clove.dead")).toMatchObject({
      d: '{"orderId":"o1"}',
      reason: "unknown tenant",
      channel: "orders.created",
      subscription: "billing",
      failures: "1",
    })
    await until(() => expect(store.pending("orders.created", "billing").size).toBe(0))
  })

  it("drops rejected messages when dead-lettering is turned off", async () => {
    const { store, bus } = setup({ deadLetter: false })
    await listen(bus, () => ({ action: "reject", reason: "no", failures: 1 }))

    await bus.publish("orders.created", {})

    await until(() => expect(store.pending("orders.created", "billing").size).toBe(0))
    expect(store.streams.has("clove.dead")).toBe(false)
  })

  /**
   * Leaves a message pending under a consumer that is never coming back —
   * a worker that read it and then crashed. Done before this process
   * subscribes, so the read loop cannot see the message and only the claim
   * sweep can produce a delivery.
   */
  async function strandOne(
    store: FakeRedisStore,
    bus: RedisStreamsBus,
    deliveries = 1,
  ): Promise<void> {
    await store.exec(["XGROUP", "CREATE", "orders.created", "billing", "$", "MKSTREAM"])
    await bus.publish("orders.created", { orderId: "o1" })
    await store.strand("orders.created", "billing", "gone", deliveries)
  }

  it("claims what a dead worker left pending", async () => {
    const { store, bus } = setup()
    await strandOne(store, bus)

    const seen = await listen(bus, () => ({ action: "ack" }))

    await until(() => expect(seen).toHaveLength(1), 3000)
    expect(seen[0]!.channel).toBe("orders.created")
    await until(() => expect(store.pending("orders.created", "billing").size).toBe(0))
  })

  it("dead-letters a message handed over more times than the redrive cap", async () => {
    const { store, bus } = setup({ maxDeliveries: 3 })
    await strandOne(store, bus, 4)

    const seen = await listen(bus, () => ({ action: "ack" }))

    // Never ran the handler again: this bounds hand-overs that never reached a
    // verdict, which is the one thing `retry({ attempts })` cannot count.
    await until(() => expect(store.entries("clove.dead")).toHaveLength(1), 3000)
    expect(seen).toHaveLength(0)
    expect(store.fields("clove.dead").reason).toMatch(/Delivered 4 times/)
  })

  it("trims with MAXLEN when one is set, and not otherwise", async () => {
    const { store, bus } = setup({ maxLen: 500 })
    await bus.publish("orders.created", {})
    expect(store.commands.at(-1)).toEqual([
      "XADD",
      "orders.created",
      "MAXLEN",
      "~",
      "500",
      "*",
      "d",
      "{}",
    ])

    const plain = setup()
    await plain.bus.publish("orders.created", {})
    expect(plain.store.commands.at(-1)).not.toContain("MAXLEN")
  })

  it("waits for the ack, not just the handler, when draining", async () => {
    const { store, bus } = setup()
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    await listen(bus, async () => {
      await held
      return { action: "ack" }
    })

    await bus.publish("orders.created", {})
    // Delivered and running: core would consider this settled the moment the
    // handler returns, one step before the message is acknowledged.
    await until(() => expect(store.pending("orders.created", "billing").size).toBe(1))

    release()
    await bus.drain()
    expect(store.pending("orders.created", "billing").size).toBe(0)
  })

  it("namespaces every key under a prefix", async () => {
    const { store, bus } = setup({ prefix: "app:" })
    await listen(bus, () => ({ action: "ack" }))
    await bus.publish("orders.created", {})

    await until(() => expect(store.entries("app:orders.created")).toHaveLength(1))
  })

  it("drives an ioredis-shaped client just as well", async () => {
    const store = new FakeRedisStore()
    const bus = redisStreams(new FakeIoredis(store), {
      blockTimeout: 20,
      sweepInterval: 10,
    })
    const seen = await listen(bus, () => ({ action: "ack" }))

    await bus.publish("orders.created", { orderId: "o1" })

    await until(() => expect(seen).toHaveLength(1))
  })
})

describe("redisPubSub", () => {
  it("declares that nothing here comes back", () => {
    expect(redisPubSub(new FakeNodeRedis()).capabilities).toEqual({
      retries: "none",
      patterns: true,
    })
  })

  it("fans a message out to a live subscriber", async () => {
    const bus = redisPubSub(new FakeNodeRedis())
    const seen = await listen(bus, () => ({ action: "ack" }), {
      subscription: "presence",
    })

    await bus.publish("orders.created", { orderId: "o1" })

    await until(() => expect(seen).toHaveLength(1))
    expect(new TextDecoder().decode(seen[0]!.body)).toBe('{"orderId":"o1"}')
  })

  it("expands a glob pattern, on either client", async () => {
    for (const client of [new FakeNodeRedis(), new FakeIoredis()]) {
      const bus = redisPubSub(client)
      const seen = await listen(bus, () => ({ action: "ack" }), {
        channel: "orders.*",
        pattern: true,
        subscription: "live",
      })

      await bus.publish("orders.created", { orderId: "o1" })
      await bus.publish("invoices.paid", {})

      await until(() => expect(seen).toHaveLength(1))
      expect(seen[0]!.channel).toBe("orders.created")
    }
  })

  it("refuses AMQP wildcards, which Redis would read as literal characters", () => {
    // Legal everywhere CloveJS looks — it passes the boot checks and
    // `dispatch()` routes to it in tests — and matches nothing in production.
    expect(() => assertGlob("orders.#", "analytics")).toThrow(CloveBootError)
    expect(() => assertGlob("orders.#", "analytics")).toThrow(/pattern\("orders\.\*"\)/)
    expect(() => assertGlob("orders.*", "analytics")).not.toThrow()
  })

  it("refuses to publish headers it would silently drop", async () => {
    const bus = redisPubSub(new FakeNodeRedis())
    await expect(
      bus.publish("presence.ping", {}, { headers: { tenant: "acme" } }),
    ).rejects.toThrow(/no header frame/)
  })

  it("carries headers when both ends agree on an envelope", async () => {
    const bus = redisPubSub(new FakeNodeRedis(), { envelope: true })
    const seen = await listen(bus, () => ({ action: "ack" }), {
      subscription: "presence",
    })

    await bus.publish("orders.created", { orderId: "o1" }, { headers: { tenant: "acme" } })

    await until(() => expect(seen).toHaveLength(1))
    expect(seen[0]!.headers).toEqual({ tenant: "acme" })
    expect(new TextDecoder().decode(seen[0]!.body)).toBe('{"orderId":"o1"}')
  })

  it("hands a malformed envelope to core, which is what logs a verdict", async () => {
    const store = new FakeRedisStore()
    const bus = redisPubSub(new FakeNodeRedis(store), { envelope: true })
    const seen = await listen(bus, () => ({ action: "ack" }), {
      subscription: "presence",
    })

    // Published by something that does not speak the envelope format.
    await store.exec(["PUBLISH", "orders.created", "not json at all"])

    await until(() => expect(seen).toHaveLength(1))
    expect(new TextDecoder().decode(seen[0]!.body)).toBe("not json at all")
  })
})
