import { existsSync } from "node:fs"
import { join } from "node:path"
import { Registry, type Provider } from "../container/registry.js"
import { validateCachePolicy } from "../cache/runtime.js"
import { CloveBootError } from "../errors.js"
import { deriveMcpName, deriveResourceUri } from "../mcp/paths.js"
import { assertPromptShape, toRawShape } from "../mcp/schema.js"
import type {
  McpAuthDefinition,
  McpPromptDefinition,
  McpResourceDefinition,
  McpScan,
  McpToolDefinition,
} from "../mcp/types.js"
import { RouterTrie } from "../router/trie.js"
import {
  CACHE,
  INVALIDATES,
  META,
  definitionKind,
  type DiDefinition,
  type MiddlewareDefinition,
  type RouteDefinition,
  type ServiceDefinition,
  type ViewEngine,
  type ViewsDefinition,
  type WsDefinition,
} from "../types.js"
import { loadDefault, type ModuleLoader } from "./loader.js"
import {
  comparePriority,
  deriveContextKey,
  deriveRoutePath,
  deriveSocketPath,
  parsePriority,
  stripPriority,
} from "./paths.js"
import { walkDir } from "./walk.js"

export interface LoadedMiddleware {
  name: string
  priority: number[] | null
  fn: MiddlewareDefinition["fn"]
  file: string
}

export interface SocketRoute {
  path: string
  handler: WsDefinition["handler"]
  file: string
}

export interface ScanResult {
  routes: RouterTrie
  middlewares: LoadedMiddleware[]
  sockets: RouterTrie
  socketHandlers: Map<string, SocketRoute>
  mcp: McpScan
  registry: Registry
  /** The registered template engine, or null when the project has no views.ts. */
  views: ViewEngine | null
  /** Every file that contributed, for the dev watcher. */
  files: string[]
}

export interface ScanOptions {
  /** Directory holding `api/`, `services/`, etc. */
  sourceDir: string
  loader: ModuleLoader
  dirs?: Partial<Record<ConventionDir, string>>
}

export type ConventionDir =
  | "api"
  | "web"
  | "ws"
  | "di"
  | "services"
  | "middlewares"
  | "mcp"

export const DEFAULT_DIRS: Record<ConventionDir, string> = {
  api: "api",
  web: "web",
  ws: "ws",
  di: "di",
  services: "services",
  middlewares: "middlewares",
  mcp: "mcp",
}

/** Subdirectories of `mcp/`, and the definition each one must export. */
const MCP_KINDS = {
  tools: "mcpTool",
  resources: "mcpResource",
  prompts: "mcpPrompt",
} as const

/**
 * Reads the whole project into a registry, router and middleware chain.
 *
 * Every validation failure raises `CloveBootError` naming the offending file,
 * because a convention-driven framework lives or dies on its error messages.
 */
