import { describe, expect, it } from "vitest"
import {
  ATTEMPT_HEADER,
  computeDelay,
  literal,
  looksLikePattern,
  matchChannel,
  memoryBus,
  pattern,
  readFailures,
  reject,
  isReject,
  resolveChannel,
  stampFailures,
  stripReserved,
} from "../../src/bus/index.js"
// Not part of the public surface: it has one caller, `BusRuntime.publisher`.
import { reservedHeadersIn } from "../../src/bus/attempts.js"
import {
  asValidationError,
  compileValidator,
  MessageValidationError,
} from "../../src/bus/schema.js"
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

describe("channel selectors", () => {
  it("treats a plain string as a literal channel", () => {
    expect(resolveChannel("orders.created", "f.ts")).toEqual({
      channel: "orders.created",
      pattern: false,
    })
  })

  it("refuses to guess when a bare string carries wildcard punctuation", () => {
    // Sniffing is wrong in both directions, so it is asked for by name instead.
    expect(() => resolveChannel("orders.#", "f.ts")).toThrow(CloveBootError)
    expect(() => resolveChannel("user.#1", "f.ts")).toThrow(/pattern\("user\.#1"\)/)
  })

  it("takes pattern() and literal() at their word", () => {
    expect(resolveChannel(pattern("orders.#"), "f.ts")).toEqual({
      channel: "orders.#",
      pattern: true,
    })
    expect(resolveChannel(literal("user.#1"), "f.ts")).toEqual({
      channel: "user.#1",
      pattern: false,
    })
  })

  it("still reports what looks like a pattern, for boot diagnostics", () => {
    expect(looksLikePattern("orders.#")).toBe(true)
    expect(looksLikePattern("orders.created")).toBe(false)
  })
})

