import type { Logger } from "../container/logger.js"
import type {
  RouteHandlerFn,
  RuntimeCtx,
  SseArgs,
  SseEvent,
  SseHandlerFn,
  SseOptions,
} from "../types.js"
import type { CloveRequest } from "./request.js"
import type { CloveResponse } from "./response.js"

/**
 * Headers written when a stream opens. `x-accel-buffering: no` tells nginx not
 * to buffer the response, the one proxy default that silently breaks SSE.
 */
const SSE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
}

/** Serializes one event into the SSE wire format. */
export function formatSseEvent(evt: SseEvent): string {
  let frame = ""
  if (evt.event) frame += `event: ${evt.event}\n`
  if (evt.id !== undefined) frame += `id: ${evt.id}\n`
  if (evt.retry !== undefined) frame += `retry: ${evt.retry}\n`
  const data = typeof evt.data === "string" ? evt.data : JSON.stringify(evt.data)
  // A `data:` line cannot contain a newline, so a multi-line payload becomes
  // several `data:` lines that the browser rejoins with "\n".
  for (const line of data.split("\n")) frame += `data: ${line}\n`
  return frame + "\n"
}

/**
 * A live Server-Sent Events connection.
 *
 * Owns the response stream for the connection's lifetime: writes framed events,
 * runs an optional heartbeat, and tears down once — whether the client
 * disconnects or the handler calls {@link close}.
 */
export class SseStream {
  readonly lastEventId: string | undefined

  #req: CloveRequest
  #res: CloveResponse
  #options: SseOptions
  #logger: Logger

  #open = false
  #closed = false
  #heartbeat: ReturnType<typeof setInterval> | undefined
  #onClose: Array<() => void | Promise<void>> = []
  #onDestroy: Array<() => void | Promise<void>> = []
  #resolveDone!: () => void

  /** Resolves once the connection has fully torn down. */
  readonly done: Promise<void>

  constructor(req: CloveRequest, res: CloveResponse, options: SseOptions, logger: Logger) {
    this.#req = req
    this.#res = res
    this.#options = options
    this.#logger = logger
    this.lastEventId = req.header("last-event-id")
    this.done = new Promise<void>((resolve) => {
      this.#resolveDone = resolve
    })
  }

  get open(): boolean {
    return this.#open && !this.#closed
  }

  /** True once the connection has been torn down. */
  get finished(): boolean {
    return this.#closed
  }

  /**
   * Writes the status line and headers, and starts listening for disconnect.
   * Idempotent, and a no-op after teardown — so the first write of any kind
   * opens the stream, and an idle handler still becomes a valid open stream.
   */
  begin(): void {
    if (this.#open || this.#closed) return
    this.#open = true
    const raw = this.#res.raw
    raw.writeHead(200, SSE_HEADERS)
    // A closed connection is the primary end-of-life signal for a stream that
    // the server never explicitly closes.
    raw.on("close", () => void this.#teardown())
    if (this.#options.retry !== undefined) raw.write(`retry: ${this.#options.retry}\n\n`)
    if (this.#options.heartbeat && this.#options.heartbeat > 0) {
      this.#heartbeat = setInterval(() => this.comment("ping"), this.#options.heartbeat)
      // Never let the heartbeat alone keep the process alive.
      this.#heartbeat.unref?.()
    }
  }

  send(data: string | object): void {
    this.emit({ data })
  }

  emit(event: SseEvent): void {
    if (this.#closed) return
    this.begin()
    this.#res.raw.write(formatSseEvent(event))
  }

  comment(text: string): void {
    if (this.#closed) return
    this.begin()
    this.#res.raw.write(`: ${text}\n\n`)
  }

  close(): void {
    void this.#teardown()
  }

  onClose(fn: () => void | Promise<void>): void {
    this.#onClose.push(fn)
  }

  onDestroy(fn: () => void | Promise<void>): void {
    this.#onDestroy.push(fn)
  }

  /** The push-oriented view handed to the user handler. */
  args(ctx: RuntimeCtx): SseArgs {
    const view: SseArgs = {
      send: (data) => this.send(data),
      emit: (event) => this.emit(event),
      comment: (text) => this.comment(text),
      lastEventId: this.lastEventId,
      onClose: (fn) => this.onClose(fn),
      onDestroy: (fn) => this.onDestroy(fn),
      close: () => this.close(),
      open: this.open,
      ctx,
      req: this.#req,
      params: this.#req.params,
    }
    // Keep `open` live rather than a snapshot taken when the view was built.
    Object.defineProperty(view, "open", { get: () => this.open, enumerable: true })
    return view
  }

  async #teardown(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    if (this.#heartbeat) clearInterval(this.#heartbeat)

    await this.#runHooks(this.#onClose, "onClose")
    await this.#runHooks(this.#onDestroy, "onDestroy")

    if (this.#open && !this.#res.raw.writableEnded) {
      try {
        this.#res.raw.end()
      } catch (err) {
        this.#logger.error("SSE stream failed to close:", err)
      }
    }
    this.#resolveDone()
  }

  async #runHooks(
    hooks: Array<() => void | Promise<void>>,
    label: string,
  ): Promise<void> {
    for (const hook of hooks.splice(0)) {
      try {
        await hook()
      } catch (err) {
        this.#logger.error(`SSE ${label} hook threw:`, err)
      }
    }
  }
}

/**
 * Wraps an `sse()` handler into a normal route handler.
 *
 * The returned promise stays pending for the life of the connection, so the
 * pipeline holds the request scope open until the stream ends and disposes it
 * exactly then. A throw before the first write propagates to the pipeline as an
 * ordinary error response; after headers are sent, it can only be logged.
 */
export function serveSse(handler: SseHandlerFn, options: SseOptions): RouteHandlerFn {
  return async (req, res, ctx) => {
    const logger = (ctx.logger as Logger | undefined) ?? console
    const stream = new SseStream(req, res, options, logger as Logger)
    try {
      await handler(stream.args(ctx))
    } catch (err) {
      stream.close()
      await stream.done
      throw err
    }
    // Keep the connection open even for a handler that returned after wiring up
    // subscriptions; make sure headers are out so heartbeats and disconnect
    // detection are live.
    stream.begin()
    await stream.done
  }
}
