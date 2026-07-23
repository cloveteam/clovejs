import type { ResponseDelta } from "../http/response.js"

/** A serialized terminal-handler outcome. */
export interface CacheEntry {
  payload: Buffer
  response: ResponseDelta
  freshUntil: number
  staleUntil: number
}

export interface CacheStoreSetOptions {
  /** Total storage lifetime, including any stale window. */
  ttl: number
  tags: readonly string[]
}

/**
 * Persistence seam for route cache entries. Define `services/cacheStore.ts`
 * with this shape to replace the default in-process store.
 */
export interface CacheStore {
  get(key: string): Promise<CacheEntry | undefined>
  set(key: string, entry: CacheEntry, options: CacheStoreSetOptions): Promise<void>
  delete(key: string): Promise<void>
  invalidateTags(tags: readonly string[]): Promise<void>
}

interface MemoryEntry {
  value: CacheEntry
  expiresAt: number
  tags: Set<string>
}

/** In-process cache store for development and single-process deployments. */
export class MemoryCacheStore implements CacheStore {
  #entries = new Map<string, MemoryEntry>()
  #tagKeys = new Map<string, Set<string>>()

  async get(key: string): Promise<CacheEntry | undefined> {
    const entry = this.#entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= Date.now()) {
      this.#drop(key, entry)
      return undefined
    }
    return cloneEntry(entry.value)
  }

  async set(
    key: string,
    value: CacheEntry,
    options: CacheStoreSetOptions,
  ): Promise<void> {
    const previous = this.#entries.get(key)
    if (previous) this.#drop(key, previous)

    const tags = new Set(options.tags)
    const entry: MemoryEntry = {
      value: cloneEntry(value),
      expiresAt: Date.now() + options.ttl,
      tags,
    }
    this.#entries.set(key, entry)

    for (const tag of tags) {
      let keys = this.#tagKeys.get(tag)
      if (!keys) {
        keys = new Set()
        this.#tagKeys.set(tag, keys)
      }
      keys.add(key)
    }
  }

  async delete(key: string): Promise<void> {
    const entry = this.#entries.get(key)
    if (entry) this.#drop(key, entry)
  }

  async invalidateTags(tags: readonly string[]): Promise<void> {
    const keys = new Set<string>()
    for (const tag of tags) {
      for (const key of this.#tagKeys.get(tag) ?? []) keys.add(key)
    }
    for (const key of keys) {
      const entry = this.#entries.get(key)
      if (entry) this.#drop(key, entry)
    }
  }

  clear(): void {
    this.#entries.clear()
    this.#tagKeys.clear()
  }

  get size(): number {
    return this.#entries.size
  }

  #drop(key: string, entry: MemoryEntry): void {
    this.#entries.delete(key)
    for (const tag of entry.tags) {
      const keys = this.#tagKeys.get(tag)
      keys?.delete(key)
      if (keys?.size === 0) this.#tagKeys.delete(tag)
    }
  }
}

export function isCacheStore(value: unknown): value is CacheStore {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.get === "function" &&
    typeof v.set === "function" &&
    typeof v.delete === "function" &&
    typeof v.invalidateTags === "function"
  )
}

function cloneEntry(entry: CacheEntry): CacheEntry {
  return {
    payload: Buffer.from(entry.payload),
    response: {
      ...entry.response,
      headers: entry.response.headers.map(([name, value]) => [
        name,
        Array.isArray(value) ? [...value] : value,
      ]),
      ...(entry.response.removedHeaders
        ? { removedHeaders: [...entry.response.removedHeaders] }
        : {}),
      ...(entry.response.body
        ? { body: Buffer.from(entry.response.body) }
        : {}),
    },
    freshUntil: entry.freshUntil,
    staleUntil: entry.staleUntil,
  }
}
