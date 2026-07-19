import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { WebSocket } from "ws"
import type { Clove } from "../../src/index.js"
import { startFixture } from "./helpers.js"

let server: Clove

beforeAll(async () => {
  server = await startFixture("basic")
})

afterAll(async () => {
  await server?.close()
})

/** Opens a socket and collects messages until `count` have arrived. */
function collect(
  url: string,
  count: number,
  onOpen?: (ws: WebSocket) => void,
): Promise<{ messages: string[]; socket: WebSocket }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const messages: string[] = []
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error(`Timed out after ${messages.length}/${count} messages`))
    }, 5000)

    socket.on("open", () => onOpen?.(socket))
    socket.on("message", (data) => {
      messages.push(data.toString())
      if (messages.length >= count) {
        clearTimeout(timer)
        resolve({ messages, socket })
      }
    })
    socket.on("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

describe("websockets", () => {
  it("runs the handler on connect and echoes messages", async () => {
    const wsUrl = server.url.replace("http://", "ws://") + "/ws/echo"
    const { messages, socket } = await collect(wsUrl, 2, (ws) => {
      ws.send("ping")
    })
    expect(JSON.parse(messages[0]!)).toEqual({ hello: true })
    expect(messages[1]).toBe("ping")
    socket.close()
  })

  it("passes route parameters to the handler", async () => {
    const wsUrl = server.url.replace("http://", "ws://") + "/ws/rooms/lobby"
    const { messages, socket } = await collect(wsUrl, 2, (ws) => {
      ws.send("hi")
    })
    expect(JSON.parse(messages[0]!)).toEqual({ room: "lobby" })
    expect(messages[1]).toBe("lobby: hi")
    socket.close()
  })

  it("rejects an upgrade on an unknown path", async () => {
    const wsUrl = server.url.replace("http://", "ws://") + "/ws/nope"
    await expect(collect(wsUrl, 1)).rejects.toThrow()
  })

  it("runs onDestroy when the socket closes", async () => {
    const stats = async () =>
      (await (await fetch(server.url + "/api/v1/stats")).json()) as {
        socketsOpened: number
        socketsDestroyed: number
      }

    const before = await stats()
    const wsUrl = server.url.replace("http://", "ws://") + "/ws/echo"
    const { socket } = await collect(wsUrl, 1)
    await new Promise<void>((resolve) => {
      socket.on("close", () => resolve())
      socket.close()
    })
    await new Promise((r) => setTimeout(r, 100))

    const after = await stats()
    expect(after.socketsOpened).toBe(before.socketsOpened + 1)
    expect(after.socketsDestroyed).toBe(before.socketsDestroyed + 1)
  })

  it("gives each connection its own request-scoped container", async () => {
    const wsUrl = server.url.replace("http://", "ws://") + "/ws/echo"
    const a = await collect(wsUrl, 1)
    const b = await collect(wsUrl, 1)
    // Both connected without one disposing the other's scope.
    expect(a.socket.readyState).toBe(a.socket.OPEN)
    expect(b.socket.readyState).toBe(b.socket.OPEN)
    a.socket.close()
    b.socket.close()
  })
})
