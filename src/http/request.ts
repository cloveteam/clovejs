import type { IncomingMessage } from "node:http"
import { DEFAULT_BODY_LIMIT, parseBody, readRawBody } from "./body.js"
import { parseCookies } from "./cookies.js"

/**
 * The request object handed to route handlers and middlewares.
 *
 * Wraps `IncomingMessage` rather than extending it, so the surface stays small
 * and predictable. The raw node request is available as `req.raw`.
 */
export class CloveRequest {
  readonly raw: IncomingMessage
  readonly method: string
  readonly path: string
  readonly query: Record<string, string>
  /** Route parameters, e.g. `{ id: "1" }` for `api/users/[id].get.ts`. */
  params: Record<string, string> = {}

  #url: URL
  #cookies?: Record<string, string>
  #body?: unknown
  #bodyRead = false
  #bodyLimit: number

  constructor(raw: IncomingMessage, bodyLimit = DEFAULT_BODY_LIMIT) {
    this.raw = raw
    this.method = (raw.method ?? "GET").toUpperCase()
    this.#bodyLimit = bodyLimit
    const host = raw.headers.host ?? "localhost"
    const proto = (raw.headers["x-forwarded-proto"] as string | undefined) ?? "http"
    this.#url = new URL(raw.url ?? "/", `${proto}://${host}`)
    this.path = this.#url.pathname
    this.query = Object.fromEntries(this.#url.searchParams)
  }

  get url(): URL {
    return this.#url
  }

  get headers(): NodeJS.Dict<string | string[]> {
    return this.raw.headers
  }

  header(name: string): string | undefined {
    const v = this.raw.headers[name.toLowerCase()]
    return Array.isArray(v) ? v[0] : v
  }

  /** Parsed request cookies, keyed by name. */
  get cookie(): Record<string, string> {
    this.#cookies ??= parseCookies(this.raw.headers.cookie)
    return this.#cookies
  }

  /** Alias of {@link cookie}, for readers who expect the plural. */
  get cookies(): Record<string, string> {
    return this.cookie
  }

  /**
   * The parsed body. Populated by the pipeline before handlers run, so it is
   * safe to access synchronously as `req.body`.
   */
  get body(): any {
    return this.#body
  }

  set body(value: any) {
    this.#body = value
    this.#bodyRead = true
  }

  /** Reads and parses the body if it has not been consumed yet. */
  async readBody(): Promise<unknown> {
    if (this.#bodyRead) return this.#body
    this.#bodyRead = true
    this.#body = await parseBody(this.raw, this.#bodyLimit)
    return this.#body
  }

  /** Reads the untouched body bytes. Only valid if the body was not parsed. */
  async rawBody(): Promise<Buffer> {
    return readRawBody(this.raw, this.#bodyLimit)
  }

  get ip(): string | undefined {
    const fwd = this.header("x-forwarded-for")
    if (fwd) return fwd.split(",")[0]?.trim()
    return this.raw.socket?.remoteAddress
  }
}
