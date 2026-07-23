import { EventEmitter } from "node:events"
import type { SocketLike } from "../ws/index.js"

/**
 * An in-memory socket that satisfies {@link SocketLike}. The runtime writes to
 * it with `send`/`close` and subscribes with `on`; the test side drives it by
 * emitting `message` and reads what the handler sent through {@link onSend}.
 */
class FakeSocket extends EventEmitter implements SocketLike {
  readyState = 1
  readonly OPEN = 1

  constructor(private readonly onSend: (data: string | Buffer) => void) {
    super()
  }

  send(data: string | Buffer): void {
    this.onSend(data)
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.emit("close", code, reason)
  }
}

/** A connected socket, as handed to a test. */
export interface TestSocket {
  /** Sends a message to the handler. */
  send(data: string | Buffer): void
  /** Resolves with the next message the handler sends, or rejects on timeout. */
  next(timeoutMs?: number): Promise<string | Buffer>
  /** Every message received from the handler so far. */
  readonly messages: ReadonlyArray<string | Buffer>
  /** Closes the connection and lets the handler's teardown run. */
  close(): Promise<void>
  readonly closed: boolean
}

class TestSocketImpl implements TestSocket {
  readonly #fake: FakeSocket
  readonly #received: Array<string | Buffer> = []
  readonly #waiters: Array<(msg: string | Buffer) => void> = []
  #closed = false

  constructor() {
    this.#fake = new FakeSocket((data) => this.#deliver(data))
  }

  get socket(): SocketLike {
    return this.#fake
  }

  get messages(): ReadonlyArray<string | Buffer> {
    return this.#received
  }

  get closed(): boolean {
    return this.#closed
  }

  #deliver(msg: string | Buffer): void {
    const waiter = this.#waiters.shift()
    if (waiter) waiter(msg)
    else this.#received.push(msg)
  }

  send(data: string | Buffer): void {
    if (this.#closed) throw new Error("Cannot send on a closed socket.")
    const isBinary = Buffer.isBuffer(data)
    this.#fake.emit("message", isBinary ? data : Buffer.from(data), isBinary)
  }

  next(timeoutMs = 1000): Promise<string | Buffer> {
    const buffered = this.#received.shift()
    if (buffered !== undefined) return Promise.resolve(buffered)
    return new Promise<string | Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.#waiters.indexOf(onMessage)
        if (i >= 0) this.#waiters.splice(i, 1)
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for a message.`))
      }, timeoutMs)
      const onMessage = (msg: string | Buffer) => {
        clearTimeout(timer)
        resolve(msg)
      }
      this.#waiters.push(onMessage)
    })
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#fake.close(1000, "test closed")
    // Let the runtime's close handler run its onClose/onDestroy hooks and
    // dispose the request scope before the caller continues.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}

/**
 * Opens a connection to a `ws/` handler through {@link open}, which is
 * `WsRuntime.openTestConnection`. Throws when no socket route matches the path.
 */
export function connectSocket(
  path: string,
  open: (path: string, socket: SocketLike) => boolean,
): TestSocket {
  const impl = new TestSocketImpl()
  if (!open(path, impl.socket)) {
    throw new Error(`No ws/ handler matches "${path}".`)
  }
  return impl
}
