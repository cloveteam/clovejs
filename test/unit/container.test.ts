import { describe, expect, it } from "vitest"
import {
  Container,
  CircularDependencyError,
  ScopeUnavailableError,
} from "../../src/container/container.js"
import { Registry, type Provider } from "../../src/container/registry.js"
import { CloveBootError } from "../../src/errors.js"
import type { Lifetime, RuntimeCtx, LifecycleHooks } from "../../src/types.js"

function value(key: string, lifetime: Lifetime, val: unknown): Provider {
  return { key, kind: "di", lifetime, file: `di/${key}.ts`, value: val, isFactory: false }
}

function factory(
  key: string,
  lifetime: Lifetime,
  fn: (ctx: RuntimeCtx, hooks: LifecycleHooks) => unknown,
  kind: "di" | "service" = "di",
): Provider {
  return { key, kind, lifetime, file: `${kind}/${key}.ts`, factory: fn, isFactory: true }
}

function setup(providers: Provider[]) {
  const registry = new Registry()
  for (const p of providers) registry.add(p)
  return new Container(registry, "singleton")
}

describe("Registry", () => {
  it("rejects two providers claiming the same key", () => {
    const registry = new Registry()
    registry.add(value("auth", "singleton", 1))
    expect(() =>
      registry.add({
        key: "auth",
        kind: "service",
        lifetime: "singleton",
        file: "services/auth.ts",
        isFactory: false,
        value: 2,
      }),
    ).toThrow(CloveBootError)
  })
})

describe("Container resolution", () => {
  it("returns plain values synchronously", () => {
    const root = setup([value("config", "singleton", { url: "http://x" })])
    expect(root.ctx.config).toEqual({ url: "http://x" })
  })

  it("returns undefined for unknown keys", () => {
    const root = setup([])
    expect(root.ctx.nope).toBeUndefined()
  })

  it("resolves sync factories synchronously", () => {
    const root = setup([factory("n", "singleton", () => 42)])
    expect(root.ctx.n).toBe(42)
  })

  it("resolves async factories to a promise, then caches the value", async () => {
    const root = setup([factory("n", "singleton", async () => 42)])
    const first = root.ctx.n
    expect(first).toBeInstanceOf(Promise)
    expect(await first).toBe(42)
    // Once settled, access is synchronous.
    expect(root.ctx.n).toBe(42)
  })

  it("runs a factory only once even under concurrent access", async () => {
    let calls = 0
    const root = setup([
      factory("n", "singleton", async () => {
        calls++
        await new Promise((r) => setTimeout(r, 5))
        return calls
      }),
    ])
    const [a, b] = await Promise.all([root.ctx.n, root.ctx.n])
    expect(calls).toBe(1)
    expect(a).toBe(1)
    expect(b).toBe(1)
  })

  it("lets a factory read a plain value dependency synchronously", async () => {
    const root = setup([
      value("config", "singleton", { db: { user: "u" } }),
      factory("db", "singleton", async (ctx) => `conn:${ctx.config.db.user}`),
    ])
    expect(await root.ctx.db).toBe("conn:u")
  })

  it("lets a factory await another factory", async () => {
    const root = setup([
      factory("a", "singleton", async () => 1),
      factory("b", "singleton", async (ctx) => (await ctx.a) + 1),
    ])
    expect(await root.ctx.b).toBe(2)
  })

  it("detects circular dependencies", () => {
    const root = setup([
      factory("a", "singleton", (ctx) => ctx.b),
      factory("b", "singleton", (ctx) => ctx.a),
    ])
    expect(() => root.ctx.a).toThrow(CircularDependencyError)
  })

  it("ensure() pre-resolves so later access is synchronous", async () => {
    const root = setup([factory("n", "singleton", async () => 7)])
    await root.ensure()
    expect(root.ctx.n).toBe(7)
  })
})

describe("Scopes", () => {
  it("caches a request-scoped provider per request container", async () => {
    let calls = 0
    const root = setup([factory("rid", "request", () => ++calls)])
    const r1 = root.createChild("request")
    const r2 = root.createChild("request")
    expect(r1.ctx.rid).toBe(1)
    expect(r1.ctx.rid).toBe(1)
    expect(r2.ctx.rid).toBe(2)
  })

  it("resolves a singleton in the root even when accessed from a request", () => {
    let calls = 0
    const root = setup([factory("n", "singleton", () => ++calls)])
    expect(root.createChild("request").ctx.n).toBe(1)
    expect(root.createChild("request").ctx.n).toBe(1)
    expect(calls).toBe(1)
  })

  it("writes an assignment into the scope declared for that key", () => {
    const root = setup([value("user", "session", null)])
    const session = root.createChild("session")
    const request = session.createChild("request")
    request.ctx.user = { id: 1 }
    // Visible from a sibling request in the same session.
    const other = session.createChild("request")
    expect(other.ctx.user).toEqual({ id: 1 })
    // Not visible from a different session.
    expect(root.createChild("session").createChild("request").ctx.user).toBeNull()
  })

  it("keeps undeclared assignments in the current scope", () => {
    const root = setup([])
    const request = root.createChild("request")
    request.ctx.temp = "x"
    expect(request.ctx.temp).toBe("x")
    expect(root.createChild("request").ctx.temp).toBeUndefined()
  })

  it("shadows: a nearer scope value wins over a further one", () => {
    const root = setup([])
    const request = root.createChild("request")
    root.set("x", "root")
    request.set("x", "req")
    expect(request.ctx.x).toBe("req")
    expect(root.ctx.x).toBe("root")
  })
})

