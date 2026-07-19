import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { bootstrap, type Clove, type BootstrapOptions } from "../../src/index.js"

const here = dirname(fileURLToPath(import.meta.url))

export function fixturePath(name: string): string {
  return join(here, "..", "fixtures", name)
}

/** Boots a fixture project on an ephemeral port. */
export async function startFixture(
  name: string,
  options: BootstrapOptions = {},
): Promise<Clove> {
  return bootstrap({
    rootDir: fixturePath(name),
    port: 0,
    host: "127.0.0.1",
    logLevel: "silent",
    handleSignals: false,
    sessionSecret: "test-secret",
    ...options,
  })
}

export interface Fetched {
  status: number
  headers: Headers
  text: string
  json: any
  cookies: string[]
}

/** A fetch wrapper that keeps cookies so session behaviour can be exercised. */
export class Client {
  #base: string
  #jar = new Map<string, string>()

  constructor(base: string) {
    this.#base = base
  }

  get cookieHeader(): string {
    return [...this.#jar].map(([k, v]) => `${k}=${v}`).join("; ")
  }

  setCookie(name: string, value: string): void {
    this.#jar.set(name, value)
  }

  clearCookies(): void {
    this.#jar.clear()
  }

  async request(path: string, init: RequestInit = {}): Promise<Fetched> {
    const headers = new Headers(init.headers)
    if (this.#jar.size > 0) headers.set("cookie", this.cookieHeader)
    if (init.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json")
    }

    const res = await fetch(this.#base + path, { ...init, headers, redirect: "manual" })
    const cookies = res.headers.getSetCookie?.() ?? []
    for (const cookie of cookies) {
      const [pair] = cookie.split(";")
      const eq = pair!.indexOf("=")
      if (eq > 0) this.#jar.set(pair!.slice(0, eq).trim(), pair!.slice(eq + 1).trim())
    }

    const text = await res.text()
    let json: any = undefined
    try {
      json = text ? JSON.parse(text) : undefined
    } catch {
      /* not json */
    }
    return { status: res.status, headers: res.headers, text, json, cookies }
  }

  get = (path: string, init?: RequestInit) =>
    this.request(path, { ...init, method: "GET" })

  post = (path: string, body?: unknown, init?: RequestInit) =>
    this.request(path, {
      ...init,
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    })
}
