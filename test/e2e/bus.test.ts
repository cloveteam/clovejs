import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createTestApp, type TestApp } from "../../src/testing/index.js"
import { fixturePath } from "./helpers.js"

let app: TestApp

beforeEach(async () => {
  app = await createTestApp({ rootDir: fixturePath("bus"), bus: "manual" })
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
    expect(first).toMatchObject({ action: "retry", attempt: 2, delay: 0 })

    const last = await app.bus.dispatch({
      bus: "events",
      channel: "orders.created",
      subscription: "billing",
      payload: { orderId: "retry-me", total: 10 },
      attempt: 3,
    })
    expect(last).toMatchObject({ action: "reject", attempt: 3 })
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
      attempt: 1,
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
      forSubscription(s: string): Array<{ attempt: number }>
    }
    const attempts = log.forSubscription("billing").map((s) => s.attempt)
    expect(attempts).toEqual([1, 2, 3])
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

describe("capabilities", () => {
  it("exposes what each bus advertises", () => {
    expect(app.app.bus.bus("events").capabilities).toMatchObject({
      redelivery: true,
      attempts: true,
      patterns: true,
      confirms: true,
    })
    expect(app.app.bus.bus("fanout").capabilities).toMatchObject({
      redelivery: false,
      confirms: false,
    })
  })

  it("names the buses the project defines when one is missing", () => {
    expect(() => app.app.bus.bus("nope")).toThrow(/defines: events, fanout/)
  })
})
