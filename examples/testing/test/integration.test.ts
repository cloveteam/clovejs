import { afterEach, describe, expect, it } from "vitest"
import { createTestApp, type TestApp } from "clovejs/testing"

// Integration tests boot the whole app in memory — no port, no socket — and
// dispatch through the real router, middleware chain, DI and JSON rules.
// `createTestApp()` reads this project from the current directory, so there is
// nothing to configure.

let app: TestApp
afterEach(() => app?.close())

describe("notes API", () => {
  it("lists the seeded notes", async () => {
    app = await createTestApp()

    const res = await app.get("/api/notes")

    expect(res.status).toBe(200)
    expect(res.json).toHaveLength(2)
    expect(res.json[0]).toMatchObject({ id: 1, title: "Welcome" })
  })

  it("returns one note, and 404 for a missing id", async () => {
    app = await createTestApp()

    expect((await app.get("/api/notes/1")).json).toMatchObject({ title: "Welcome" })
    // `null` from a GET is turned into 404 by the JSON middleware.
    expect((await app.get("/api/notes/999")).status).toBe(404)
  })

  it("creates a note (201) that then shows up in the list", async () => {
    app = await createTestApp()

    const created = await app.post("/api/notes", { title: "Fresh", body: "new" })
    expect(created.status).toBe(201)
    expect(created.json).toMatchObject({ title: "Fresh" })

    const list = await app.get("/api/notes")
    expect(list.json).toHaveLength(3)
  })

  it("validates the body", async () => {
    app = await createTestApp()

    const res = await app.post("/api/notes", { body: "no title" })

    expect(res.status).toBe(400)
    expect(res.json).toEqual({ message: "title is required" })
  })
})

describe("sessions", () => {
  it("carries the session cookie across requests", async () => {
    app = await createTestApp()

    // Anonymous — the guarded route rejects.
    expect((await app.get("/api/me")).status).toBe(401)

    // Log in; the harness stores the clove.sid cookie automatically.
    const login = await app.post("/api/login", { username: "ada", password: "secret" })
    expect(login.status).toBe(200)
    expect(app.cookies.get("clove.sid")).toBeDefined()

    // The next request rides the same cookie, so the session is remembered.
    const me = await app.get("/api/me")
    expect(me.json).toMatchObject({ username: "ada", isAdmin: true })
  })

  it("rejects bad credentials", async () => {
    app = await createTestApp()

    const res = await app.post("/api/login", { username: "ada", password: "wrong" })

    expect(res.status).toBe(401)
  })
})

describe("admin-only middleware", () => {
  it("forbids an anonymous delete but allows an admin", async () => {
    app = await createTestApp()

    // No session → the authorize middleware answers 403.
    expect((await app.del("/api/notes/1")).status).toBe(403)

    // grace is a normal user — still forbidden.
    await app.post("/api/login", { username: "grace", password: "secret" })
    expect((await app.del("/api/notes/1")).status).toBe(403)

    // ada is an admin — the delete goes through and returns 204.
    app.reset() // drop grace's cookie
    await app.post("/api/login", { username: "ada", password: "secret" })
    expect((await app.del("/api/notes/1")).status).toBe(204)
    expect((await app.get("/api/notes/1")).status).toBe(404)
  })
})
