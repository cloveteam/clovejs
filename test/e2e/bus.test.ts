import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createTestApp, type TestApp } from "../../src/testing/index.js"
import { fixturePath } from "./helpers.js"

let app: TestApp

beforeEach(async () => {
  app = await createTestApp({ rootDir: fixturePath("bus"), startConsumers: false })
})

afterEach(async () => {
  await app?.close()
})

describe("dispatch", () => {
  it("runs the full delivery path and acks a clean handler", async () => {
    const outcome = await app.bus.dispatch({
      bus: "events",
      channel: "orders.created",
      subscription: "email",
      payload: { orderId: "o1", total: 10 },
    })

    expect(outcome).toEqual({ action: "ack" })
    const seen = app.app.root.get("log") as { forSubscription(s: string): unknown[] }
    expect(seen.forSubscription("email")).toHaveLength(1)
  })

  it("retries a throwing handler until the cap, then rejects", async () => {
    const first = await app.bus.dispatch({
      bus: "events",
      channel: "orders.created",
      subscription: "billing",
      payload: { orderId: "retry-me", total: 10 },
    })
    expect(first).toMatchObject({ action: "retry", failures: 1, delay: 0 })
    // Core stamped the counter, so the adapter only has to write it back.
    expect((first as { headers: Record<string, string> }).headers).toMatchObject({
      "x-clove-attempt": "2",
    })
    expect((first as { subscription: string }).subscription).toBe("billing")

    const last = await app.bus.dispatch({
      bus: "events",
      channel: "orders.created",
      subscription: "billing",
      payload: { orderId: "retry-me", total: 10 },
      failures: 2,
    })
    expect(last).toMatchObject({ action: "reject", failures: 3 })
    expect((last as { reason: string }).reason).toMatch(/Retries exhausted after 3/)
  })

  it("rejects outright when the handler throws reject()", async () => {
    const outcome = await app.bus.dispatch({
      bus: "events",
      channel: "orders.created",
      subscription: "billing",
      payload: { orderId: "o2", total: -1 },
    })
    expect(outcome).toMatchObject({
      action: "reject",
      reason: "negative total on o2",
      failures: 0,
    })
  })

  it("rejects a payload that fails input validation, never retrying it", async () => {
    const outcome = await app.bus.dispatch({
      bus: "events",
      channel: "orders.created",
      subscription: "email",
      payload: { orderId: "o3", total: -5 },
    })
    expect(outcome.action).toBe("reject")
    expect((outcome as { reason: string }).reason).toMatch(/failed validation/)
  })

  it("hands a wildcard consumer the concrete channel, not the pattern", async () => {
    await app.bus.dispatch({
      bus: "events",
      channel: "orders.cancelled",
      subscription: "audit",
      payload: { orderId: "o4" },
    })

    const log = app.app.root.get("log") as {
      forSubscription(s: string): Array<{ channel: string }>
    }
    expect(log.forSubscription("audit")[0]!.channel).toBe("orders.cancelled")
  })

  it("names the ambiguity when a channel has several consumers", async () => {
    await expect(
      app.bus.dispatch({ channel: "orders.created", payload: {} }),
    ).rejects.toThrow(/consumers match.*billing.*email|billing.*email/s)
  })
})

