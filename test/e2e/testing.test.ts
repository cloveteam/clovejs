import { afterEach, describe, expect, it } from "vitest"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { get, post, middleware, error } from "../../src/index.js"
import {
  createTestApp,
  createMockCtx,
  runHandler,
  runMiddleware,
  type TestApp,
} from "../../src/testing/index.js"

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (name: string) => join(here, "..", "fixtures", name)

let app: TestApp | undefined
afterEach(async () => {
  await app?.close()
  app = undefined
})

describe("createTestApp — HTTP", () => {
  it("dispatches a GET through the real router", async () => {
    app = await createTestApp({ rootDir: fixture("basic") })
    const res = await app.get("/api/v1/users")
    expect(res.status).toBe(200)
    expect(res.json).toEqual([
      { id: 1, username: "ada", isAdmin: true },
      { id: 2, username: "grace", isAdmin: false },
    ])
  })

  it("resolves route params", async () => {
    app = await createTestApp({ rootDir: fixture("basic") })
    const res = await app.get("/api/v1/users/1")
    expect(res.status).toBe(200)
    expect(res.json.username).toBe("ada")
  })

  it("answers 404 for an unknown path and 405 for a wrong method", async () => {
    app = await createTestApp({ rootDir: fixture("basic") })
    expect((await app.get("/api/v1/nope")).status).toBe(404)
    expect((await app.get("/api/v1/login")).status).toBe(405) // login is POST-only
  })

  it("keeps a cookie jar across requests, so sessions work", async () => {
    app = await createTestApp({ rootDir: fixture("basic") })
    const first = await app.get("/api/v1/counter")
    const second = await app.get("/api/v1/counter")
    expect(first.json.visits).toBe(1)
    expect(second.json.visits).toBe(2)
    expect(app.cookies.get("clove.sid")).toBeDefined()
  })

  it("reset() clears the jar", async () => {
    app = await createTestApp({ rootDir: fixture("basic") })
    await app.get("/api/v1/counter")
    app.reset()
    const after = await app.get("/api/v1/counter")
    expect(after.json.visits).toBe(1)
  })

  it("runs the middleware chain (headers + authorization)", async () => {
    app = await createTestApp({ rootDir: fixture("basic") })
    const res = await app.get("/api/v1/admin")
    expect(res.status).toBe(403) // not logged in → authorize middleware rejects
    // Middlewares above the rejection still ran and left their headers behind.
    expect(res.headers.get("x-audited")).toBe("yes")
    expect(res.headers.get("x-request-id")).toBeDefined()
  })
})

describe("createTestApp — overrides", () => {
  it("swaps a service for a plain value", async () => {
    app = await createTestApp({
      rootDir: fixture("basic"),
      overrides: {
        users: { findById: async (id: number) => ({ id, username: `stub-${id}` }) },
      },
    })
    const res = await app.get("/api/v1/users")
    expect(res.json).toEqual([
      { id: 1, username: "stub-1" },
      { id: 2, username: "stub-2" },
    ])
  })

  it("accepts a factory override with the (ctx, hooks) contract", async () => {
    let built = false
    app = await createTestApp({
      rootDir: fixture("basic"),
      overrides: {
        users: () => {
          built = true
          return { findById: async () => ({ id: 42, username: "factory" }) }
        },
      },
    })
    const res = await app.get("/api/v1/users/1")
    expect(built).toBe(true)
    expect(res.json).toEqual({ id: 42, username: "factory" })
  })
})

describe("createTestApp — MCP", () => {
  it("calls a tool with schema defaults applied", async () => {
    app = await createTestApp({ rootDir: fixture("mcp") })
    const result = (await app.mcp.callTool("searchNotes", { query: "cloves" })) as unknown[]
    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(1)
  })

  it("reads a templated resource", async () => {
    app = await createTestApp({ rootDir: fixture("mcp") })
    const note = await app.mcp.readResource("notes://1")
    expect(note.mimeType).toBe("text/markdown")
    expect(note.text).toContain("# Groceries")
  })

  it("gets a prompt", async () => {
    app = await createTestApp({ rootDir: fixture("mcp") })
    const prompt = (await app.mcp.getPrompt("summarize", { noteId: "2" })) as string
    expect(prompt).toContain("Summarize")
  })

  it("propagates a 4xx as a throwable HttpError", async () => {
    app = await createTestApp({ rootDir: fixture("mcp") })
    await expect(app.mcp.callTool("rejected")).rejects.toMatchObject({ status: 404 })
  })

  it("runs mcp/auth.ts for a token and exposes the principal", async () => {
    app = await createTestApp({ rootDir: fixture("mcp-auth") })
    const who = (await app.mcp.callTool("whoami", {}, { token: "acme-rw" })) as {
      tenant: string
      scopes: string[]
    }
    expect(who.tenant).toBe("acme")
    expect(who.scopes).toContain("notes:write")

    // A read-only token is refused by the tool's own scope check.
    await expect(
      app.mcp.callTool("addNote", { title: "x" }, { token: "acme-ro" }),
    ).rejects.toMatchObject({ status: 403 })
  })
})

