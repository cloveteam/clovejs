import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Clove } from "../../src/index.js"
import { Client, startFixture } from "./helpers.js"

let server: Clove
let client: Client

beforeAll(async () => {
  server = await startFixture("basic")
  client = new Client(server.url)
})

afterAll(async () => {
  await server?.close()
})

describe("route resolution", () => {
  it("serves a file-derived collection route", async () => {
    const res = await client.get("/api/v1/users")
    expect(res.status).toBe(200)
    expect(res.json).toHaveLength(2)
    expect(res.json[0].username).toBe("ada")
  })

  it("does not leak fields the service strips", async () => {
    const res = await client.get("/api/v1/users")
    expect(res.json[0]).not.toHaveProperty("password")
  })

  it("serves a parameterised route", async () => {
    const res = await client.get("/api/v1/users/1")
    expect(res.status).toBe(200)
    expect(res.json.username).toBe("ada")
  })

  it("serves a nested directory route", async () => {
    const res = await client.get("/api/v1/users/1/books")
    expect(res.status).toBe(200)
    expect(res.json[0].title).toContain("Analytical Engine")
  })

  it("404s an unknown path", async () => {
    const res = await client.get("/api/v1/missing")
    expect(res.status).toBe(404)
  })

  it("405s a known path with the wrong method", async () => {
    const res = await client.post("/api/v1/users", {})
    expect(res.status).toBe(405)
  })
})

describe("json middleware", () => {
  it("404s when a GET handler returns null", async () => {
    const res = await client.get("/api/v1/users/999")
    expect(res.status).toBe(404)
    expect(res.json.message).toBe("Not Found")
  })

  it("204s when a handler returns undefined", async () => {
    const res = await client.post("/api/v1/nothing")
    expect(res.status).toBe(204)
    expect(res.text).toBe("")
  })

  it("steps aside when the handler sets a non-json type", async () => {
    const res = await client.get("/api/v1/page")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
    expect(res.text).toBe("<h1>Hello</h1>")
  })

  it("steps aside when meta.json is false", async () => {
    const res = await client.get("/api/v1/raw")
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ handWritten: true })
  })
})

describe("errors", () => {
  it("renders a thrown HttpError with its status and body", async () => {
    const res = await client.post("/api/v1/login", { username: "ada" })
    expect(res.status).toBe(400)
    expect(res.json.message).toBe("username and password are required")
  })

  it("turns an unexpected throw into a 500", async () => {
    const res = await client.get("/api/v1/boom")
    expect(res.status).toBe(500)
    expect(res.json.message).toBe("Internal Server Error")
  })
})

describe("middleware chain", () => {
  it("applies every middleware in the chain", async () => {
    const res = await client.get("/api/v1/users")
    expect(res.headers.get("x-request-id")).toMatch(/^req-\d+$/)
    expect(res.headers.get("x-audited")).toBe("yes")
    expect(res.headers.get("x-stamped")).toBe("last")
    expect(res.headers.get("x-duration-ms")).toBeTruthy()
  })

  it("orders middlewares by priority, unnumbered last", async () => {
    const names = server.app.scan.middlewares.map((m) => m.name)
    expect(names).toEqual(["trace", "authenticate", "audit", "authorize", "stamp"])
  })

  it("gives a fresh request-scoped value to each request", async () => {
    const a = await client.get("/api/v1/users")
    const b = await client.get("/api/v1/users")
    expect(a.headers.get("x-request-id")).not.toBe(b.headers.get("x-request-id"))
  })
})

describe("auth flow", () => {
  it("rejects bad credentials", async () => {
    const fresh = new Client(server.url)
    const res = await fresh.post("/api/v1/login", {
      username: "ada",
      password: "wrong",
    })
    expect(res.status).toBe(401)
    expect(res.json.message).toBe("Username / password pair mismatch")
  })

  it("blocks an admin route for anonymous callers", async () => {
    const fresh = new Client(server.url)
    const res = await fresh.get("/api/v1/admin")
    expect(res.status).toBe(403)
    expect(res.json.message).toBe("Forbidden for non-admins")
  })

  it("sets an httpOnly cookie on login and admits the admin", async () => {
    const fresh = new Client(server.url)
    const login = await fresh.post("/api/v1/login", {
      username: "ada",
      password: "lovelace",
    })
    expect(login.status).toBe(200)
    expect(login.json.user.username).toBe("ada")
    expect(login.cookies.join(";")).toContain("HttpOnly")

    const admin = await fresh.get("/api/v1/admin")
    expect(admin.status).toBe(200)
    expect(admin.json.as).toBe("ada")
  })

  it("still blocks a non-admin after login", async () => {
    const fresh = new Client(server.url)
    await fresh.post("/api/v1/login", { username: "grace", password: "hopper" })
    const admin = await fresh.get("/api/v1/admin")
    expect(admin.status).toBe(403)
  })
})

describe("session scope", () => {
  it("persists a session value across requests with the same cookie", async () => {
    const fresh = new Client(server.url)
    expect((await fresh.get("/api/v1/counter")).json.visits).toBe(1)
    expect((await fresh.get("/api/v1/counter")).json.visits).toBe(2)
    expect((await fresh.get("/api/v1/counter")).json.visits).toBe(3)
  })

  it("keeps sessions isolated from each other", async () => {
    const a = new Client(server.url)
    const b = new Client(server.url)
    await a.get("/api/v1/counter")
    await a.get("/api/v1/counter")
    expect((await a.get("/api/v1/counter")).json.visits).toBe(3)
    expect((await b.get("/api/v1/counter")).json.visits).toBe(1)
  })

  it("ignores a session cookie with a broken signature", async () => {
    const fresh = new Client(server.url)
    await fresh.get("/api/v1/counter")
    fresh.setCookie("clove.sid", "forged.value")
    expect((await fresh.get("/api/v1/counter")).json.visits).toBe(1)
  })
})

describe("dependency injection", () => {
  it("resolved every singleton before serving", () => {
    expect(server.app.root.isResolved("db")).toBe(true)
    expect(server.app.root.isResolved("auth")).toBe(true)
  })

  it("passed the config dependency into the db factory", () => {
    expect((server.app.root.get("db") as any).connectedAs).toBe("clove")
  })
})