describe("Lifecycle", () => {
  it("runs onDestroy hooks in reverse order", async () => {
    const order: string[] = []
    const root = setup([
      factory("a", "singleton", (_ctx, { onDestroy }) => {
        onDestroy(() => void order.push("a"))
        return 1
      }),
      factory("b", "singleton", (_ctx, { onDestroy }) => {
        onDestroy(() => void order.push("b"))
        return 2
      }),
    ])
    void root.ctx.a
    void root.ctx.b
    await root.dispose()
    expect(order).toEqual(["b", "a"])
  })

  it("awaits async onDestroy hooks", async () => {
    let done = false
    const root = setup([
      factory("a", "singleton", (_ctx, { onDestroy }) => {
        onDestroy(async () => {
          await new Promise((r) => setTimeout(r, 5))
          done = true
        })
        return 1
      }),
    ])
    void root.ctx.a
    await root.dispose()
    expect(done).toBe(true)
  })

  it("disposes request scope without touching the root", async () => {
    const order: string[] = []
    const root = setup([
      factory("s", "singleton", (_c, { onDestroy }) => {
        onDestroy(() => void order.push("singleton"))
        return 1
      }),
      factory("r", "request", (_c, { onDestroy }) => {
        onDestroy(() => void order.push("request"))
        return 2
      }),
    ])
    const request = root.createChild("request")
    void request.ctx.s
    void request.ctx.r
    await request.dispose()
    expect(order).toEqual(["request"])
    await root.dispose()
    expect(order).toEqual(["request", "singleton"])
  })

  it("collects errors from failing hooks and still runs the rest", async () => {
    const order: string[] = []
    const root = setup([
      factory("a", "singleton", (_c, { onDestroy }) => {
        onDestroy(() => void order.push("a"))
        return 1
      }),
      factory("b", "singleton", (_c, { onDestroy }) => {
        onDestroy(() => {
          throw new Error("boom")
        })
        return 2
      }),
    ])
    void root.ctx.a
    void root.ctx.b
    await expect(root.dispose()).rejects.toThrow("boom")
    expect(order).toEqual(["a"])
  })

  it("is idempotent", async () => {
    const root = setup([])
    await root.dispose()
    await expect(root.dispose()).resolves.toBeUndefined()
  })
})

describe("isolated request scopes", () => {
  it("resolves request-lifetime values in the isolated scope itself", () => {
    const root = setup([value("perUnit", "request", { id: 1 })])
    const delivery = root.createChild("request", { isolated: true })

    // The value resolves *here* rather than being cached in the root for every
    // later delivery.
    expect(delivery.get("perUnit")).toEqual({ id: 1 })
    expect(delivery.owns("request")).toBe(true)
    expect(delivery.containerFor("request")).toBe(delivery)
  })

  it("gives each delivery its own copy of a request-lifetime factory", () => {
    let made = 0
    const root = setup([factory("scoped", "request", () => ++made)])

    expect(root.createChild("request", { isolated: true }).get("scoped")).toBe(1)
    expect(root.createChild("request", { isolated: true }).get("scoped")).toBe(2)
  })

  it("refuses a session-lifetime value rather than pinning it to the root", () => {
    const root = setup([value("visitor", "session", { visits: 0 })])
    const delivery = root.createChild("request", { isolated: true })

    expect(() => delivery.get("visitor")).toThrow(ScopeUnavailableError)
    expect(() => delivery.get("visitor")).toThrow(/no session parent/)
  })

  it("reports only eager keys of the scope's own lifetime", () => {
    const registry = new Registry()
    registry.add({ ...factory("hook", "request", () => 1), eager: true })
    registry.add(factory("lazy", "request", () => 3))

    expect(registry.eagerKeys("request")).toEqual(["hook"])
    expect(registry.eagerKeys("singleton")).toEqual([])
  })
})

describe("triggers", () => {
  it("hands a factory the trigger of the scope chain it resolves in", () => {
    const seen: unknown[] = []
    const root = setup([
      factory("who", "request", (_ctx, { trigger }) => {
        seen.push(trigger)
        return trigger?.kind ?? "none"
      }),
    ])
    const request = root.createChild("request", {
      trigger: { kind: "mcp", method: "tools/call" },
    })

    expect(request.get("who")).toBe("mcp")
    expect(seen).toEqual([{ kind: "mcp", method: "tools/call" }])
  })

  it("leaves the trigger undefined for factories outside a unit of work", () => {
    const root = setup([factory("who", "singleton", (_ctx, { trigger }) => trigger)])
    expect(root.get("who")).toBeUndefined()
  })
})
