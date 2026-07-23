import { EventEmitter } from "node:events"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CloveRequest } from "../../src/http/request.js"
import { CloveResponse } from "../../src/http/response.js"
import { SseStream, formatSseEvent } from "../../src/http/sse.js"
import { createLogger } from "../../src/container/logger.js"

/** A minimal `ServerResponse` stand-in recording everything written. */
class FakeRaw extends EventEmitter {
  statusCode = 200
  headersSent = false
  headers: Record<string, unknown> = {}
  chunks: string[] = []
  writableEnded = false

  writeHead(status: number, headers: Record<string, unknown>): this {
    this.statusCode = status
    Object.assign(this.headers, headers)
    this.headersSent = true
    return this
  }
  write(chunk: string): boolean {
    this.chunks.push(chunk)
    return true
  }
  end(): this {
    this.writableEnded = true
    this.emit("finish")
    return this
  }
  get body(): string {
    return this.chunks.join("")
  }
}

function makeStream(headers: Record<string, string> = {}, options = {}) {
  const raw = new FakeRaw()
  const req = new CloveRequest({ method: "GET", url: "/", headers, socket: {} } as never)
  const res = new CloveResponse(raw as never)
  const stream = new SseStream(req, res, options, createLogger("silent"))
  return { raw, req, res, stream }
}

describe("formatSseEvent", () => {
  it("serializes a bare data event", () => {
    expect(formatSseEvent({ data: "hi" })).toBe("data: hi\n\n")
  })

  it("JSON-encodes object payloads", () => {
    expect(formatSseEvent({ data: { a: 1 } })).toBe('data: {"a":1}\n\n')
  })

  it("writes event, id and retry fields before data", () => {
    expect(formatSseEvent({ event: "tick", id: "7", retry: 3000, data: "x" })).toBe(
      "event: tick\nid: 7\nretry: 3000\ndata: x\n\n",
    )
  })

  it("splits multi-line data into several data lines", () => {
    expect(formatSseEvent({ data: "a\nb" })).toBe("data: a\ndata: b\n\n")
  })
})

describe("SseStream", () => {
  it("writes SSE headers on the first send", () => {
    const { raw, stream } = makeStream()
    expect(raw.headersSent).toBe(false)
    stream.send("hello")
    expect(raw.headersSent).toBe(true)
    expect(raw.statusCode).toBe(200)
    expect(raw.headers["content-type"]).toBe("text/event-stream; charset=utf-8")
    expect(raw.body).toBe("data: hello\n\n")
  })

  it("exposes Last-Event-ID from the request", () => {
    const { stream } = makeStream({ "last-event-id": "42" })
    expect(stream.lastEventId).toBe("42")
  })

  it("emits an initial retry hint when configured", () => {
    const { raw, stream } = makeStream({}, { retry: 5000 })
    stream.begin()
    expect(raw.body).toBe("retry: 5000\n\n")
  })

  it("runs onClose then onDestroy and ends the response on close", async () => {
    const { raw, stream } = makeStream()
    const order: string[] = []
    stream.onClose(() => void order.push("close"))
    stream.onDestroy(() => void order.push("destroy"))
    stream.send("x")
    stream.close()
    await stream.done
    expect(order).toEqual(["close", "destroy"])
    expect(raw.writableEnded).toBe(true)
  })

  it("tears down when the client disconnects", async () => {
    const { raw, stream } = makeStream()
    let closed = false
    stream.onClose(() => void (closed = true))
    stream.send("x")
    raw.emit("close")
    await stream.done
    expect(closed).toBe(true)
  })

  it("ignores writes after teardown", async () => {
    const { raw, stream } = makeStream()
    stream.send("first")
    stream.close()
    await stream.done
    stream.send("second")
    expect(raw.body).toBe("data: first\n\n")
    expect(stream.open).toBe(false)
  })

  describe("heartbeat", () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it("writes comment pings on the configured interval", async () => {
      const { raw, stream } = makeStream({}, { heartbeat: 1000 })
      stream.begin()
      vi.advanceTimersByTime(2500)
      expect(raw.body).toBe(": ping\n\n: ping\n\n")
      stream.close()
      await stream.done
    })

    it("stops the heartbeat after close", async () => {
      const { raw, stream } = makeStream({}, { heartbeat: 1000 })
      stream.begin()
      vi.advanceTimersByTime(1000)
      stream.close()
      await stream.done
      const after = raw.body
      vi.advanceTimersByTime(5000)
      expect(raw.body).toBe(after)
    })
  })
})
