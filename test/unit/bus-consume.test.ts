import { describe, expect, it } from "vitest"
import { z } from "zod"
import { consume } from "../../src/bus/definitions.js"
import { compileValidator } from "../../src/bus/schema.js"

interface OrderCreated {
  orderId: string
  total: number
}

/**
 * These assert types as much as behaviour: each `const typed: OrderCreated =`
 * fails `npm run typecheck` if the handler's payload stops being inferred, and
 * vitest never sees the difference. Kept alongside a real `compileValidator`
 * call so the same `input` is exercised at runtime rather than only compiled.
 */
describe("consume() payload inference", () => {
  it("infers from a hand-written parse() written with method shorthand", () => {
    // Regression: method shorthand carries an implicit `this`, which makes the
    // argument context-sensitive, which deferred it to a later inference pass.
    // The schema type parameter was fixed to its `undefined` default before
    // that pass ran, so this exact spelling failed to compile.
    const seen: OrderCreated[] = []

    const def = consume({
      bus: "events",
      channel: "orders.created",
      subscription: "billing",
      input: {
        parse(value: unknown): OrderCreated {
          const v = value as Partial<OrderCreated>
          if (typeof v?.orderId !== "string") throw new Error("orderId must be a string")
          if (typeof v?.total !== "number") throw new Error("total must be a number")
          return { orderId: v.orderId, total: v.total }
        },
      },
      handler(payload) {
        const typed: OrderCreated = payload
        seen.push(typed)
      },
    })

    const validate = compileValidator(def.input, "consumers/billing.ts")!
    expect(validate({ orderId: "o1", total: 10 })).toEqual({ orderId: "o1", total: 10 })
    expect(() => validate({ orderId: 1, total: 10 })).toThrow(/orderId must be a string/)
  })

  it("infers from a hand-written parse() written as an arrow property", () => {
    const def = consume({
      bus: "events",
      channel: "orders.created",
      subscription: "billing",
      input: { parse: (value: unknown): OrderCreated => value as OrderCreated },
      handler(payload) {
        const typed: OrderCreated = payload
        void typed
      },
    })

    expect(def.input).not.toBeNull()
  })

  it("infers from a zod schema, with no type argument", async () => {
    const def = consume({
      bus: "events",
      channel: "orders.created",
      subscription: "billing",
      input: z.object({ orderId: z.string(), total: z.number() }),
      handler(payload) {
        const typed: OrderCreated = payload
        void typed
      },
    })

    // zod from 3.24 exposes `~standard`, so this takes the Standard Schema
    // path, which validates asynchronously.
    const validate = compileValidator(def.input, "consumers/billing.ts")!
    expect(await validate({ orderId: "o1", total: 10 })).toEqual({
      orderId: "o1",
      total: 10,
    })
  })

  it("infers from an object of per-field schemas, keeping only those fields", () => {
    const def = consume({
      bus: "events",
      channel: "orders.created",
      subscription: "billing",
      input: { orderId: z.string(), total: z.number() },
      handler(payload) {
        const typed: OrderCreated = payload
        void typed
      },
    })

    const validate = compileValidator(def.input, "consumers/billing.ts")!
    expect(validate({ orderId: "o1", total: 10, extra: true })).toEqual({
      orderId: "o1",
      total: 10,
    })
  })

  it("takes the payload type from the type argument when there is no input", () => {
    const def = consume<OrderCreated>({
      bus: "events",
      channel: "orders.created",
      subscription: "billing",
      handler(payload) {
        const typed: OrderCreated = payload
        void typed
      },
    })

    expect(def.input).toBeNull()
    expect(compileValidator(def.input, "consumers/billing.ts")).toBeNull()
  })

  it("still chains .retry() off either form", () => {
    const def = consume({
      bus: "events",
      channel: "orders.created",
      subscription: "billing",
      input: z.object({ orderId: z.string() }),
      handler() {},
    }).retry({ attempts: 5, backoff: { base: 250 } })

    expect(def.channel).toBe("orders.created")
    expect(def.maxInFlight).toBeNull()
  })
})
