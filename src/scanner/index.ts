import { existsSync } from "node:fs"
import { join } from "node:path"
import { Registry, type Provider } from "../container/registry.js"
import { CloveBootError } from "../errors.js"
import { RouterTrie } from "../router/trie.js"
import {
  META,
  definitionKind,
  type DiDefinition,
  type MiddlewareDefinition,
  type Route,
  type RouteDefinition,
  type ServiceDefinition,
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
  registry: Registry
  /** Every file that contributed, for the dev watcher. */
  files: string[]
}

export interface ScanOptions {
  /** Directory holding `api/`, `services/`, etc. */
  sourceDir: string
  loader: ModuleLoader
  dirs?: Partial<Record<ConventionDir, string>>
}

export type ConventionDir = "api" | "ws" | "di" | "services" | "middlewares"

export const DEFAULT_DIRS: Record<ConventionDir, string> = {
  api: "api",
  ws: "ws",
  di: "di",
  services: "services",
  middlewares: "middlewares",
}

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

  // --- api/ ----------------------------------------------------------------
  const apiDir = join(sourceDir, dirs.api)
  for (const file of await walkDir(apiDir)) {
    files.push(file.absolute)
    const def = await loadDefault(loader, file.absolute)
    if (definitionKind(def) !== "route") {
      throw new CloveBootError(
        `Files in ${dirs.api}/ must default-export a route handler wrapped in ` +
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

    const registered: Route = {
      method: route.method,
      path: join("/", dirs.api, derived.path).split("\\").join("/"),
      handler: route.handler,
      meta: Object.freeze({ ...route[META] }),
      file: file.absolute,
    }
    routes.add(registered)
  }

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

  return { routes, middlewares, sockets, socketHandlers, registry, files }
}

function describe(kind: string | null): string {
  if (kind === null) return "a plain value (not an CloveJS definition)"
  return `${kind}(...)`
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
