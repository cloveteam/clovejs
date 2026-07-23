import { Readable } from "node:stream"
import type { IncomingMessage, ServerResponse } from "node:http"

/** The response the test client hands back, matching a `fetch` result's shape. */
export interface TestResponse {
  status: number
  headers: Headers
  text: string
  /** The body parsed as JSON, or `undefined` when it was not JSON. */
  json: any
  /** Raw `Set-Cookie` header values, one per cookie. */
  cookies: string[]
}

export interface MockRequestInit {
  method: string
  url: string
  headers: Record<string, string>
  body?: Buffer | undefined
}

/**
 * A readable stand-in for `IncomingMessage`. It carries the method, url and
 * headers the request path reads, and streams the body the same way a socket
 * would, so `parseBody` consumes it unchanged.
 */
export class MockRequest extends Readable {
  method: string
  url: string
  headers: Record<string, string>
  socket = { remoteAddress: "127.0.0.1" } as IncomingMessage["socket"]

  constructor({ method, url, headers, body }: MockRequestInit) {
    super()
    this.method = method
    this.url = url
    this.headers = headers
    if (body && body.length) this.push(body)
    this.push(null)
  }

  _read(): void {
    /* body is pushed up front */
  }
}

/**
 * Captures everything written to a `ServerResponse` in memory. It implements
 * exactly the surface the response path touches — status, headers and the
 * terminal `end` — and resolves {@link whenEnded} once the response is closed.
 */
export class MockResponse {
  statusCode = 200
  headersSent = false

  #headers = new Map<string, string | string[]>()
  #chunks: Buffer[] = []
  #ended = false
  #resolveEnded!: () => void

  /** Resolves when the response has been fully written. */
  readonly whenEnded: Promise<void>

  constructor() {
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

  getHeaders(): Record<string, string | string[]> {
    return Object.fromEntries(this.#headers)
  }

  writeHead(
    statusCode: number,
    reasonOrHeaders?: string | Record<string, string | string[] | number>,
    maybeHeaders?: Record<string, string | string[] | number>,
  ): this {
    this.statusCode = statusCode
    const headers = typeof reasonOrHeaders === "object" ? reasonOrHeaders : maybeHeaders
    if (headers) {
      for (const [key, value] of Object.entries(headers)) this.setHeader(key, value)
    }
    this.headersSent = true
    return this
  }

  write(chunk: string | Buffer): boolean {
    this.#chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
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

  /** The Set-Cookie header split into one string per cookie. */
  setCookies(): string[] {
    const raw = this.#headers.get("set-cookie")
    if (raw === undefined) return []
    return Array.isArray(raw) ? raw : [raw]
  }

  /** The buffered body as a UTF-8 string. */
  bodyText(): string {
    return Buffer.concat(this.#chunks).toString("utf8")
  }

  headerEntries(): Array<[string, string | string[]]> {
    return [...this.#headers]
  }
}

/** Reads a finished {@link MockResponse} into the client-facing result. */
export function readResponse(res: MockResponse): TestResponse {
  const headers = new Headers()
  for (const [key, value] of res.headerEntries()) {
    if (key === "set-cookie") continue // carried separately, not merged
    if (Array.isArray(value)) for (const item of value) headers.append(key, item)
    else headers.set(key, value)
  }

  const text = res.bodyText()
  let json: any
  try {
    json = text ? JSON.parse(text) : undefined
  } catch {
    /* not json */
  }

  return { status: res.statusCode, headers, text, json, cookies: res.setCookies() }
}

/** A node `request` listener, as exposed by `CloveApp.listener`. */
export type Listener = (req: IncomingMessage, res: ServerResponse) => void
