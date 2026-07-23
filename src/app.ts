import type { IncomingMessage, Server, ServerResponse } from "node:http"
import type { Duplex } from "node:stream"
import { CacheRuntime } from "./cache/runtime.js"
import { isCacheStore, MemoryCacheStore, type CacheStore } from "./cache/store.js"
import { Container } from "./container/container.js"
import { createLogger, type Logger, type LogLevel } from "./container/logger.js"
import { Registry } from "./container/registry.js"
import { loadEnv } from "./env.js"
import { CloveBootError, error } from "./errors.js"
import { DEFAULT_BODY_LIMIT } from "./http/body.js"
import { CloveRequest } from "./http/request.js"
import { CloveResponse } from "./http/response.js"
import { McpRuntime } from "./mcp/runtime.js"
import { runPipeline, writeError } from "./pipeline/index.js"
import type { RouterTrie } from "./router/trie.js"
import {
  createLoader,
  resolveSourceDir,
  scanProject,
  type ScanResult,
} from "./scanner/index.js"
import { SessionManager, isSessionStore, type SessionStore } from "./session/index.js"
import type { LifecycleHooks, RuntimeCtx } from "./types.js"
import { WsRuntime } from "./ws/index.js"

export interface AppOptions {
  /** Project root. Defaults to `process.cwd()`. */
  rootDir?: string
  /** Overrides the auto-detected `src/` vs project-root source directory. */
  sourceDir?: string
  /**
   * `.env` loading. Defaults to the cascade `.env.[NODE_ENV].local`,
   * `.env.[NODE_ENV]`, `.env.local`, `.env` — earlier files win, and the real
   * environment always wins over all of them. Pass `false` to disable, or an
   * explicit list of files to load instead of the cascade.
   */
  env?: false | string[]
  logLevel?: LogLevel
  /** Maximum request body size in bytes. */
  bodyLimit?: number
  /** Secret used to sign the session cookie. Falls back to `CLOVE_SECRET`. */
  sessionSecret?: string
  sessionTtl?: number
  /** Include error messages and stacks in 500 responses. Defaults to dev-only. */
  exposeErrors?: boolean
  /**
   * Cache evaluated modules. Defaults to true; the dev server sets it false so
   * that a reload actually re-reads changed files.
   */
  moduleCache?: boolean
  /** Path the MCP endpoint is served from. Defaults to `/mcp`. */
  mcpPath?: string
  /** Name and version reported to MCP clients. Defaults to the package name. */
  mcpServerInfo?: { name: string; version: string }
  /**
   * Replaces injectables by their `ctx` key before any singleton resolves.
   *
   * A plain value swaps the dependency directly; a function is treated as a
   * factory with the same `(ctx, hooks)` contract as a `service`/`di` file. An
   * override keeps the lifetime of the key it replaces, and an override for an
   * unknown key registers as a new singleton.
   *
   * This is the one capability production forbids — the registry rejects two
   * files claiming the same key — and it exists for tests. `createTestApp()`
   * from `clovejs/testing` is the intended caller.
   */
  overrides?: Record<string, unknown>
}

/**
 * A booted application: registry, router, middleware chain and DI root, with
 * no listening socket of its own.
 */
export class CloveApp {
  readonly registry: Registry
  readonly routes: RouterTrie
  readonly root: Container
  readonly logger: Logger
  readonly ws: WsRuntime
  readonly mcp: McpRuntime
  readonly sessions: SessionManager
  readonly cache: CacheRuntime
  readonly scan: ScanResult

  #options: Required<Pick<AppOptions, "bodyLimit" | "exposeErrors">>
  #closed = false

  constructor(
    scan: ScanResult,
    root: Container,
    logger: Logger,
    sessions: SessionManager,
    ws: WsRuntime,
    mcp: McpRuntime,
    cache: CacheRuntime,
    options: Required<Pick<AppOptions, "bodyLimit" | "exposeErrors">>,
  ) {
    this.scan = scan
    this.registry = scan.registry
    this.routes = scan.routes
    this.root = root
    this.logger = logger
    this.sessions = sessions
    this.ws = ws
    this.mcp = mcp
    this.cache = cache
    this.#options = options
  }

