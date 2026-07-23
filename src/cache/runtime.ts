import { createHash } from "node:crypto"
import { deserialize, serialize } from "node:v8"
import type { Logger } from "../container/logger.js"
import type { CloveRequest } from "../http/request.js"
import {
  CloveResponse,
  type ResponseDelta,
} from "../http/response.js"
import {
  VIEW,
  isViewResult,
  type CacheContext,
  type CacheDuration,
  type CacheInvalidation,
  type CachePolicy,
  type Route,
  type RuntimeCtx,
} from "../types.js"
import type { CacheEntry, CacheStore } from "./store.js"

interface Deferred {
  promise: Promise<CacheEntry | undefined>
  resolve(value: CacheEntry | undefined): void
}

interface CacheTransaction {
  key: string
  policy: Readonly<CachePolicy>
  context: CacheContext
  result: unknown
  payload: Buffer
  response: ResponseDelta
  deferred: Deferred
  generation: number
}

export interface PipelineCompletion {
  result: unknown
  error?: unknown
  handlerExecuted: boolean
}

/**
 * Coordinates terminal handler caching without bypassing the middleware onion.
 * Every hit replays what the handler returned and changed on the response, then
 * lets outer interceptors continue unwinding normally.
 */
export class CacheRuntime {
  readonly store: CacheStore

  #logger: Logger
  #pending = new Map<string, Deferred>()
  #transactions = new WeakMap<CloveResponse, CacheTransaction>()
  #generation = 0

  constructor(store: CacheStore, logger: Logger) {
    this.store = store
    this.#logger = logger
  }

