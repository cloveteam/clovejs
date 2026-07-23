import { EventEmitter } from "node:events"

/** One event parsed off the SSE stream, as handed to a test. */
export interface SseMessage {
  /** The `event:` field, or `"message"` when the server omitted it. */
  event: string
  /** The `data:` payload as a string (multi-line data rejoined with "\n"). */
  data: string
  id?: string
  retry?: number
}

/** A live SSE connection, as handed to a test. */
export interface TestSseStream {
  /** The response status. Meaningful once the stream has opened. */
  readonly status: number
  /** The response headers. Populated once the stream has opened. */
  readonly headers: Headers
  /** Every data event received so far. */
  readonly messages: ReadonlyArray<SseMessage>
  /** Every comment line (`: ...`) received so far, heartbeats included. */
  readonly comments: ReadonlyArray<string>
  /** Resolves with the next data event, or rejects on timeout. */
  next(timeoutMs?: number): Promise<SseMessage>
  /** Disconnects the client and lets the handler's teardown run. */
  close(): Promise<void>
  readonly closed: boolean
}

/**
 * Captures a Server-Sent Events response in memory. Implements the slice of
 * `ServerResponse` the response path and {@link SseStream} touch, parsing each
 * write into events as it arrives.
 */
export class SseCapture extends EventEmitter {
  statusCode = 200
  headersSent = false

  #headers = new Map<string, string | string[]>()
  #buffer = ""
  #ended = false
  #resolveEnded!: () => void

  readonly whenEnded: Promise<void>
  readonly messages: SseMessage[] = []
  readonly comments: string[] = []
  readonly #waiters: Array<(msg: SseMessage) => void> = []

  constructor() {
    super()
    this.whenEnded = new Promise<void>((resolve) => {
      this.#resolveEnded = resolve
    })
  }

  get writableEnded(): boolean {
    return this.#ended
  }

  setHeader(name: string, value: string | string[] | number): void {
    this.#headers.set(name.toLowerCase(), Array.isArray(value) ? value : String(value))
  }

  getHeader(name: string): string | string[] | undefined {
    return this.#headers.get(name.toLowerCase())
  }

  removeHeader(name: string): void {
    this.#headers.delete(name.toLowerCase())
  }

  hasHeader(name: string): boolean {
    return this.#headers.has(name.toLowerCase())
  }

  writeHead(
    statusCode: number,
    reasonOrHeaders?: string | Record<string, string | string[] | number>,
    maybeHeaders?: Record<string, string | string[] | number>,
  ): this {
    this.statusCode = statusCode
    const headers = typeof reasonOrHeaders === "object" ? reasonOrHeaders : maybeHeaders
    if (headers) for (const [k, v] of Object.entries(headers)) this.setHeader(k, v)
    this.headersSent = true
    return this
  }

  write(chunk: string | Buffer): boolean {
    this.#buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk
    let idx: number
    while ((idx = this.#buffer.indexOf("\n\n")) !== -1) {
      const block = this.#buffer.slice(0, idx)
      this.#buffer = this.#buffer.slice(idx + 2)
      if (block !== "") this.#parseBlock(block)
    }
    return true
  }

  end(chunk?: string | Buffer): this {
    if (this.#ended) return this
    if (chunk != null) this.write(chunk)
    this.#ended = true
    this.headersSent = true
    this.#resolveEnded()
    return this
  }

  /** The response headers as a `Headers` object (Set-Cookie omitted). */
  toHeaders(): Headers {
    const headers = new Headers()
    for (const [key, value] of this.#headers) {
      if (key === "set-cookie") continue
      if (Array.isArray(value)) for (const item of value) headers.append(key, item)
      else headers.set(key, value)
    }
    return headers
  }

  next(timeoutMs = 1000): Promise<SseMessage> {
    const buffered = this.messages.length > this.#delivered ? this.messages[this.#delivered++] : undefined
    if (buffered) return Promise.resolve(buffered)
    return new Promise<SseMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.#waiters.indexOf(onMessage)
        if (i >= 0) this.#waiters.splice(i, 1)
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for an SSE event.`))
      }, timeoutMs)
      const onMessage = (msg: SseMessage) => {
        clearTimeout(timer)
        this.#delivered++
        resolve(msg)
      }
      this.#waiters.push(onMessage)
    })
  }

  #delivered = 0

  #parseBlock(block: string): void {
    let event: string | undefined
    let id: string | undefined
    let retry: number | undefined
    const dataLines: string[] = []
    let comment: string | undefined

    for (const line of block.split("\n")) {
      if (line.startsWith(":")) {
        comment = line.slice(1).replace(/^ /, "")
        continue
      }
      const c = line.indexOf(":")
      const field = c === -1 ? line : line.slice(0, c)
      let value = c === -1 ? "" : line.slice(c + 1)
      if (value.startsWith(" ")) value = value.slice(1)
      if (field === "data") dataLines.push(value)
      else if (field === "event") event = value
      else if (field === "id") id = value
      else if (field === "retry") retry = Number(value)
    }

    if (dataLines.length > 0 || event !== undefined) {
      const msg: SseMessage = { event: event ?? "message", data: dataLines.join("\n") }
      if (id !== undefined) msg.id = id
      if (retry !== undefined) msg.retry = retry
      const waiter = this.#waiters.shift()
      this.messages.push(msg)
      if (waiter) waiter(msg)
    } else if (comment !== undefined) {
      this.comments.push(comment)
    }
  }
}

/** A {@link TestSseStream} backed by an {@link SseCapture}. */
class TestSseStreamImpl implements TestSseStream {
  #closed = false
  constructor(private readonly capture: SseCapture) {}

  get status(): number {
    return this.capture.statusCode
  }
  get headers(): Headers {
    return this.capture.toHeaders()
  }
  get messages(): ReadonlyArray<SseMessage> {
    return this.capture.messages
  }
  get comments(): ReadonlyArray<string> {
    return this.capture.comments
  }
  get closed(): boolean {
    return this.#closed
  }

  next(timeoutMs?: number): Promise<SseMessage> {
    return this.capture.next(timeoutMs)
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    // Emit `close` the way a real socket does on client disconnect, then let the
    // handler's onClose/onDestroy hooks and scope disposal settle.
    this.capture.emit("close")
    await Promise.race([
      this.capture.whenEnded,
      new Promise<void>((resolve) => setTimeout(resolve, 5)),
    ])
  }
}

/** Wraps a fresh {@link SseCapture} in the test-facing handle. */
export function makeSseStream(): { capture: SseCapture; stream: TestSseStream } {
  const capture = new SseCapture()
  return { capture, stream: new TestSseStreamImpl(capture) }
}