describe("subscriptions", () => {
  it("fans one publish out to every subscription on the channel", async () => {
    await app.bus.start()
    await app.bus.publish("events", "orders.created", { orderId: "o5", total: 1 })
    await app.bus.drain()

    const log = app.app.root.get("log") as {
      forSubscription(s: string): unknown[]
    }
    // billing fails twice then succeeds; email and audit see it once each.
    expect(log.forSubscription("email")).toHaveLength(1)
    expect(log.forSubscription("audit")).toHaveLength(1)
    expect(log.forSubscription("billing").length).toBeGreaterThan(1)
  })

  it("redelivers with an incrementing attempt until the handler succeeds", async () => {
    await app.bus.start()
    await app.bus.publish("events", "orders.created", { orderId: "flaky", total: 1 })
    await app.bus.drain()

    const log = app.app.root.get("log") as {
      forSubscription(s: string): Array<{ attempt: number; failures: number }>
    }
    const attempts = log.forSubscription("billing").map((s) => s.attempt)
    expect(attempts).toEqual([1, 2, 3])
    expect(log.forSubscription("billing").map((s) => s.failures)).toEqual([0, 1, 2])
    expect(app.bus.published("events")).toContainEqual(
      expect.objectContaining({ channel: "invoice.created" }),
    )
  })

  it("publishes from an HTTP route into the same bus", async () => {
    await app.bus.start()
    const res = await app.post("/api/orders", { orderId: "http-1", total: 5 })
    expect(res.status).toBe(200)
    await app.bus.drain()

    const log = app.app.root.get("log") as {
      forSubscription(s: string): Array<{ payload: { orderId: string } }>
    }
    expect(log.forSubscription("email")[0]!.payload.orderId).toBe("http-1")
  })
})

describe("delivery scopes", () => {
  it("resolves eager request-lifetime values and disposes them per delivery", async () => {
    const log = app.app.root.get("log") as {
      scopes(): { opened: number; closed: number }
    }
    const before = log.scopes().opened

    await app.bus.dispatch({
      bus: "events",
      channel: "orders.created",
      subscription: "email",
      payload: { orderId: "scoped", total: 1 },
    })

    // The factory ran even though the handler never reads `ctx.hook`, and the
    // scope was disposed when the delivery finished.
    const after = log.scopes()
    expect(after.opened).toBe(before + 1)
    expect(after.closed).toBe(after.opened)
  })

  it("refuses a session-lifetime value instead of pinning it to the root", async () => {
    const outcome = await app.bus.dispatch({
      bus: "events",
      channel: "orders.session",
      subscription: "session-probe",
      payload: { orderId: "s1" },
    })

    expect(outcome.action).toBe("reject")
    expect((outcome as { reason: string }).reason).toMatch(
      /lifetime "session".*no session parent/s,
    )
  })
})

describe("decoding", () => {
  /** The raw bus hands core bytes, the way a real adapter should. */
  const raw = async () => {
    await app.bus.start()
    return app.app.root.get("bus:raw") as {
      push(message: Record<string, unknown>): Promise<{ action: string; reason?: string }>
    }
  }

  it("decodes bytes inside the delivery path", async () => {
    const outcome = await (await raw()).push({
      body: new TextEncoder().encode(JSON.stringify({ ok: true })),
    })
    expect(outcome).toEqual({ action: "ack" })

    const log = app.app.root.get("log") as {
      forSubscription(s: string): Array<{ payload: { payload: unknown } }>
    }
    expect(log.forSubscription("probe")[0]!.payload.payload).toEqual({ ok: true })
  })

  it("rejects undecodable bytes instead of leaving them un-acked forever", async () => {
    // Decoded in the adapter's own callback this throws where nothing can ack,
    // and an at-least-once broker returns the same bytes indefinitely.
    const outcome = await (await raw()).push({
      body: new TextEncoder().encode("{not json"),
    })
    expect(outcome.action).toBe("reject")
    expect(outcome.reason).toMatch(/failed to decode/)
  })

  it("rejects an empty body rather than handing a handler undefined", async () => {
    const outcome = await (await raw()).push({ body: new Uint8Array() })
    expect(outcome.action).toBe("reject")
    expect(outcome.reason).toMatch(/empty/)
  })

  it("keeps the framework's own headers out of what a handler sees", async () => {
    const outcome = await (await raw()).push({
      body: new TextEncoder().encode(JSON.stringify({ ok: true })),
      headers: { trace: "abc", "x-clove-attempt": "7" },
    })
    expect(outcome).toEqual({ action: "ack" })

    const log = app.app.root.get("log") as {
      forSubscription(s: string): Array<{
        payload: { headers: Record<string, string> }
        failures: number
      }>
    }
    const seen = log.forSubscription("probe")[0]!
    expect(seen.payload.headers).toEqual({ trace: "abc" })
    // The adapter reported no failures, so a forged header cannot invent them.
    expect(seen.failures).toBe(0)
  })

  it("refuses to publish a reserved header", () => {
    expect(() =>
      app.app.bus.publisher("events").publish("orders.created", {}, {
        headers: { "x-clove-attempt": "9" },
      }),
    ).toThrow(/reserved header/)
  })
})