  async execute(
    route: Route,
    req: CloveRequest,
    res: CloveResponse,
    ctx: RuntimeCtx,
    handler: () => Promise<unknown>,
  ): Promise<unknown> {
    const policy = route.cache
    if (!policy || !this.#canUse(policy, req, res)) return handler()

    const context: CacheContext = { route, req, res, ctx }
    let key: string
    try {
      key = await this.#key(policy, context)
    } catch (err) {
      this.#logger.error("Failed to build route cache key:", err)
      return handler()
    }

    let existing: CacheEntry | undefined
    try {
      existing = await this.store.get(key)
    } catch (err) {
      this.#logger.error("Route cache read failed:", err)
      return handler()
    }

    const now = Date.now()
    if (existing && existing.freshUntil > now) {
      return this.#replay(existing, res)
    }

    const pending = this.#pending.get(key)
    if (pending) {
      if (existing && existing.staleUntil > now) {
        return this.#replay(existing, res)
      }
      const refreshed = await pending.promise
      if (refreshed) return this.#replay(refreshed, res)
      return handler()
    }

    const deferred = createDeferred()
    this.#pending.set(key, deferred)
    const checkpoint = res.checkpoint()

    try {
      const result = await handler()
      let payload: Buffer
      try {
        payload = encodeResult(result)
      } catch {
        // Functions, weak collections and a few host objects cannot cross a
        // process-safe cache boundary. Serve them normally without caching.
        this.#finishPending(key, deferred, undefined)
        return result
      }
      this.#transactions.set(res, {
        key,
        policy,
        context,
        result,
        payload,
        response: res.deltaSince(checkpoint),
        deferred,
        generation: this.#generation,
      })
      return result
    } catch (err) {
      this.#finishPending(key, deferred, undefined)
      throw err
    }
  }

  /**
   * Publishes a captured handler outcome only after every interceptor has
   * unwound successfully and the final response is known to be cacheable.
   */
  async complete(res: CloveResponse, completion: PipelineCompletion): Promise<void> {
    const transaction = this.#transactions.get(res)
    if (!transaction) return
    this.#transactions.delete(res)

    if (
      completion.error !== undefined ||
      res.statusCode !== 200 ||
      !res.replayable ||
      transaction.response.headers.some(([name]) => name === "set-cookie") ||
      transaction.generation !== this.#generation
    ) {
      this.#finishPending(transaction.key, transaction.deferred, undefined)
      return
    }

    try {
      const now = Date.now()
      const ttl = durationMs(transaction.policy.ttl)
      const stale = durationMs(transaction.policy.staleWhileRevalidate ?? 0)
      const tags = await resolveTags(transaction.policy, {
        ...transaction.context,
        result: transaction.result,
      })
      const entry: CacheEntry = {
        payload: transaction.payload,
        response: transaction.response,
        freshUntil: now + ttl,
        staleUntil: now + ttl + stale,
      }
      await this.store.set(transaction.key, entry, {
        ttl: ttl + stale,
        tags,
      })
      this.#finishPending(transaction.key, transaction.deferred, entry)
    } catch (err) {
      this.#logger.error("Route cache write failed:", err)
      this.#finishPending(transaction.key, transaction.deferred, undefined)
    }
  }

  /** Applies browser/CDN headers and conditional request handling. */
  applyClientPolicy(route: Route, req: CloveRequest, res: CloveResponse): void {
    const policy = route.cache
    if (!policy || !res.replayable || res.statusCode !== 200) return

    if (policy.vary?.length) {
      const existing = String(res.getHeader("vary") ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
      const vary = new Set([...existing, ...policy.vary.map((name) => name.toLowerCase())])
      res.header("vary", [...vary].join(", "))
    }

    if (
      req.header("authorization") ||
      req.header("cookie") ||
      res.getHeader("set-cookie") !== undefined
    ) {
      res.header("cache-control", "private, no-store")
      return
    }

    if (policy.client === false) {
      res.header("cache-control", "no-store")
      return
    }

    res.header("cache-control", cacheControl(policy))
    const body = res.bodyBuffer()
    if (!body) return

    const current = res.getHeader("etag")
    const etag =
      current === undefined
        ? `"${createHash("sha256").update(body).digest("base64url")}"`
        : String(current)
    res.header("etag", etag)

    if (etagMatches(req.header("if-none-match"), etag)) res.notModified()
  }

  /** Invalidates tags imperatively through `ctx.cache`. */
  async invalidate(tags: readonly string[]): Promise<void> {
    const clean = uniqueTags(tags)
    if (clean.length === 0) return
    this.#generation++
    await this.store.invalidateTags(clean)
  }

  /** Resolves and applies a mutation route's declarative invalidation. */
  async invalidateRoute(
    invalidation: CacheInvalidation,
    context: CacheContext & { result: unknown },
  ): Promise<void> {
    const tags =
      typeof invalidation === "function"
        ? await invalidation(context)
        : invalidation
    await this.invalidate(tags)
  }

  #canUse(
    policy: Readonly<CachePolicy>,
    req: CloveRequest,
    res: CloveResponse,
  ): boolean {
    if (!res.replayable || res.sent) return false
    // Credentials require an explicit identity component. This prevents a
    // public URL from accidentally sharing one caller's handler result.
    if (
      (req.header("authorization") || req.header("cookie")) &&
      policy.scope !== "public" &&
      !policy.key
    ) {
      return false
    }
    return true
  }

  async #key(policy: Readonly<CachePolicy>, context: CacheContext): Promise<string> {
    const { req, route } = context
    const query = [...req.url.searchParams.entries()]
      .sort(([ak, av], [bk, bv]) => ak.localeCompare(bk) || av.localeCompare(bv))
    const vary = (policy.vary ?? [])
      .map((name) => [name.toLowerCase(), req.header(name) ?? ""])
      .sort(([a], [b]) => a!.localeCompare(b!))
    const custom = policy.key ? await policy.key(context) : ""
    const identity = JSON.stringify({
      method: req.method,
      route: route.path,
      params: Object.entries(req.params).sort(([a], [b]) => a.localeCompare(b)),
      query,
      vary,
      custom,
    })
    return createHash("sha256").update(identity).digest("base64url")
  }

  #replay(entry: CacheEntry, res: CloveResponse): unknown {
    const result = decodeResult(entry.payload)
    res.applyDelta(entry.response)
    return result
  }

  #finishPending(
    key: string,
    deferred: Deferred,
    entry: CacheEntry | undefined,
  ): void {
    if (this.#pending.get(key) === deferred) this.#pending.delete(key)
    deferred.resolve(entry)
  }
}

