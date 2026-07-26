import { describe, expect, it } from "vitest"
import {
  ATTEMPT_HEADER,
  computeDelay,
  matchChannel,
  memoryBus,
  readAttempt,
  reject,
  isReject,
  stampAttempt,
} from "../../src/bus/index.js"
import { compileValidator, MessageValidationError } from "../../src/bus/schema.js"
import { validateRetryPolicy } from "../../src/bus/retry.js"
import { CloveBootError } from "../../src/errors.js"

describe("matchChannel", () => {
  it("compares literally when the selector has no wildcard", () => {
    expect(matchChannel("orders.created", "orders.created")).toBe(true)
    expect(matchChannel("orders.created", "orders.cancelled")).toBe(false)
    expect(matchChannel("orders.created", "orders.created.v2")).toBe(false)
  })

  it("matches exactly one segment with *", () => {
    expect(matchChannel("orders.*", "orders.created")).toBe(true)
    expect(matchChannel("orders.*", "orders")).toBe(false)
    expect(matchChannel("orders.*", "orders.created.v2")).toBe(false)
    expect(matchChannel("*.created", "orders.created")).toBe(true)
  })

  it("matches zero or more segments with #", () => {
    expect(matchChannel("orders.#", "orders")).toBe(true)
    expect(matchChannel("orders.#", "orders.created")).toBe(true)
    expect(matchChannel("orders.#", "orders.created.v2")).toBe(true)
    expect(matchChannel("orders.#", "invoices.created")).toBe(false)
    expect(matchChannel("#", "anything.at.all")).toBe(true)
  })

  it("backtracks so # followed by a literal still matches", () => {
    expect(matchChannel("orders.#.v2", "orders.created.v2")).toBe(true)
    expect(matchChannel("orders.#.v2", "orders.a.b.c.v2")).toBe(true)
    expect(matchChannel("orders.#.v2", "orders.created.v3")).toBe(false)
  })
})

describe("attempt headers", () => {
  it("reads 1 when the header is absent", () => {
    expect(readAttempt(undefined)).toBe(1)
    expect(readAttempt({})).toBe(1)
  })

  it("round-trips through stampAttempt", () => {
    const stamped = stampAttempt({ trace: "abc" }, 4)
    expect(stamped[ATTEMPT_HEADER]).toBe("4")
    expect(stamped.trace).toBe("abc")
    expect(readAttempt(stamped)).toBe(4)
  })

  it("treats a corrupt counter as a first delivery rather than no cap", () => {
    expect(readAttempt({ [ATTEMPT_HEADER]: "banana" })).toBe(1)
    expect(readAttempt({ [ATTEMPT_HEADER]: "0" })).toBe(1)
    expect(readAttempt({ [ATTEMPT_HEADER]: "-3" })).toBe(1)
    expect(readAttempt({ [ATTEMPT_HEADER]: "2.5" })).toBe(1)
  })

  it("does not mutate the headers it was given", () => {
    const original = { trace: "abc" }
    stampAttempt(original, 2)
    expect(original).toEqual({ trace: "abc" })
  })
})

describe("computeDelay", () => {
  it("is zero without a backoff policy", () => {
    expect(computeDelay(1, null)).toBe(0)
    expect(computeDelay(3, { attempts: 5 })).toBe(0)
  })

  it("grows exponentially and caps", () => {
    const policy = {
      attempts: 10,
      backoff: { base: 100, factor: 2, max: 1000, jitter: false },
    }
    expect(computeDelay(1, policy)).toBe(100)
    expect(computeDelay(2, policy)).toBe(200)
    expect(computeDelay(3, policy)).toBe(400)
    expect(computeDelay(9, policy)).toBe(1000)
  })

  it("keeps jittered delays inside half the computed value", () => {
    const policy = { attempts: 5, backoff: { base: 1000, factor: 1, max: 10_000 } }
    for (let i = 0; i < 50; i++) {
      const delay = computeDelay(1, policy)
      expect(delay).toBeGreaterThanOrEqual(500)
      expect(delay).toBeLessThanOrEqual(1000)
    }
  })
})

describe("validateRetryPolicy", () => {
  it("accepts a sane policy", () => {
    expect(validateRetryPolicy({ attempts: 3 }, "f.ts")).toEqual({ attempts: 3 })
  })

  it("rejects a non-integer or zero attempt count", () => {
    expect(() => validateRetryPolicy({ attempts: 0 }, "f.ts")).toThrow(CloveBootError)
    expect(() => validateRetryPolicy({ attempts: 2.5 }, "f.ts")).toThrow(/integer/)
  })

  it("rejects a negative backoff base and a factor below 1", () => {
    expect(() =>
      validateRetryPolicy({ attempts: 2, backoff: { base: -1 } }, "f.ts"),
    ).toThrow(/non-negative/)
    expect(() =>
      validateRetryPolicy({ attempts: 2, backoff: { base: 1, factor: 0.5 } }, "f.ts"),
    ).toThrow(/at least 1/)
  })
})

