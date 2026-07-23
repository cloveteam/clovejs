import http from "node:http"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Clove } from "../../src/index.js"
import { startFixture } from "./helpers.js"

let server: Clove

beforeAll(async () => {
  server = await startFixture("basic")
})

afterAll(async () => {
  await server?.close()
})

async function streamsClosed(): Promise<number> {
  const res = await fetch(`${server.url}/api/v1/stats`)
  return ((await res.json()) as { streamsClosed: number }).streamsClosed
}

/** Polls `check` until it is true or the deadline passes. */
async function waitFor(check: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error("Timed out waiting for condition")
}

describe("server-sent events", () => {
  it("serves a framed text/event-stream response", async () => {
    const res = await fetch(`${server.url}/api/v1/ticker`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8")
    expect(res.headers.get("cache-control")).toContain("no-cache")

    const body = await res.text()
    expect(body).toContain("event: tick")
    expect(body).toContain("id: 1")
    expect(body).toContain('data: {"n":1}')
    expect(body).toContain("id: 3")
  })

  it("resumes from Last-Event-ID", async () => {
    const res = await fetch(`${server.url}/api/v1/ticker`, {
      headers: { "last-event-id": "10" },
    })
    const body = await res.text()
    expect(body).toContain("id: 11")
    expect(body).toContain("id: 13")
    expect(body).not.toContain("id: 1\n")
  })

  it("runs the handler's onClose when the client disconnects", async () => {
    const before = await streamsClosed()

    // A raw request gives direct socket control, so `destroy()` FINs the
    // connection immediately and the server's `close` fires without waiting on
    // the fetch client's keep-alive pool.
    const greeting = await new Promise<{ chunk: string; req: http.ClientRequest }>(
      (resolve, reject) => {
        const req = http.get(`${server.url}/api/v1/feed`, (res) => {
          res.once("data", (chunk: Buffer) => resolve({ chunk: chunk.toString(), req }))
        })
        req.on("error", reject)
      },
    )
    expect(greeting.chunk).toContain('"hello":true')
    greeting.req.destroy()

    await waitFor(async () => (await streamsClosed()) === before + 1)
  })
})
