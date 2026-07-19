import type { HttpMethod } from "../types.js"
import { stripExtension } from "./walk.js"

const METHODS = new Set<string>([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "all",
])

export interface DerivedRoutePath {
  /** URL path, e.g. `/api/v1/users/[id]`. Parameter segments keep brackets. */
  path: string
  /** Method named by the filename, or null when the file omits the suffix. */
  method: HttpMethod | "ALL" | null
}

/**
 * Derives a URL path from a file path relative to the source root.
 *
 * ```
 * api/v1/users.get.ts        -> GET  /api/v1/users
 * api/v1/users/get.ts        -> GET  /api/v1/users
 * api/v1/users/[id].get.ts   -> GET  /api/v1/users/[id]
 * api/v1/users/[id]/get.ts   -> GET  /api/v1/users/[id]
 * api/v1/login.post.ts       -> POST /api/v1/login
 * api/v1/health.ts           -> (method from the wrapper) /api/v1/health
 * ```
 *
 * An `index` segment is dropped, so `api/users/index.get.ts` and
 * `api/users/get.ts` resolve to the same path.
 */
export function deriveRoutePath(relativePath: string): DerivedRoutePath {
  const withoutExt = stripExtension(relativePath)
  const segments = withoutExt.split("/").filter(Boolean)
  let method: HttpMethod | "ALL" | null = null

  const last = segments[segments.length - 1]
  if (last !== undefined) {
    // `.../get.ts` — the whole filename is the method name.
    if (METHODS.has(last.toLowerCase())) {
      method = normalizeMethod(last)
      segments.pop()
    } else {
      // `.../users.get.ts` — the method is a dotted suffix on the filename.
      const dot = last.lastIndexOf(".")
      if (dot > 0) {
        const suffix = last.slice(dot + 1).toLowerCase()
        if (METHODS.has(suffix)) {
          method = normalizeMethod(suffix)
          segments[segments.length - 1] = last.slice(0, dot)
        }
      }
    }
  }

  const tail = segments[segments.length - 1]
  if (tail === "index") segments.pop()

  return { path: "/" + segments.join("/"), method }
}

/** Same derivation, minus the method suffix handling. Used for `ws/`. */
export function deriveSocketPath(relativePath: string): string {
  const segments = stripExtension(relativePath).split("/").filter(Boolean)
  if (segments[segments.length - 1] === "index") segments.pop()
  return "/" + segments.join("/")
}

function normalizeMethod(name: string): HttpMethod | "ALL" {
  const upper = name.toUpperCase()
  return upper === "ALL" ? "ALL" : (upper as HttpMethod)
}

/**
 * Parses a middleware ordering prefix from a filename.
 *
 * `authenticate.1.ts` -> [1], `audit.1.2.ts` -> [1, 2], `authorize.ts` -> null.
 * A null priority sorts after every numbered middleware.
 */
export function parsePriority(relativePath: string): number[] | null {
  const base = stripExtension(relativePath).split("/").pop() ?? ""
  const parts = base.split(".")
  if (parts.length < 2) return null

  const numbers: number[] = []
  for (let i = parts.length - 1; i >= 1; i--) {
    const part = parts[i]!
    if (!/^\d+$/.test(part)) break
    numbers.unshift(Number(part))
  }
  return numbers.length > 0 ? numbers : null
}

/** The middleware name with any priority suffix removed. */
export function stripPriority(relativePath: string): string {
  const withoutExt = stripExtension(relativePath)
  const parts = withoutExt.split(".")
  let end = parts.length
  for (let i = parts.length - 1; i >= 1; i--) {
    if (!/^\d+$/.test(parts[i]!)) break
    end = i
  }
  return parts.slice(0, end).join(".")
}

/**
 * Orders middlewares: numbered ones first, ascending and element-wise (so
 * `1` < `1.2` < `2`), then unnumbered ones alphabetically.
 */
export function comparePriority(
  a: { priority: number[] | null; name: string },
  b: { priority: number[] | null; name: string },
): number {
  if (a.priority && b.priority) {
    const len = Math.max(a.priority.length, b.priority.length)
    for (let i = 0; i < len; i++) {
      const av = a.priority[i]
      const bv = b.priority[i]
      // A shorter prefix runs first: `.1` before `.1.2`.
      if (av === undefined) return -1
      if (bv === undefined) return 1
      if (av !== bv) return av - bv
    }
    return a.name.localeCompare(b.name)
  }
  if (a.priority) return -1
  if (b.priority) return 1
  return a.name.localeCompare(b.name)
}

/** Derives a `ctx` key from a `services/` or `di/` file path. */
export function deriveContextKey(relativePath: string): string {
  const segments = stripExtension(relativePath).split("/").filter(Boolean)
  if (segments[segments.length - 1] === "index" && segments.length > 1) segments.pop()
  // Nested files flatten with camelCase: `db/pool.ts` -> `dbPool`.
  return segments
    .map((s, i) => (i === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1)))
    .join("")
}
