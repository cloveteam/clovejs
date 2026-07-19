import { CloveBootError } from "../errors.js"
import type { HttpMethod, Route } from "../types.js"

interface Node {
  /** Literal path segments. */
  static: Map<string, Node>
  /** Single `[param]` child, if any. Static children win over this one. */
  param?: { name: string; node: Node; file: string }
  /** Routes terminating at this node, keyed by method. */
  routes: Map<string, Route>
}

function createNode(): Node {
  return { static: new Map(), routes: new Map() }
}

export interface MatchResult {
  route: Route
  params: Record<string, string>
}

/**
 * A prefix-tree router over `/`-separated segments.
 *
 * Matching is deterministic: at each segment a literal match is preferred over
 * a `[param]` match, so `api/users/me.get.ts` beats `api/users/[id].get.ts`.
 */
export class RouterTrie {
  #root = createNode()

  add(route: Route): void {
    const segments = splitPath(route.path)
    let node = this.#root

    for (const segment of segments) {
      const paramName = paramNameOf(segment)
      if (paramName !== null) {
        if (node.param && node.param.name !== paramName) {
          throw new CloveBootError(
            `Route parameter name conflict: the same path position is named ` +
              `"${node.param.name}" in one file and "${paramName}" in another. ` +
              `Rename one so they agree.`,
            [node.param.file, route.file],
          )
        }
        node.param ??= { name: paramName, node: createNode(), file: route.file }
        node = node.param.node
      } else {
        let next = node.static.get(segment)
        if (!next) {
          next = createNode()
          node.static.set(segment, next)
        }
        node = next
      }
    }

    const existing = node.routes.get(route.method)
    if (existing) {
      throw new CloveBootError(
        `Duplicate route: ${route.method} ${route.path || "/"} is defined twice.`,
        [existing.file, route.file],
      )
    }
    node.routes.set(route.method, route)
  }

  match(method: string, path: string): MatchResult | null {
    const segments = splitPath(path)
    const params: Record<string, string> = {}
    const node = this.#walk(this.#root, segments, 0, params, method)
    if (!node) return null
    const route = node.routes.get(method) ?? node.routes.get("ALL")
    if (!route) return null
    return { route, params }
  }

  /** True when the path exists under some other method — used for 405s. */
  hasPath(path: string): boolean {
    const params: Record<string, string> = {}
    const node = this.#walk(this.#root, splitPath(path), 0, params, null)
    return node !== null && node.routes.size > 0
  }

  /**
   * Depth-first walk that backtracks: if the static branch matches the segment
   * but dead-ends further down, the param branch still gets a chance.
   */
  #walk(
    node: Node,
    segments: string[],
    index: number,
    params: Record<string, string>,
    method: string | null,
  ): Node | null {
    if (index === segments.length) {
      if (node.routes.size === 0) return null
      if (method === null) return node
      return node.routes.has(method) || node.routes.has("ALL") ? node : null
    }

    const segment = segments[index]!

    const staticChild = node.static.get(segment)
    if (staticChild) {
      const found = this.#walk(staticChild, segments, index + 1, params, method)
      if (found) return found
    }

    if (node.param) {
      const found = this.#walk(node.param.node, segments, index + 1, params, method)
      if (found) {
        params[node.param.name] = safeDecode(segment)
        return found
      }
    }

    return null
  }

  /** Every registered route, for diagnostics and the dev-server route list. */
  list(): Route[] {
    const out: Route[] = []
    const visit = (node: Node) => {
      for (const route of node.routes.values()) out.push(route)
      for (const child of node.static.values()) visit(child)
      if (node.param) visit(node.param.node)
    }
    visit(this.#root)
    return out.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))
  }
}

export function splitPath(path: string): string[] {
  const clean = path.split("?")[0]!
  const parts: string[] = []
  for (const segment of clean.split("/")) {
    if (segment !== "") parts.push(segment)
  }
  return parts
}

/** Returns the parameter name for a `[name]` segment, or null if it is static. */
export function paramNameOf(segment: string): string | null {
  if (segment.length > 2 && segment.startsWith("[") && segment.endsWith("]")) {
    return segment.slice(1, -1)
  }
  return null
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export type { HttpMethod }
