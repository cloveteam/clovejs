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

/**
 * The response object handed to route handlers and middlewares.
 *
 * Handlers usually just return a value and let the JSON middleware do the
 * writing; this class is for the cases that need explicit control.
 */
export class CloveResponse {
  readonly raw: ServerResponse

  /** True once a body has been written through this wrapper or the raw stream. */
  #sent = false
  /** True when the handler set a content type itself, whatever it was. */
  #typeExplicit = false

  constructor(raw: ServerResponse) {
    this.raw = raw
  }

  get sent(): boolean {
    return this.#sent || this.raw.writableEnded || this.raw.headersSent
  }

  /** Whether the handler chose the content type rather than inheriting it. */
  get typeIsExplicit(): boolean {
    return this.#typeExplicit
  }

  get statusCode(): number {
    return this.raw.statusCode
  }

  status(code: number): this {
    this.raw.statusCode = code
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
    this.raw.setHeader("content-type", resolved)
    this.#typeExplicit = true
    return this
  }

  /** The content type currently set on the response, if any. */
  get contentType(): string | undefined {
    const v = this.raw.getHeader("content-type")
    return v === undefined ? undefined : String(v)
  }

  header(name: string, value: string | string[] | number): this {
    this.raw.setHeader(name, value as never)
    return this
  }

  /** Alias of {@link header}, for readers coming from Express. */
  set(name: string, value: string | string[] | number): this {
    return this.header(name, value)
  }

  cookie(name: string, value: string, opts: CookieOptions = {}): this {
    const existing = this.raw.getHeader("set-cookie")
    const serialized = serializeCookie(name, value, opts)
    const list = Array.isArray(existing)
      ? [...existing, serialized]
      : existing
        ? [String(existing), serialized]
        : [serialized]
    this.raw.setHeader("set-cookie", list)
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
      this.raw.end(body)
      return this
    }
    if (typeof body === "string") {
      if (!this.contentType) this.type("html")
      this.#sent = true
      this.raw.end(body)
      return this
    }
    return this.json(body)
  }

  json(body: unknown): this {
    if (this.sent) return this
    if (!this.contentType) this.raw.setHeader("content-type", MIME_SHORTHAND.json!)
    this.#sent = true
    this.raw.end(JSON.stringify(body))
    return this
  }

  /** Ends the response with no body. */
  end(): this {
    if (this.sent) return this
    this.#sent = true
    this.raw.end()
    return this
  }
}