describe("retry caps", () => {
  it("bounds handler failures with attempts", async () => {
    const outcome = await app.bus.dispatch({
      bus: "events",
      channel: "orders.flaky",
      subscription: "flaky",
      payload: { orderId: "f1" },
      failures: 2,
    })
    expect(outcome).toMatchObject({ action: "reject", failures: 3 })
    expect((outcome as { reason: string }).reason).toMatch(/Retries exhausted/)
  })

  it("still asks for a retry while the budget holds", async () => {
    const outcome = await app.bus.dispatch({
      bus: "events",
      channel: "orders.flaky",
      subscription: "flaky",
      payload: { orderId: "f2" },
      failures: 1,
    })
    expect(outcome).toMatchObject({ action: "retry", failures: 2 })
  })
})

describe("triggers", () => {
  const log = () =>
    app.app.root.get("log") as {
      deliveryScopes(): { opened: number; closed: number; triggers: string[] }
    }

  it("fires a trigger-guarded hook per delivery, naming the trigger", async () => {
    await app.bus.dispatch({
      bus: "events",
      channel: "orders.created",
      subscription: "email",
      payload: { orderId: "t1", total: 1 },
    })

    const scopes = log().deliveryScopes()
    expect(scopes.opened).toBe(1)
    expect(scopes.closed).toBe(1)
    expect(scopes.triggers).toEqual(["delivery"])
  })

  it("does nothing on an HTTP request, where the guard sees another kind", async () => {
    const res = await app.post("/api/orders", { orderId: "t2", total: 1 })
    expect(res.status).toBe(200)
    // The HTTP side sees its own trigger, and the bus-only hook stayed put.
    expect(res.json).toMatchObject({ trigger: "http" })
    expect(log().deliveryScopes().opened).toBe(0)
  })
})

describe("subscription health", () => {
  it("reports every subscription once consumers start", async () => {
    expect(app.bus.health()).toEqual([])
    await app.bus.start()

    const health = app.bus.health()
    expect(health.length).toBeGreaterThan(0)
    expect(health.every((h) => h.state === "consuming")).toBe(true)
    expect(health.map((h) => h.subscription)).toContain("billing")
  })
})

describe("payload validation", () => {
  it("keeps only the fields the schema names", async () => {
    const outcome = await app.bus.dispatch({
      bus: "events",
      channel: "orders.shipped",
      subscription: "shipping",
      payload: { orderId: "s1", carrier: "dhl" },
    })
    expect(outcome).toEqual({ action: "ack" })

    const log = app.app.root.get("log") as {
      forSubscription(s: string): Array<{ payload: unknown }>
    }
    expect(log.forSubscription("shipping")[0]!.payload).toEqual({ orderId: "s1" })
  })
})

describe("capabilities", () => {
  it("exposes what each bus advertises", () => {
    expect(app.app.bus.bus("events").capabilities).toEqual({
      retries: "delayed",
      patterns: true,
    })
    expect(app.app.bus.bus("fanout").capabilities).toEqual({
      retries: "none",
      patterns: false,
    })
  })

  it("names the buses the project defines when one is missing", () => {
    expect(() => app.app.bus.bus("nope")).toThrow(/defines: events, fanout, raw/)
  })
})