export async function scanProject(options: ScanOptions): Promise<ScanResult> {
  const { sourceDir, loader } = options
  const dirs = { ...DEFAULT_DIRS, ...options.dirs }
  const files: string[] = []

  const registry = new Registry()
  const routes = new RouterTrie()
  const sockets = new RouterTrie()
  const socketHandlers = new Map<string, SocketRoute>()
  const middlewares: LoadedMiddleware[] = []

  // --- services/ and di/ ---------------------------------------------------
  for (const kind of ["services", "di"] as const) {
    const dir = join(sourceDir, dirs[kind])
    for (const file of await walkDir(dir)) {
      files.push(file.absolute)
      const def = await loadDefault(loader, file.absolute)
      const actual = definitionKind(def)
      const key = deriveContextKey(file.relative)

      if (kind === "services") {
        if (actual !== "service") {
          throw new CloveBootError(
            `Files in ${dirs.services}/ must default-export service(...), ` +
              `but this one exports ${describe(actual)}.`,
            [file.absolute],
          )
        }
        registry.add({
          key,
          kind: "service",
          lifetime: "singleton",
          file: file.absolute,
          factory: (def as ServiceDefinition).factory,
          isFactory: true,
        })
      } else {
        if (actual !== "di") {
          throw new CloveBootError(
            `Files in ${dirs.di}/ must default-export di(...), ` +
              `but this one exports ${describe(actual)}.`,
            [file.absolute],
          )
        }
        const d = def as DiDefinition
        if (!["singleton", "session", "request"].includes(d.lifetime)) {
          throw new CloveBootError(
            `Unknown lifetime "${d.lifetime}". Use "singleton", "session" or "request".`,
            [file.absolute],
          )
        }
        registry.add({
          key,
          kind: "di",
          lifetime: d.lifetime,
          file: file.absolute,
          isFactory: d.isFactory,
          ...(d.isFactory
            ? { factory: d.value as NonNullable<Provider["factory"]> }
            : { value: d.value }),
        })
      }
    }
  }

  // --- api/ and web/ -------------------------------------------------------
  // Both hold route files and share every rule; they differ only in where they
  // mount. `api/` sits under `/api`, the home of JSON endpoints; `web/` mounts
  // at the root `/`, for HTML pages served straight off the domain.
  await loadRoutes(loader, join(sourceDir, dirs.api), dirs.api, dirs.api, routes, files)
  await loadRoutes(loader, join(sourceDir, dirs.web), dirs.web, "", routes, files)

  // --- ws/ -----------------------------------------------------------------
  const wsDir = join(sourceDir, dirs.ws)
  for (const file of await walkDir(wsDir)) {
    files.push(file.absolute)
    const def = await loadDefault(loader, file.absolute)
    if (definitionKind(def) !== "ws") {
      throw new CloveBootError(
        `Files in ${dirs.ws}/ must default-export ws(...), ` +
          `but this one exports ${describe(definitionKind(def))}.`,
        [file.absolute],
      )
    }
    const path = join("/", dirs.ws, deriveSocketPath(file.relative))
      .split("\\")
      .join("/")
    const socket: SocketRoute = {
      path,
      handler: (def as WsDefinition).handler,
      file: file.absolute,
    }
    sockets.add({
      method: "GET",
      path,
      handler: () => undefined,
      meta: {},
      file: file.absolute,
    })
    socketHandlers.set(path, socket)
  }

  // --- mcp/ ----------------------------------------------------------------
  const mcp: McpScan = { tools: [], resources: [], prompts: [], auth: null }
  const mcpNames = new Map<string, string>()

  // `mcp/auth.ts` is a single file, not a subdirectory: it declares how the
  // whole server authenticates callers, so there is exactly one per project.
  for (const ext of ["ts", "js", "mjs", "cjs"]) {
    const authFile = join(sourceDir, dirs.mcp, `auth.${ext}`)
    if (!existsSync(authFile)) continue
    files.push(authFile)
    const def = await loadDefault(loader, authFile)
    if (definitionKind(def) !== "mcpAuth") {
      throw new CloveBootError(
        `${dirs.mcp}/auth.${ext} must default-export mcpAuth(...), ` +
          `but it exports ${describe(definitionKind(def))}.`,
        [authFile],
      )
    }
    const d = def as McpAuthDefinition
    mcp.auth = { metadata: d.metadata, authenticate: d.authenticate, file: authFile }
    break
  }

  for (const [sub, expected] of Object.entries(MCP_KINDS) as Array<
    [keyof typeof MCP_KINDS, (typeof MCP_KINDS)[keyof typeof MCP_KINDS]]
  >) {
    const dir = join(sourceDir, dirs.mcp, sub)
    for (const file of await walkDir(dir)) {
      files.push(file.absolute)
      const def = await loadDefault(loader, file.absolute)
      const actual = definitionKind(def)

      if (actual !== expected) {
        const wrapper = expected.replace("mcp", "").toLowerCase()
        throw new CloveBootError(
          `Files in ${dirs.mcp}/${sub}/ must default-export ${wrapper}(...), ` +
            `but this one exports ${describe(actual)}.`,
          [file.absolute],
        )
      }

      if (sub === "resources") {
        const d = def as McpResourceDefinition
        const uri = d.uri ?? deriveResourceUri(file.relative)
        const name = d.name ?? deriveMcpName(file.relative)
        claim(mcpNames, `resource:${uri}`, file.absolute, `resource URI "${uri}"`)
        mcp.resources.push({
          uri,
          name,
          description: d.description,
          title: d.title,
          mimeType: d.mimeType,
          handler: d.handler,
          file: file.absolute,
        })
        continue
      }

      const name = (def as { name: string | null }).name ?? deriveMcpName(file.relative)
      claim(mcpNames, `${sub}:${name}`, file.absolute, `${singular(sub)} name "${name}"`)

      if (sub === "tools") {
        const d = def as McpToolDefinition
        mcp.tools.push({
          name,
          description: d.description,
          title: d.title,
          input: d.input,
          // Normalised here rather than on first request, so a malformed
          // schema is a boot error naming the file, like every other one.
          shape: toRawShape(d.input, file.absolute),
          handler: d.handler,
          meta: Object.freeze({ ...d[META] }),
          file: file.absolute,
        })
      } else {
        const d = def as McpPromptDefinition
        mcp.prompts.push({
          name,
          description: d.description,
          title: d.title,
          input: d.input,
          shape: assertPromptShape(toRawShape(d.input, file.absolute), file.absolute),
          handler: d.handler,
          file: file.absolute,
        })
      }
    }
  }

  // --- middlewares/ --------------------------------------------------------
  const mwDir = join(sourceDir, dirs.middlewares)
  for (const file of await walkDir(mwDir)) {
    files.push(file.absolute)
    const def = await loadDefault(loader, file.absolute)
    if (definitionKind(def) !== "middleware") {
      throw new CloveBootError(
        `Files in ${dirs.middlewares}/ must default-export middleware(...), ` +
          `but this one exports ${describe(definitionKind(def))}.`,
        [file.absolute],
      )
    }
    middlewares.push({
      name: stripPriority(file.relative),
      priority: parsePriority(file.relative),
      fn: (def as MiddlewareDefinition).fn,
      file: file.absolute,
    })
  }
  middlewares.sort(comparePriority)

  // --- views.ts (optional, single reserved file) ---------------------------
  // Like `mcp/auth.ts`: there is at most one template engine per project, so it
  // is a lone file at the source root, not a convention directory.
  let views: ViewEngine | null = null
  for (const ext of ["ts", "js", "mjs", "cjs"]) {
    const viewsFile = join(sourceDir, `views.${ext}`)
    if (!existsSync(viewsFile)) continue
    files.push(viewsFile)
    const def = await loadDefault(loader, viewsFile)
    if (definitionKind(def) !== "views") {
      throw new CloveBootError(
        `views.${ext} must default-export views(...), ` +
          `but it exports ${describe(definitionKind(def))}.`,
        [viewsFile],
      )
    }
    views = (def as ViewsDefinition).engine
    break
  }

  return { routes, middlewares, sockets, socketHandlers, mcp, registry, views, files }
}

