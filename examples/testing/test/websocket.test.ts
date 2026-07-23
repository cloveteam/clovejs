import { afterEach, describe, expect, it } from "vitest"
import { createTestApp, type TestApp } from "clovejs/testing"

// WebSocket handlers get an in-memory client that speaks the same send /
// onMessage contract they do — opened with no server and no real upgrade.

let app: TestApp
afterEach(() => app?.close())

describe("echo socket", () => {
  it("connects, exchanges messages and closes", async () => {
    app = await createTestApp()

    const socket = app.ws.connect("/ws/echo")

    // The handler greets on connect.
    const hello = await socket.next()
    expect(JSON.parse(String(hello))).toEqual({ hello: true })

    // Round-trip a message.
    socket.send("ping")
    expect(await socket.next()).toBe("ping")

    await socket.close()
    expect(socket.closed).toBe(true)
  })

  it("throws for an unknown socket path", async () => {
    app = await createTestApp()

    expect(() => app.ws.connect("/ws/nope")).toThrow(/No ws\//)
  })
})
