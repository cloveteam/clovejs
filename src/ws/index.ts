import type { IncomingMessage, Server } from "node:http"
import type { Duplex } from "node:stream"
import { WebSocketServer, type WebSocket } from "ws"
import type { Container } from "../container/container.js"
import type { Logger } from "../container/logger.js"
import { CloveRequest } from "../http/request.js"
import type { RouterTrie } from "../router/trie.js"
import type { SocketRoute } from "../scanner/index.js"
import type { WsArgs } from "../types.js"

export interface WsRuntimeOptions {
  sockets: RouterTrie
  handlers: Map<string, SocketRoute>
  root: Container
  logger: Logger
}

/**
 * Routes WebSocket upgrades to `ws/` handlers.
 *
 * Each connection gets its own request-scoped container, disposed when the
 * socket closes. HTTP middlewares do not run for upgrades — authenticate
 * inside the `ws()` handler using `ctx`.
 */
export class WsRuntime {
  #wss: WebSocketServer
  #options: WsRuntimeOptions
  #connections = new Set<{ socket: WebSocket; container: Container }>()

  constructor(options: WsRuntimeOptions) {
    this.#options = options
    this.#wss = new WebSocketServer({ noServer: true })
  }

  get empty(): boolean {
    return this.#options.handlers.size === 0
  }

  /** Attaches the upgrade listener to an HTTP server. */
  attach(server: Server): void {
    if (this.empty) return
    server.on("upgrade", (req, socket, head) => {
      this.handleUpgrade(req, socket, head)
    })
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
    const match = this.#options.sockets.match("GET", url.pathname)
    const route = match ? this.#options.handlers.get(match.route.path) : undefined

    if (!match || !route) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n")
      socket.destroy()
      return
    }

    this.#wss.handleUpgrade(req, socket, head, (ws) => {
      void this.#open(ws, req, route, match.params)
    })
  }

  async #open(
    socket: WebSocket,
    raw: IncomingMessage,
    route: SocketRoute,
    params: Record<string, string>,
  ): Promise<void> {
    const container = this.#options.root.createChild("request")
    const entry = { socket, container }
    this.#connections.add(entry)

    const messageHandlers: Array<(msg: string | Buffer) => void | Promise<void>> = []
    const closeHandlers: Array<() => void | Promise<void>> = []

    const req = new CloveRequest(raw)
    req.params = params

    const args: WsArgs = {
      ctx: container.ctx,
      req,
      params,
      onMessage: (fn) => void messageHandlers.push(fn),
      onClose: (fn) => void closeHandlers.push(fn),
      onDestroy: (fn) => container.registerDestroyHook(fn),
      send: (data) => {
        if (socket.readyState !== socket.OPEN) return
        socket.send(
          typeof data === "string" || Buffer.isBuffer(data)
            ? data
            : JSON.stringify(data),
        )
      },
      close: (code, reason) => socket.close(code, reason),
    }

    socket.on("message", (data, isBinary) => {
      const msg = isBinary ? toBuffer(data) : toBuffer(data).toString("utf8")
      for (const fn of messageHandlers) {
        try {
          const r = fn(msg)
          if (r instanceof Promise) r.catch((err) => this.#onError(err))
        } catch (err) {
          this.#onError(err)
        }
      }
    })

    socket.on("close", () => {
      this.#connections.delete(entry)
      void (async () => {
        for (const fn of closeHandlers) {
          try {
            await fn()
          } catch (err) {
            this.#onError(err)
          }
        }
        try {
          await container.dispose()
        } catch (err) {
          this.#onError(err)
        }
      })()
    })

    socket.on("error", (err) => this.#onError(err))

    try {
      await route.handler(args)
    } catch (err) {
      this.#onError(err)
      socket.close(1011, "Handler failed")
    }
  }

  #onError(err: unknown): void {
    this.#options.logger.error("WebSocket error:", err)
  }

  /** Closes every open socket and disposes their scopes. */
  async close(): Promise<void> {
    const entries = [...this.#connections]
    for (const { socket } of entries) socket.close(1001, "Server shutting down")
    await Promise.all(
      entries.map(({ container }) => container.dispose().catch(() => undefined)),
    )
    this.#connections.clear()
    await new Promise<void>((resolve) => this.#wss.close(() => resolve()))
  }
}

function toBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  return Buffer.from(String(data))
}