/**
 * Loads a directory of route files into the router. Shared by `api/` and
 * `web/`: `label` names the directory in error messages, and `mount` is the URL
 * prefix each route hangs under (`"api"` for `/api/...`, `""` for the root).
 */
async function loadRoutes(
  loader: ModuleLoader,
  dir: string,
  label: string,
  mount: string,
  routes: RouterTrie,
  files: string[],
): Promise<void> {
  for (const file of await walkDir(dir)) {
    files.push(file.absolute)
    const def = await loadDefault(loader, file.absolute)
    if (definitionKind(def) !== "route") {
      throw new CloveBootError(
        `Files in ${label}/ must default-export a route handler wrapped in ` +
          `get(), post(), put(), patch(), del(), head(), options() or all(), ` +
          `but this one exports ${describe(definitionKind(def))}.`,
        [file.absolute],
      )
    }
    const route = def as RouteDefinition
    const derived = deriveRoutePath(file.relative)

    if (derived.method !== null && derived.method !== route.method) {
      throw new CloveBootError(
        `Method mismatch: the filename says ${derived.method} but the handler ` +
          `is wrapped in ${route.method.toLowerCase()}(). Make them agree, or ` +
          `drop the method suffix from the filename.`,
        [file.absolute],
      )
    }

    if (route[CACHE] && !["GET", "HEAD"].includes(route.method)) {
      throw new CloveBootError(
        `Only GET and HEAD routes can be cached, but this route uses ` +
          `${route.method}. Use .invalidates(...) on mutation routes instead.`,
        [file.absolute],
      )
    }
    if (route[CACHE]) {
      try {
        validateCachePolicy(route[CACHE])
      } catch (err) {
        throw new CloveBootError(
          err instanceof Error ? err.message : "Invalid route cache policy.",
          [file.absolute],
        )
      }
    }

    routes.add({
      method: route.method,
      path: join("/", mount, derived.path).split("\\").join("/"),
      handler: route.handler,
      meta: Object.freeze({ ...route[META] }),
      ...(route[CACHE] ? { cache: Object.freeze({ ...route[CACHE] }) } : {}),
      ...(route[INVALIDATES] ? { invalidates: route[INVALIDATES] } : {}),
      file: file.absolute,
    })
  }
}

function describe(kind: string | null): string {
  if (kind === null) return "a plain value (not an CloveJS definition)"
  return `${kind}(...)`
}

/** Reserves a name or URI, failing at boot when two files want the same one. */
function claim(
  taken: Map<string, string>,
  key: string,
  file: string,
  label: string,
): void {
  const previous = taken.get(key)
  if (previous) {
    throw new CloveBootError(
      `Duplicate ${label}: two files both claim it. Rename one of them, or ` +
        `set an explicit name in the definition.`,
      [previous, file],
    )
  }
  taken.set(key, file)
}

function singular(sub: string): string {
  return sub.endsWith("s") ? sub.slice(0, -1) : sub
}

/**
 * Locates the directory holding the convention folders: `src/` when it exists,
 * otherwise the project root, matching both layouts in the concept document.
 */
export function resolveSourceDir(rootDir: string): string {
  const src = join(rootDir, "src")
  if (existsSync(src)) return src
  return rootDir
}


export { walkDir } from "./walk.js"
export * from "./paths.js"
export * from "./loader.js"