describe("attempt headers", () => {
  it("reads 0 failures when the header is absent", () => {
    expect(readFailures(undefined)).toBe(0)
    expect(readFailures({})).toBe(0)
  })

  it("round-trips through stampFailures", () => {
    const stamped = stampFailures({ trace: "abc" }, 2)
    // The wire value stays the 1-based attempt number: 2 failures is attempt 3.
    expect(stamped[ATTEMPT_HEADER]).toBe("3")
    expect(stamped.trace).toBe("abc")
    expect(readFailures(stamped)).toBe(2)
  })

  it("treats a corrupt counter as a first delivery rather than no cap", () => {
    expect(readFailures({ [ATTEMPT_HEADER]: "banana" })).toBe(0)
    expect(readFailures({ [ATTEMPT_HEADER]: "0" })).toBe(0)
    expect(readFailures({ [ATTEMPT_HEADER]: "-3" })).toBe(0)
    expect(readFailures({ [ATTEMPT_HEADER]: "2.5" })).toBe(0)
  })

  it("does not mutate the headers it was given", () => {
    const original = { trace: "abc" }
    stampFailures(original, 1)
    expect(original).toEqual({ trace: "abc" })
  })

  it("keeps the framework namespace out of what a handler sees", () => {
    const headers = { trace: "abc", [ATTEMPT_HEADER]: "4", "x-clove-other": "1" }
    expect(stripReserved(headers)).toEqual({ trace: "abc" })
    expect(reservedHeadersIn(headers)).toEqual([ATTEMPT_HEADER, "x-clove-other"])
    expect(reservedHeadersIn({ trace: "abc" })).toEqual([])
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
  })

  it("rejects an object that is not a schema at all", () => {
    // A map of schemas is no longer a form of its own: name the fields in the
    // schema instead, which is what `z.object({...})` already does.
    expect(() => compileValidator({} as never, "f.ts")).toThrow(
      /not a recognised schema/,
    )
    expect(() => compileValidator({ id: "nope" } as never, "f.ts")).toThrow(
      /not a recognised schema/,
    )
  })

  it("uses .parse on a whole schema, including a non-object payload", () => {
    const validate = compileValidator(
      fake((v) => Array.isArray(v), "an array"),
      "f.ts",
    )!
    expect(validate(["a"])).toEqual(["a"])
    expect(() => validate("nope")).toThrow(/expected an array/)
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

  it("raises a validation error the runtime can tell from a handler crash", () => {
    const err = asValidationError(new Error("orderId must be a string"))
    expect(err).toBeInstanceOf(MessageValidationError)
    expect(err.issues).toEqual(["orderId must be a string"])
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
  const noHooks = { report: () => {} }

  it("advertises the whole contract by default", () => {
    expect(memoryBus().capabilities).toEqual({
      retries: "delayed",
      patterns: true,
    })
  })

  it("can be downgraded to mirror the broker a project deploys against", () => {
    // The default is the most capable bus there is, which makes it the weakest
    // possible check: no capability mismatch can surface against it.
    const instance = memoryBus({ capabilities: { retries: "immediate" } })
    expect(instance.capabilities).toEqual({ retries: "immediate", patterns: true })
  })

  it("records publishes and fans out to matching subscriptions only", async () => {
    const instance = memoryBus()
    const seen: string[] = []
    await instance.subscribe(
      { channel: "orders.*", pattern: true, subscription: "s1", maxInFlight: 1 },
      async (message) => {
        seen.push(message.channel)
        return { action: "ack" }
      },
      noHooks,
    )

    await instance.publish("orders.created", { id: 1 })
    await instance.publish("invoices.created", { id: 2 })
    await instance.drain()

    expect(seen).toEqual(["orders.created"])
    expect(instance.published).toHaveLength(2)
  })

  it("treats a non-pattern selector literally, even with wildcard characters", async () => {
    const instance = memoryBus()
    const seen: string[] = []
    await instance.subscribe(
      { channel: "user.#1", pattern: false, subscription: "s", maxInFlight: 1 },
      async (message) => {
        seen.push(message.channel)
        return { action: "ack" }
      },
      noHooks,
    )

    await instance.publish("user.everything", { id: 1 })
    await instance.publish("user.#1", { id: 2 })
    await instance.drain()

    expect(seen).toEqual(["user.#1"])
  })

  it("redelivers to the one subscription that asked, carrying its counter", async () => {
    const instance = memoryBus()
    const failures: number[] = []
    await instance.subscribe(
      { channel: "c", pattern: false, subscription: "s", maxInFlight: 1 },
      async (message) => {
        failures.push(message.failures ?? 0)
        const next = (message.failures ?? 0) + 1
        return next < 3
          ? {
              action: "retry",
              subscription: "s",
              delay: 0,
              headers: stampFailures(message.headers, next),
              failures: next,
              error: null,
            }
          : { action: "reject", reason: "gave up", failures: next }
      },
      noHooks,
    )

    await instance.publish("c", { id: 1 })
    await instance.drain()

    expect(failures).toEqual([0, 1, 2])
    expect(instance.dead).toEqual([
      expect.objectContaining({ channel: "c", reason: "gave up", failures: 3 }),
    ])
  })

  it("does not disturb a sibling subscription when one retries", async () => {
    const instance = memoryBus()
    let retried = false
    const sibling: unknown[] = []

    await instance.subscribe(
      { channel: "c", pattern: false, subscription: "failing", maxInFlight: 1 },
      async (message) => {
        if (retried) return { action: "ack" }
        retried = true
        return {
          action: "retry",
          subscription: "failing",
          delay: 0,
          headers: stampFailures(message.headers, 1),
          failures: 1,
          error: null,
        }
      },
      noHooks,
    )
    await instance.subscribe(
      { channel: "c", pattern: false, subscription: "sibling", maxInFlight: 1 },
      async (message) => {
        sibling.push(message.payload ?? message.body)
        return { action: "ack" }
      },
      noHooks,
    )

    await instance.publish("c", { id: 1 })
    await instance.drain()

    // A retry is a redelivery to one subscriber, never a re-publish.
    expect(sibling).toHaveLength(1)
  })

  it("delivers bytes, so an uncarryable payload fails here rather than in production", async () => {
    const instance = memoryBus()
    let received: unknown
    await instance.subscribe(
      { channel: "c", pattern: false, subscription: "s", maxInFlight: 1 },
      async (message) => {
        received = message.body
        return { action: "ack" }
      },
      noHooks,
    )

    await instance.publish("c", { nested: { count: 1 } })
    await instance.drain()

    expect(received).toBeInstanceOf(Uint8Array)
    expect(JSON.parse(new TextDecoder().decode(received as Uint8Array))).toEqual({
      nested: { count: 1 },
    })
  })
})
