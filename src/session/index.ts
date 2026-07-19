import { randomBytes } from "node:crypto"
import type { Container } from "../container/container.js"
import type { Registry } from "../container/registry.js"
import { sign, unsign, type CookieOptions } from "../http/cookies.js"
import type { CloveRequest } from "../http/request.js"
import type { CloveResponse } from "../http/response.js"
import { MemorySessionStore, type SessionStore } from "./store.js"

export const SESSION_COOKIE = "clove.sid"

export interface SessionOptions {
  secret: string
  cookieName?: string
  cookie?: CookieOptions
  store?: SessionStore
  ttl?: number
}

/**
 * Maps session ids to live session containers and keeps their contents in the
 * store, so session-scoped `di` values survive across requests.
 */
export class SessionManager {
  readonly store: SessionStore
  readonly cookieName: string
  #root: Container
  #registry: Registry
  #secret: string
  #cookieOptions: CookieOptions
  #containers = new Map<string, Container>()

  constructor(root: Container, registry: Registry, options: SessionOptions) {
    this.#root = root
    this.#registry = registry
    this.#secret = options.secret
    this.cookieName = options.cookieName ?? SESSION_COOKIE
    this.#cookieOptions = {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      ...options.cookie,
    }
    this.store =
      options.store ??
      new MemorySessionStore({
        ttl: options.ttl,
        onExpire: (id) => this.#disposeContainer(id),
      })
  }

  /** True when the project declares at least one session-scoped provider. */
  get needed(): boolean {
    return this.#registry.byLifetime("session").length > 0
  }

  /**
   * Resolves the session container for a request, creating one (and issuing a
   * cookie) only when the request actually carries or needs a session.
   */
  async acquire(
    req: CloveRequest,
    res: CloveResponse,
  ): Promise<{ container: Container; id: string; isNew: boolean }> {
    const raw = req.cookie[this.cookieName]
    const existingId = raw ? unsign(raw, this.#secret) : null

    if (existingId) {
      const cached = this.#containers.get(existingId)
      if (cached && !cached.disposed) {
        await this.store.touch(existingId)
        return { container: cached, id: existingId, isNew: false }
      }
      const stored = await this.store.get(existingId)
      if (stored) {
        const container = this.#root.createChild("session")
        for (const [key, value] of Object.entries(stored)) container.set(key, value)
        this.#containers.set(existingId, container)
        return { container, id: existingId, isNew: false }
      }
    }

    const id = randomBytes(24).toString("base64url")
    const container = this.#root.createChild("session")
    this.#containers.set(id, container)
    await this.store.set(id, {})
    res.cookie(this.cookieName, sign(id, this.#secret), this.#cookieOptions)
    return { container, id, isNew: true }
  }

  /** Writes the session container's session-scoped values back to the store. */
  async persist(id: string, container: Container): Promise<void> {
    const data: Record<string, unknown> = {}
    for (const provider of this.#registry.byLifetime("session")) {
      if (container.isResolved(provider.key)) {
        data[provider.key] = container.get(provider.key)
      }
    }
    await this.store.set(id, data)
  }

  async destroy(id: string): Promise<void> {
    await this.store.destroy(id)
    await this.#disposeContainer(id)
  }

  async #disposeContainer(id: string): Promise<void> {
    const container = this.#containers.get(id)
    this.#containers.delete(id)
    if (container) await container.dispose()
  }

  /** Disposes every live session. Called during server shutdown. */
  async disposeAll(): Promise<void> {
    const ids = [...this.#containers.keys()]
    await Promise.all(ids.map((id) => this.#disposeContainer(id)))
    if (this.store instanceof MemorySessionStore) this.store.close()
  }
}

export * from "./store.js"