describe("compileValidator", () => {
  const fake = (check: (v: unknown) => boolean, label: string) => ({
    parse(value: unknown) {
      if (!check(value)) throw new Error(`expected ${label}`)
      return value
    },
  })

  it("returns null when no input is declared", () => {
    expect(compileValidator(null, "f.ts")).toBeNull()
    expect(compileValidator({}, "f.ts")).toBeNull()
  })

  it("uses .parse on a whole schema, including a non-object payload", () => {
    const validate = compileValidator(
      fake((v) => Array.isArray(v), "an array"),
      "f.ts",
    )!
    expect(validate(["a"])).toEqual(["a"])
    expect(() => validate("nope")).toThrow(/expected an array/)
  })

  it("validates a bare shape field by field", async () => {
    const validate = compileValidator(
      { id: fake((v) => typeof v === "string", "a string") },
      "f.ts",
    )!
    expect(await validate({ id: "x", extra: 1 })).toEqual({ id: "x" })
    await expect(async () => validate({ id: 2 })).rejects.toThrow(
      MessageValidationError,
    )
  })

  it("rejects a non-object payload against a bare shape", () => {
    const validate = compileValidator(
      { id: fake(() => true, "anything") },
      "f.ts",
    )!
    expect(() => validate("scalar")).toThrow(/expected an object payload/)
  })

  it("supports Standard Schema validators", async () => {
    const standard = {
      "~standard": {
        version: 1,
        validate: (value: unknown) =>
          typeof value === "number"
            ? { value }
            : { issues: [{ message: "not a number", path: ["total"] }] },
      },
    }
    const validate = compileValidator(standard, "f.ts")!
    expect(await validate(7)).toBe(7)
    await expect(validate("x")).rejects.toThrow(/total: not a number/)
  })

  it("names the offending field when a bare shape holds a non-schema", () => {
    expect(() =>
      compileValidator({ id: "not a schema" } as never, "f.ts"),
    ).toThrow(/`input.id` is not a schema/)
  })
})

describe("reject()", () => {
  it("brands the signal so it survives across module copies", () => {
    const signal = reject("bad tenant")
    expect(isReject(signal)).toBe(true)
    expect(signal.reason).toBe("bad tenant")
    expect(isReject(new Error("bad tenant"))).toBe(false)
    expect(isReject({ [Symbol.for("clovejs.reject")]: true })).toBe(true)
  })
})

describe("memoryBus", () => {
  it("advertises the whole contract, so dev matches production", () => {
    expect(memoryBus().capabilities).toEqual({
      redelivery: true,
      attempts: true,
      delayedRetry: true,
      patterns: true,
      confirms: true,
    })
  })

  it("records publishes and fans out to matching subscriptions only", async () => {
    const instance = memoryBus()
    const seen: string[] = []
    await instance.subscribe(
      { channel: "orders.*", subscription: "s1", maxInFlight: 1 },
      async (message) => {
        seen.push(message.channel)
        return { action: "ack" }
      },
    )

    await instance.publish("orders.created", { id: 1 })
    await instance.publish("invoices.created", { id: 2 })
    await instance.drain()

    expect(seen).toEqual(["orders.created"])
    expect(instance.published).toHaveLength(2)
  })

  it("redelivers with the attempt the outcome asked for, and dead-letters rejects", async () => {
    const instance = memoryBus()
    const attempts: number[] = []
    await instance.subscribe(
      { channel: "c", subscription: "s", maxInFlight: 1 },
      async (message) => {
        attempts.push(message.attempt)
        return message.attempt < 3
          ? { action: "retry", attempt: message.attempt + 1, delay: 0, error: null }
          : { action: "reject", reason: "gave up", attempt: message.attempt }
      },
    )

    await instance.publish("c", { id: 1 })
    await instance.drain()

    expect(attempts).toEqual([1, 2, 3])
    expect(instance.dead).toEqual([
      expect.objectContaining({ channel: "c", reason: "gave up", attempt: 3 }),
    ])
  })

  it("isolates the payload, as a serialization boundary would", async () => {
    const instance = memoryBus()
    const payload = { nested: { count: 1 } }
    let received: { nested: { count: number } } | undefined

    await instance.subscribe(
      { channel: "c", subscription: "s", maxInFlight: 1 },
      async (message) => {
        received = message.payload as typeof payload
        received.nested.count = 99
        return { action: "ack" }
      },
    )

    await instance.publish("c", payload)
    await instance.drain()

    expect(received!.nested.count).toBe(99)
    expect(payload.nested.count).toBe(1)
  })
})
