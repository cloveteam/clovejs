import { afterEach, describe, expect, it, vi } from "vitest"
import { createTestApp, type TestApp } from "clovejs/testing"

// Overrides are the one capability tests get that production forbids: swap any
// injectable — a service, a di value — for a fake, keyed by its `ctx` name and
// checked against the generated context.

let app: TestApp
afterEach(() => app?.close())

describe("dependency overrides", () => {
  it("swaps a service for a plain fake", async () => {
    app = await createTestApp({
      overrides: {
        notes: {
          list: () => [{ id: 99, title: "Faked", body: "from the test" }],
        },
      },
    })

    const res = await app.get("/api/notes")

    expect(res.json).toEqual([{ id: 99, title: "Faked", body: "from the test" }])
  })

  it("swaps a di value", async () => {
    app = await createTestApp({
      overrides: {
        config: { appName: "overridden", greeting: "hi" },
      },
    })

    // The value is read by anything resolving ctx.config; here we just prove it
    // took hold by reading it back off the booted app's root context.
    expect(app.app.root.ctx.config).toEqual({ appName: "overridden", greeting: "hi" })
  })

  it("accepts a factory override with the (ctx) contract", async () => {
    app = await createTestApp({
      overrides: {
        // A function is treated as a factory, exactly like a services/ file.
        auth: () => ({
          login: (username: string) => ({ id: 7, username, isAdmin: true }),
        }),
      },
    })

    const res = await app.post("/api/login", { username: "anyone", password: "whatever" })

    expect(res.json).toMatchObject({ id: 7, username: "anyone", isAdmin: true })
  })

  it("works with a spy, so calls can be asserted", async () => {
    const login = vi.fn((username: string) => ({ id: 1, username, isAdmin: false }))
    app = await createTestApp({ overrides: { auth: { login } } })

    await app.post("/api/login", { username: "ada", password: "secret" })

    expect(login).toHaveBeenCalledOnce()
    expect(login).toHaveBeenCalledWith("ada", "secret")
  })
})