  /**
   * Handles one request. Returns false when no route matched, so an Express
   * host can fall through to its own stack.
   */
  async handle(rawReq: IncomingMessage, rawRes: ServerResponse): Promise<boolean> {
    const req = new CloveRequest(rawReq, this.#options.bodyLimit)

    // MCP owns its endpoint outright: it speaks JSON-RPC over its own
    // transport, so it runs before route matching and outside the middleware
    // chain, the same way WebSocket upgrades bypass both.
    if (this.mcp.owns(req.path)) {
      const body = req.method === "POST" ? await req.readBody() : undefined
      try {
        return await this.mcp.handle(rawReq, rawRes, body)
      } catch (err) {
        this.logger.error("MCP transport error:", err)
        if (!rawRes.headersSent) {
          const res = new CloveResponse(rawRes)
          writeError(err, res, {
            exposeErrors: this.#options.exposeErrors,
            logger: this.logger,
          })
        }
        return true
      }
    }

    const match = this.routes.match(req.method, req.path)
    if (!match) return false

    req.params = match.params
    const res = new CloveResponse(rawRes, {
      buffered: Boolean(match.route.cache),
    })

    let sessionId: string | undefined
    let sessionContainer: Container | undefined
    let requestContainer: Container | undefined
    let completion:
      | Awaited<ReturnType<typeof runPipeline>>
      | undefined

    try {
      const parent = this.sessions.needed
        ? await (async () => {
            const acquired = await this.sessions.acquire(req, res)
            sessionId = acquired.id
            sessionContainer = acquired.container
            return acquired.container
          })()
        : this.root

      requestContainer = parent.createChild("request")

      // Populate `req.body` up front so handlers can read it synchronously.
      await req.readBody()

      completion = await runPipeline(match.route, req, res, requestContainer, {
        middlewares: this.scan.middlewares,
        exposeErrors: this.#options.exposeErrors,
        logger: this.logger,
        views: this.scan.views,
        cache: this.cache,
      })
      await this.cache.complete(res, completion)
      if (completion.handlerExecuted) {
        this.cache.applyClientPolicy(match.route, req, res)
      }

      if (
        match.route.invalidates &&
        completion.handlerExecuted &&
        completion.error === undefined &&
        res.statusCode >= 200 &&
        res.statusCode < 300
      ) {
        await this.cache
          .invalidateRoute(match.route.invalidates, {
            route: match.route,
            req,
            res,
            ctx: requestContainer.ctx,
            result: completion.result,
          })
          .catch((err) => this.logger.error("Route cache invalidation failed:", err))
      }
    } catch (err) {
      await this.cache
        .complete(res, {
          result: completion?.result,
          error: err,
          handlerExecuted: completion?.handlerExecuted ?? false,
        })
        .catch(() => undefined)
      writeError(err, res, {
        exposeErrors: this.#options.exposeErrors,
        logger: this.logger,
      })
    } finally {
      if (!res.sent) res.end()
      res.commit({ omitBody: req.method === "HEAD" })
      if (sessionId && sessionContainer) {
        await this.sessions
          .persist(sessionId, sessionContainer)
          .catch((err) => this.logger.error("Failed to persist session:", err))
      }
      if (requestContainer) {
        await requestContainer
          .dispose()
          .catch((err) => this.logger.error("Error disposing request scope:", err))
      }
    }
    return true
  }

  /** A node `request` listener that 404s unmatched paths. */
  get listener(): (req: IncomingMessage, res: ServerResponse) => void {
    return (rawReq, rawRes) => {
      void this.handle(rawReq, rawRes).then((handled) => {
        if (!handled && !rawRes.writableEnded) {
          const res = new CloveResponse(rawRes)
          const status = this.routes.hasPath(new URL(
            rawReq.url ?? "/",
            `http://${rawReq.headers.host ?? "localhost"}`,
          ).pathname)
            ? 405
            : 404
          writeError(
            error(status, {
              message: status === 405 ? "Method Not Allowed" : "Not Found",
            }),
            res,
            { exposeErrors: this.#options.exposeErrors, logger: this.logger },
          )
        }
      })
    }
  }

  /** An Express-compatible middleware: unmatched requests call `next()`. */
  get middleware(): (
    req: IncomingMessage,
    res: ServerResponse,
    next: (err?: unknown) => void,
  ) => void {
    return (rawReq, rawRes, next) => {
      void this.handle(rawReq, rawRes).then(
        (handled) => {
          if (!handled) next()
        },
        (err) => next(err),
      )
    }
  }

  attachUpgrade(server: Server): void {
    this.ws.attach(server)
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.ws.handleUpgrade(req, socket, head)
  }

  /** Disposes sockets, sessions and the singleton scope, in that order. */
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.mcp.close().catch((err) => this.logger.error("mcp close:", err))
    await this.ws.close().catch((err) => this.logger.error("ws close:", err))
    await this.sessions
      .disposeAll()
      .catch((err) => this.logger.error("session cleanup:", err))
    await this.root.dispose()
  }
}

/**
 * Scans the project and wires up an application without starting a server.
 *
 * This is the shared path behind `bootstrap()` and `engine()`.
 */
export async function createApp(options: AppOptions = {}): Promise<CloveApp> {
  const rootDir = options.rootDir ?? process.cwd()

  // Before anything else: services and di values read `process.env` at module
  // scope, so the files must be in place by the time the scanner loads them.
  const loadedEnv =
    options.env === false
      ? []
      : loadEnv({
          rootDir,
          ...(Array.isArray(options.env) ? { files: options.env } : {}),
        })

  const sourceDir = options.sourceDir ?? resolveSourceDir(rootDir)
  const isDev = process.env.NODE_ENV !== "production"

  const logger = createLogger(options.logLevel ?? (isDev ? "debug" : "info"))
  if (loadedEnv.length > 0) {
    logger.debug(`Loaded ${loadedEnv.length} variable(s) from .env: ${loadedEnv.join(", ")}`)
  }
  const loader = await createLoader(rootDir, {
    moduleCache: options.moduleCache ?? true,
  })
  const scan = await scanProject({ sourceDir, loader })

  // The builtin logger is registered first so a user-defined `logger` service
  // or di value overrides it rather than colliding with it.
  if (!scan.registry.has("logger")) {
    scan.registry.add({
      key: "logger",
      kind: "builtin",
      lifetime: "singleton",
      file: "<builtin>",
      value: logger,
      isFactory: false,
    })
  }

  if (!scan.registry.has("cacheStore")) {
    scan.registry.add({
      key: "cacheStore",
      kind: "builtin",
      lifetime: "singleton",
      file: "<builtin>",
      value: new MemoryCacheStore(),
      isFactory: false,
    })
  }
  if (scan.registry.has("cache")) {
    throw new CloveBootError(
      '`ctx.cache` is reserved by CloveJS. Rename the service or DI value that provides "cache".',
      [scan.registry.get("cache")!.file],
    )
  }
  scan.registry.add({
    key: "cache",
    kind: "builtin",
    lifetime: "singleton",
    file: "<builtin>",
    isFactory: true,
    factory: async (ctx) => {
      const store = await ctx.cacheStore
      if (!isCacheStore(store)) {
        throw new TypeError(
          "services/cacheStore.ts must return an object with get, set, delete and invalidateTags methods.",
        )
      }
      return new CacheRuntime(store as CacheStore, logger)
    },
  })

  // Apply test overrides before any container reads the registry, so singletons
  // resolve against the fakes rather than the real dependencies.
  if (options.overrides) {
    for (const [key, value] of Object.entries(options.overrides)) {
      const existing = scan.registry.get(key)
      const isFactory = typeof value === "function"
      scan.registry.override({
        key,
        kind: existing?.kind ?? "di",
        lifetime: existing?.lifetime ?? "singleton",
        file: "<override>",
        isFactory,
        ...(isFactory
          ? { factory: value as (ctx: RuntimeCtx, hooks: LifecycleHooks) => unknown }
          : { value }),
      })
    }
  }

  const root = new Container(scan.registry, "singleton")

  // Resolve every singleton before serving, so handlers see values rather than
  // promises when they read `ctx.something`.
  await root.ensure()
  const cache = root.get("cache") as CacheRuntime

  const secret = options.sessionSecret ?? process.env.CLOVE_SECRET ?? null
  if (!secret && scan.registry.byLifetime("session").length > 0) {
    logger.warn(
      "No session secret configured. Set CLOVE_SECRET (or pass sessionSecret) " +
        "before deploying — sessions are signed with an ephemeral key, so they " +
        "will not survive a restart.",
    )
  }

  const userStore = scan.registry.has("sessionStore")
    ? root.get("sessionStore")
    : undefined

  const sessions = new SessionManager(root, scan.registry, {
    secret: secret ?? randomSecret(),
    ttl: options.sessionTtl,
    ...(isSessionStore(userStore) ? { store: userStore as SessionStore } : {}),
  })

  const ws = new WsRuntime({
    sockets: scan.sockets,
    handlers: scan.socketHandlers,
    root,
    logger,
  })

  const mcp = new McpRuntime({
    scan: scan.mcp,
    root,
    logger,
    sessions,
    ...(options.mcpPath ? { path: options.mcpPath } : {}),
    ...(options.mcpServerInfo ? { serverInfo: options.mcpServerInfo } : {}),
    ...(scan.mcp.auth ? { auth: scan.mcp.auth } : {}),
    exposeErrors: options.exposeErrors ?? isDev,
  })

  return new CloveApp(scan, root, logger, sessions, ws, mcp, cache, {
    bodyLimit: options.bodyLimit ?? DEFAULT_BODY_LIMIT,
    exposeErrors: options.exposeErrors ?? isDev,
  })
}

function randomSecret(): string {
  return Buffer.from(
    globalThis.crypto.getRandomValues(new Uint8Array(32)),
  ).toString("base64url")
}
