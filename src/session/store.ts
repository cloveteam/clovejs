/**
 * Persistence for session-scoped values.
 *
 * Projects override the default by defining `services/sessionStore.ts` that
 * returns an object with this shape — no config wiring needed, the key is
 * picked up like any other service.
 */
export interface SessionStore {
  get(id: string): Promise<Record<string, unknown> | undefined>
  set(id: string, data: Record<string, unknown>): Promise<void>
  /** Extends the TTL without rewriting the data. */
  touch(id: string): Promise<void>
  destroy(id: string): Promise<void>
}

export interface MemorySessionStoreOptions {
  /** Idle lifetime in milliseconds. Defaults to 24 hours. */
  ttl?: number
  /** Invoked when a session is dropped, so its container can be disposed. */
  onExpire?: (id: string) => void | Promise<void>
}

interface Entry {
  data: Record<string, unknown>
  expiresAt: number
}

/**
 * The default in-process store: a Map with sliding expiry.
 *
 * Fine for a single process; swap it for a Redis-backed store before scaling
 * horizontally.
 */
export class MemorySessionStore implements SessionStore {
  #entries = new Map<string, Entry>()
  #ttl: number
  #onExpire?: (id: string) => void | Promise<void>
  #timer?: NodeJS.Timeout

  constructor(options: MemorySessionStoreOptions = {}) {
    this.#ttl = options.ttl ?? 24 * 60 * 60 * 1000
    this.#onExpire = options.onExpire
    this.#timer = setInterval(() => void this.#sweep(), 60_000)
    this.#timer.unref?.()
  }

  async get(id: string): Promise<Record<string, unknown> | undefined> {
    const entry = this.#entries.get(id)
    if (!entry) return undefined
    if (entry.expiresAt <= Date.now()) {
      this.#entries.delete(id)
      await this.#onExpire?.(id)
      return undefined
    }
    return entry.data
  }

  async set(id: string, data: Record<string, unknown>): Promise<void> {
    this.#entries.set(id, { data, expiresAt: Date.now() + this.#ttl })
  }

  async touch(id: string): Promise<void> {
    const entry = this.#entries.get(id)
    if (entry) entry.expiresAt = Date.now() + this.#ttl
  }

  async destroy(id: string): Promise<void> {
    this.#entries.delete(id)
  }

  async #sweep(): Promise<void> {
    const now = Date.now()
    for (const [id, entry] of this.#entries) {
      if (entry.expiresAt <= now) {
        this.#entries.delete(id)
        await this.#onExpire?.(id)
      }
    }
  }

  /** Stops the sweep timer. Called on server shutdown. */
  close(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = undefined
  }

  get size(): number {
    return this.#entries.size
  }
}

export function isSessionStore(value: unknown): value is SessionStore {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.get === "function" &&
    typeof v.set === "function" &&
    typeof v.touch === "function" &&
    typeof v.destroy === "function"
  )
}