describe("createTestApp — WebSocket", () => {
  it("connects, exchanges messages and closes", async () => {
    app = await createTestApp({ rootDir: fixture("basic") })
    const socket = app.ws.connect("/ws/echo")

    const hello = await socket.next()
    expect(JSON.parse(String(hello)).hello).toBe(true)

    socket.send("ping")
    expect(await socket.next()).toBe("ping")

    await socket.close()
    expect(socket.closed).toBe(true)

    // The handler's onDestroy ran, observable through a singleton counter.
    const stats = await app.get("/api/v1/stats")
    expect(stats.json.socketsDestroyed).toBe(1)
  })

  it("throws for an unknown socket path", async () => {
    app = await createTestApp({ rootDir: fixture("basic") })
    expect(() => app!.ws.connect("/ws/missing")).toThrow(/No ws\//)
  })
})

describe("createTestApp — SSE", () => {
  it("streams framed events and reports the content type", async () => {
    app = await createTestApp({ rootDir: fixture("basic") })
    const stream = app.sse("/api/v1/ticker")

    const first = await stream.next()
    expect(first).toMatchObject({ event: "tick", id: "1", data: '{"n":1}' })
    const second = await stream.next()
    expect(second.id).toBe("2")
    const third = await stream.next()
    expect(third.id).toBe("3")

    expect(stream.headers.get("content-type")).toBe("text/event-stream; charset=utf-8")
  })

  it("resumes from Last-Event-ID on reconnect", async () => {
    app = await createTestApp({ rootDir: fixture("basic") })
    const stream = app.sse("/api/v1/ticker", { headers: { "last-event-id": "3" } })

    expect((await stream.next()).id).toBe("4")
    expect((await stream.next()).id).toBe("5")
    expect((await stream.next()).id).toBe("6")
  })

  it("runs onClose and disposes the scope when the client disconnects", async () => {
    app = await createTestApp({ rootDir: fixture("basic") })
    const stream = app.sse("/api/v1/feed")

    expect(JSON.parse((await stream.next()).data)).toEqual({ hello: true })

    // `stats` is a shared singleton, so assert the delta the close produced
    // rather than an absolute count.
    const before = (await app.get("/api/v1/stats")).json.streamsClosed
    await stream.close()
    expect(stream.closed).toBe(true)

    const after = (await app.get("/api/v1/stats")).json.streamsClosed
    expect(after).toBe(before + 1)
  })
})

describe("runHandler", () => {
  it("applies the JSON rules to a returned object", async () => {
    const handler = get(async () => ({ ok: true }))
    const res = await runHandler(handler)
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ ok: true })
  })

  it("turns undefined into 204", async () => {
    const handler = post(async () => undefined)
    const res = await runHandler(handler)
    expect(res.status).toBe(204)
    expect(res.text).toBe("")
  })

  it("turns null from a GET into 404", async () => {
    const handler = get(async () => null)
    const res = await runHandler(handler)
    expect(res.status).toBe(404)
  })

  it("passes params, body and ctx through", async () => {
    const handler = post(async (req, _res, ctx) => ({
      id: req.params.id,
      name: req.body.name,
      greeting: ctx.greeter.hi(),
    }))
    const res = await runHandler(handler, {
      params: { id: "7" },
      body: { name: "Ada" },
      ctx: createMockCtx({ greeter: { hi: () => "hello" } }),
    })
    expect(res.json).toEqual({ id: "7", name: "Ada", greeting: "hello" })
  })

  it("renders a thrown error(status) into that status", async () => {
    const handler = get(async () => {
      throw error(418, { message: "teapot" })
    })
    const res = await runHandler(handler)
    expect(res.status).toBe(418)
    expect(res.json).toEqual({ message: "teapot" })
  })

  it("rethrows an unexpected error", async () => {
    const handler = get(async () => {
      throw new Error("boom")
    })
    await expect(runHandler(handler)).rejects.toThrow("boom")
  })
})

describe("runMiddleware", () => {
  it("runs the next link when it calls execute", async () => {
    const order: string[] = []
    const mw = middleware(async ({ handler }) => {
      order.push("before")
      const r = await handler.execute()
      order.push("after")
      return r
    })
    const { result } = await runMiddleware(mw, { execute: () => "inner" })
    expect(result).toBe("inner")
    expect(order).toEqual(["before", "after"])
  })

  it("captures a short-circuit response", async () => {
    const mw = middleware(async ({ res }) => {
      res.status(401).json({ message: "nope" })
    })
    const { response } = await runMiddleware(mw)
    expect(response.status).toBe(401)
    expect(response.json).toEqual({ message: "nope" })
  })
})

describe("createMockCtx", () => {
  it("supports get, set and has", () => {
    const ctx = createMockCtx({ db: { name: "fake" } })
    expect(ctx.db).toEqual({ name: "fake" })
    expect("db" in ctx).toBe(true)
    ctx.currentUser = { id: 1 }
    expect(ctx.currentUser).toEqual({ id: 1 })
  })
})
