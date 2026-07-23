import { afterEach, describe, expect, it } from "vitest"
import { createTestApp, type TestApp } from "../../src/testing/index.js"
import { fixturePath } from "./helpers.js"

let app: TestApp | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

describe("route caching", () => {
  it("replays the terminal outcome while every interceptor still unwinds", async () => {
    app = await createTestApp({ rootDir: fixturePath("cache") })

    const first = await app.get("/api/value")
    const second = await app.get("/api/value")

    expect(first.json).toEqual({
      value: "initial",
      language: "none",
      execution: 1,
      intercepted: true,
    })
    expect(second.json).toEqual(first.json)
    expect(second.headers.get("x-handler")).toBe("1")
    expect(second.headers.get("x-before")).toBe("yes")
    expect(second.headers.get("x-after")).toBe("1")
  })

  it("does not populate the cache when an interceptor short-circuits", async () => {
    app = await createTestApp({ rootDir: fixturePath("cache") })

    const short = await app.get("/api/short", {
      headers: { "x-short-circuit": "yes" },
    })
    const firstReal = await app.get("/api/short")
    const cached = await app.get("/api/short")

    expect(short.json).toEqual({ shortCircuited: true })
    expect(short.headers.get("etag")).toBeNull()
    expect(firstReal.json.execution).toBe(1)
    expect(cached.json.execution).toBe(1)
  })

  it("coalesces concurrent misses", async () => {
    app = await createTestApp({ rootDir: fixturePath("cache") })

    const [a, b, c] = await Promise.all([
      app.get("/api/value"),
      app.get("/api/value"),
      app.get("/api/value"),
    ])

    expect([a.json.execution, b.json.execution, c.json.execution]).toEqual([1, 1, 1])
  })

  it("includes Vary headers in the key and emits HTTP cache policy", async () => {
    app = await createTestApp({ rootDir: fixturePath("cache") })

    const en = await app.get("/api/value", {
      headers: { "accept-language": "en" },
    })
    const fr = await app.get("/api/value", {
      headers: { "accept-language": "fr" },
    })

    expect(en.json.execution).toBe(1)
    expect(fr.json.execution).toBe(2)
    expect(en.headers.get("vary")).toContain("accept-language")
    expect(en.headers.get("cache-control")).toBe(
      "public, max-age=30, s-maxage=60, stale-while-revalidate=300",
    )
    expect(en.headers.get("etag")).toMatch(/^".+"$/)
  })

  it("answers matching conditional requests with 304", async () => {
    app = await createTestApp({ rootDir: fixturePath("cache") })

    const first = await app.get("/api/value")
    const conditional = await app.get("/api/value", {
      headers: { "if-none-match": first.headers.get("etag")! },
    })

    expect(conditional.status).toBe(304)
    expect(conditional.text).toBe("")
    expect(conditional.headers.get("etag")).toBe(first.headers.get("etag"))
  })

  it("does not store or publicly advertise credentialed responses", async () => {
    app = await createTestApp({ rootDir: fixturePath("cache") })

    const first = await app.get("/api/value", {
      headers: { cookie: "identity=one" },
    })
    const second = await app.get("/api/value", {
      headers: { cookie: "identity=one" },
    })

    expect(first.json.execution).toBe(1)
    expect(second.json.execution).toBe(2)
    expect(second.headers.get("cache-control")).toBe("private, no-store")
    expect(second.headers.get("etag")).toBeNull()
  })

  it("invalidates tagged reads after a successful mutation handler", async () => {
    app = await createTestApp({ rootDir: fixturePath("cache") })

    expect((await app.get("/api/value")).json.execution).toBe(1)
    expect((await app.get("/api/value")).json.execution).toBe(1)
    await app.post(
      "/api/value",
      { value: "must-not-write" },
      { headers: { "x-short-circuit": "yes" } },
    )
    expect((await app.get("/api/value")).json.execution).toBe(1)
    await app.post("/api/value", { value: "updated" })
    const refreshed = await app.get("/api/value")

    expect(refreshed.json.value).toBe("updated")
    expect(refreshed.json.execution).toBe(2)
  })
})
