import type { ServerResponse } from "node:http"
import { serializeCookie, type CookieOptions } from "./cookies.js"

const MIME_SHORTHAND: Record<string, string> = {
  json: "application/json; charset=utf-8",
  html: "text/html; charset=utf-8",
  text: "text/plain; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  bin: "application/octet-stream",
  octet: "application/octet-stream",
}

type HeaderValue = string | string[] | number

export interface ResponseCheckpoint {
  statusCode: number
  headers: Map<string, string | string[] | number>
  typeExplicit: boolean
  sent: boolean
}

export interface ResponseDelta {
  statusCode?: number
  headers: Array<[string, string | string[] | number]>
  removedHeaders?: string[]
  typeExplicit?: boolean
  body?: Buffer
  sent?: boolean
}

/**
 * The response object handed to route handlers and middlewares.
 *
 * Handlers usually just return a value and let the JSON middleware do the
 * writing; this class is for the cases that need explicit control.
 */
export class CloveResponse {
  readonly #raw: ServerResponse

  /** True once a body has been written through this wrapper or the raw stream. */
  #sent = false
  /** True when the handler set a content type itself, whatever it was. */
  #typeExplicit = false
  #buffered: boolean
  #rawAccessed = false
  #statusCode: number
  #headers = new Map<string, HeaderValue>()
  #body?: Buffer

  constructor(raw: ServerResponse, options: { buffered?: boolean } = {}) {
    this.#raw = raw
    this.#buffered = options.buffered ?? false
    this.#statusCode = raw.statusCode
    if (this.#buffered) {
      for (const [name, value] of Object.entries(raw.getHeaders())) {
        if (value !== undefined) {
          this.#headers.set(name.toLowerCase(), cloneHeader(value as HeaderValue))
        }
      }
    }
  }