/** Validates duration and client-policy combinations during project scanning. */
export function validateCachePolicy(policy: Readonly<CachePolicy>): void {
  durationMs(policy.ttl)
  if (policy.scope !== undefined && !["public", "private"].includes(policy.scope)) {
    throw new TypeError(`Cache scope must be "public" or "private".`)
  }
  if (policy.staleWhileRevalidate !== undefined) {
    durationMs(policy.staleWhileRevalidate)
  }
  for (const value of [
    policy.client && policy.client.maxAge,
    policy.client && policy.client.sharedMaxAge,
    policy.client && policy.client.staleWhileRevalidate,
  ]) {
    if (value !== false && value !== undefined) durationMs(value)
  }
  if (policy.client && policy.client.private && policy.client.sharedMaxAge !== undefined) {
    throw new TypeError("A private client cache cannot declare sharedMaxAge.")
  }
}

export function durationMs(value: CacheDuration): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError(`Cache duration must be a non-negative finite number.`)
    }
    return value
  }
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(value)
  if (!match) {
    throw new TypeError(
      `Invalid cache duration "${value}". Use milliseconds or values such as "30s", "5m" or "1h".`,
    )
  }
  const multiplier = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
    match[2] as "ms" | "s" | "m" | "h" | "d"
  ]
  return Number(match[1]) * multiplier
}

function encodeResult(result: unknown): Buffer {
  if (isViewResult(result)) {
    return serialize({ kind: "view", template: result.template, data: result.data })
  }
  return serialize({ kind: "value", value: result })
}

function decodeResult(payload: Buffer): unknown {
  const decoded = deserialize(payload) as
    | { kind: "view"; template: string; data: unknown }
    | { kind: "value"; value: unknown }
  if (decoded.kind === "view") {
    return { [VIEW]: true, template: decoded.template, data: decoded.data }
  }
  return decoded.value
}

async function resolveTags(
  policy: Readonly<CachePolicy>,
  context: CacheContext & { result: unknown },
): Promise<string[]> {
  if (!policy.tags) return []
  const tags =
    typeof policy.tags === "function" ? await policy.tags(context) : policy.tags
  return uniqueTags(tags)
}

function uniqueTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))]
}

function cacheControl(policy: Readonly<CachePolicy>): string {
  const client = policy.client
  if (!client) return "private, no-cache"

  const isPrivate = client.private ?? client.sharedMaxAge === undefined
  const parts = [isPrivate ? "private" : "public"]
  if (client.maxAge !== undefined) {
    parts.push(`max-age=${Math.floor(durationMs(client.maxAge) / 1_000)}`)
  } else {
    parts.push("max-age=0")
  }
  if (client.sharedMaxAge !== undefined) {
    parts.push(`s-maxage=${Math.floor(durationMs(client.sharedMaxAge) / 1_000)}`)
  }
  if (client.staleWhileRevalidate !== undefined) {
    parts.push(
      `stale-while-revalidate=${Math.floor(
        durationMs(client.staleWhileRevalidate) / 1_000,
      )}`,
    )
  }
  if (client.immutable) parts.push("immutable")
  return parts.join(", ")
}

function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false
  const target = etag.replace(/^W\//, "")
  return header.split(",").some((candidate) => {
    const value = candidate.trim()
    return value === "*" || value.replace(/^W\//, "") === target
  })
}

function createDeferred(): Deferred {
  let resolve!: (entry: CacheEntry | undefined) => void
  const promise = new Promise<CacheEntry | undefined>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