  /**
   * The underlying Node response. Reading it opts out of buffering and caching,
   * because writes made through the raw stream cannot be replayed safely.
   */
  get raw(): ServerResponse {
    if (this.#buffered && !this.#rawAccessed) {
      this.#rawAccessed = true
      this.#flushHeaders()
      if (this.#sent && !this.#raw.writableEnded) this.#raw.end(this.#body)
    }
    return this.#raw
  }

  /** False after the raw Node response has been accessed. */
  get replayable(): boolean {
    return this.#buffered && !this.#rawAccessed
  }

  get sent(): boolean {
    if (this.#buffered && !this.#rawAccessed) return this.#sent
    return this.#sent || this.#raw.writableEnded || this.#raw.headersSent
  }

  /** Whether the handler chose the content type rather than inheriting it. */
  get typeIsExplicit(): boolean {
    return this.#typeExplicit
  }

  get statusCode(): number {
    return this.#buffered && !this.#rawAccessed ? this.#statusCode : this.#raw.statusCode
  }

  status(code: number): this {
    if (this.#buffered && !this.#rawAccessed) this.#statusCode = code
    else this.#raw.statusCode = code
    return this
  }

  /**
   * Sets the `Content-Type`. Accepts either a full MIME type or one of the
   * shorthands (`"html"`, `"json"`, `"text"`, ...).
   *
   * Setting a non-JSON type disables the built-in JSON middleware.
   */
  type(value: string): this {
    const resolved = MIME_SHORTHAND[value] ?? value
    this.header("content-type", resolved)
    this.#typeExplicit = true
    return this
  }

  /** The content type currently set on the response, if any. */
  get contentType(): string | undefined {
    const v =
      this.#buffered && !this.#rawAccessed
        ? this.#headers.get("content-type")
        : this.#raw.getHeader("content-type")
    return v === undefined ? undefined : String(v)
  }

  header(name: string, value: string | string[] | number): this {
    if (this.#buffered && !this.#rawAccessed) {
      this.#headers.set(name.toLowerCase(), cloneHeader(value))
    } else {
      this.#raw.setHeader(name, value as never)
    }
    return this
  }

  /** Alias of {@link header}, for readers coming from Express. */
  set(name: string, value: string | string[] | number): this {
    return this.header(name, value)
  }

  removeHeader(name: string): this {
    if (this.#buffered && !this.#rawAccessed) this.#headers.delete(name.toLowerCase())
    else this.#raw.removeHeader(name)
    return this
  }

  getHeader(name: string): string | string[] | number | undefined {
    if (this.#buffered && !this.#rawAccessed) {
      const value = this.#headers.get(name.toLowerCase())
      return value === undefined ? undefined : cloneHeader(value)
    }
    const value = this.#raw.getHeader(name)
    return value === undefined ? undefined : (value as HeaderValue)
  }

  cookie(name: string, value: string, opts: CookieOptions = {}): this {
    const existing = this.getHeader("set-cookie")
    const serialized = serializeCookie(name, value, opts)
    const list = Array.isArray(existing)
      ? [...existing, serialized]
      : existing
        ? [String(existing), serialized]
        : [serialized]
    this.header("set-cookie", list)
    return this
  }

  clearCookie(name: string, opts: CookieOptions = {}): this {
    return this.cookie(name, "", { ...opts, maxAge: 0, expires: new Date(0) })
  }

  redirect(location: string, status = 302): this {
    this.status(status).header("location", location)
    this.end()
    return this
  }

  /**
   * Writes a body and ends the response. Objects are JSON-serialized; strings
   * and buffers are written as-is with a sensible default content type.
   */
  send(body?: unknown): this {
    if (this.sent) return this
    if (body === undefined || body === null) {
      this.end()
      return this
    }
    if (Buffer.isBuffer(body)) {
      if (!this.contentType) this.type("bin")
      this.#sent = true
      if (this.#buffered && !this.#rawAccessed) this.#body = Buffer.from(body)
      else this.#raw.end(body)
      return this
    }
    if (typeof body === "string") {
      if (!this.contentType) this.type("html")
      this.#sent = true
      if (this.#buffered && !this.#rawAccessed) this.#body = Buffer.from(body)
      else this.#raw.end(body)
      return this
    }
    return this.json(body)
  }

  json(body: unknown): this {
    if (this.sent) return this
    if (!this.contentType) this.header("content-type", MIME_SHORTHAND.json!)
    this.#sent = true
    const encoded = Buffer.from(JSON.stringify(body))
    if (this.#buffered && !this.#rawAccessed) this.#body = encoded
    else this.#raw.end(encoded)
    return this
  }

  /** Ends the response with no body. */
  end(): this {
    if (this.sent) return this
    this.#sent = true
    if (!this.#buffered || this.#rawAccessed) this.#raw.end()
    return this
  }

  /** Captures the response state immediately before terminal handler execution. */
  checkpoint(): ResponseCheckpoint {
    return {
      statusCode: this.statusCode,
      headers: new Map(
        [...this.#headers].map(([name, value]) => [name, cloneHeader(value)]),
      ),
      typeExplicit: this.#typeExplicit,
      sent: this.sent,
    }
  }

  /** Returns only mutations made since a checkpoint, suitable for replay. */
  deltaSince(checkpoint: ResponseCheckpoint): ResponseDelta {
    const headers: ResponseDelta["headers"] = []
    for (const [name, value] of this.#headers) {
      if (!headersEqual(checkpoint.headers.get(name), value)) {
        headers.push([name, cloneHeader(value)])
      }
    }
    const removedHeaders = [...checkpoint.headers.keys()].filter(
      (name) => !this.#headers.has(name),
    )
    return {
      ...(this.statusCode !== checkpoint.statusCode ? { statusCode: this.statusCode } : {}),
      headers,
      ...(removedHeaders.length ? { removedHeaders } : {}),
      ...(this.#typeExplicit !== checkpoint.typeExplicit
        ? { typeExplicit: this.#typeExplicit }
        : {}),
      ...(!checkpoint.sent && this.#sent
        ? { sent: true, ...(this.#body ? { body: Buffer.from(this.#body) } : {}) }
        : {}),
    }
  }

  /** Applies mutations captured from an earlier terminal handler execution. */
  applyDelta(delta: ResponseDelta): void {
    if (!this.replayable) return
    if (delta.statusCode !== undefined) this.#statusCode = delta.statusCode
    for (const [name, value] of delta.headers) {
      this.#headers.set(name, cloneHeader(value))
    }
    for (const name of delta.removedHeaders ?? []) this.#headers.delete(name)
    if (delta.typeExplicit !== undefined) this.#typeExplicit = delta.typeExplicit
    if (delta.sent) {
      this.#sent = true
      this.#body = delta.body ? Buffer.from(delta.body) : undefined
    }
  }

  /** The finalized buffered body, used for ETag generation. */
  bodyBuffer(): Buffer | undefined {
    return this.#body ? Buffer.from(this.#body) : undefined
  }

  /** Replaces a buffered response with an empty conditional response. */
  notModified(): void {
    if (!this.replayable) return
    this.#statusCode = 304
    this.#body = undefined
    this.#sent = true
    this.#headers.delete("content-length")
  }

  /** Writes a buffered response to the underlying Node response exactly once. */
  commit(options: { omitBody?: boolean } = {}): void {
    if (!this.#buffered || this.#rawAccessed || this.#raw.writableEnded) return
    this.#flushHeaders()
    this.#raw.end(options.omitBody ? undefined : this.#body)
  }

  #flushHeaders(): void {
    this.#raw.statusCode = this.#statusCode
    for (const [name, value] of this.#headers) {
      this.#raw.setHeader(name, value as never)
    }
  }
}

function cloneHeader<T extends HeaderValue>(value: T): T {
  return (Array.isArray(value) ? [...value] : value) as T
}

function headersEqual(a: HeaderValue | undefined, b: HeaderValue): boolean {
  if (a === undefined) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    return JSON.stringify(a) === JSON.stringify(b)
  }
  return String(a) === String(b)
}
