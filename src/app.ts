import type { IncomingMessage, Server, ServerResponse } from "node:http"
import type { Duplex } from "node:stream"
import { Container } from "./container/container.js"
import { createLogger, type Logger, type LogLevel } from "./container/logger.js"
import { Registry } from "./container/registry.js"
import { error } from "./errors.js"
import { DEFAULT_BODY_LIMIT } from "./http/body.js"
import { CloveRequest } from "./http/request.js"
import { CloveResponse } from "./http/response.js"
import { runPipeline, writeError } from "./pipeline/index.js"
import type { RouterTrie } from "./router/trie.js"
import {
  createLoader,
  resolveSourceDir,
  scanProject,
  type ScanResult,
} from "./scanner/index.js"
import { SessionManager, isSessionStore, type SessionStore } from "./session/index.js"
import { WsRuntime } from "./ws/index.js"

export interface AppOptions {
  /** Project root. Defaults to `process.cwd()`. */
  rootDir?: string
  /** Overrides the auto-detected `src/` vs project-root source directory. */
  sourceDir?: string
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
  readonly sessions: SessionManager
  readonly scan: ScanResult

  #options: Required<Pick<AppOptions, "bodyLimit" | "exposeErrors">>
  #closed = false

  constructor(
    scan: ScanResult,
    root: Container,
    logger: Logger,
    sessions: SessionManager,
    ws: WsRuntime,
    options: Required<Pick<AppOptions, "bodyLimit" | "exposeErrors">>,
  ) {
    this.scan = scan
    this.registry = scan.registry
    this.routes = scan.routes
    this.root = root
    this.logger = logger
    this.sessions = sessions
    this.ws = ws
    this.#options = options
  }

  /**
   * Handles one request. Returns false when no route matched, so an Express
   * host can fall through to its own stack.
   */
  async handle(rawReq: IncomingMessage, rawRes: ServerResponse): Promise<boolean> {
    const req = new CloveRequest(rawReq, this.#options.bodyLimit)
    const res = new CloveResponse(rawRes)

    const match = this.routes.match(req.method, req.path)
    if (!match) return false

    req.params = match.params

    let sessionId: string | undefined
    let sessionContainer: Container | undefined
    let requestContainer: Container | undefined

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

      await runPipeline(match.route, req, res, requestContainer, {
        middlewares: this.scan.middlewares,
        exposeErrors: this.#options.exposeErrors,
        logger: this.logger,
      })
    } catch (err) {
      writeError(err, res, {
        exposeErrors: this.#options.exposeErrors,
        logger: this.logger,
      })
    } finally {
      if (!res.sent) res.end()
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
  const sourceDir = options.sourceDir ?? resolveSourceDir(rootDir)
  const isDev = process.env.NODE_ENV !== "production"

  const logger = createLogger(options.logLevel ?? (isDev ? "debug" : "info"))
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

  const root = new Container(scan.registry, "singleton")

  // Resolve every singleton before serving, so handlers see values rather than
  // promises when they read `ctx.something`.
  await root.ensure()

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

  return new CloveApp(scan, root, logger, sessions, ws, {
    bodyLimit: options.bodyLimit ?? DEFAULT_BODY_LIMIT,
    exposeErrors: options.exposeErrors ?? isDev,
  })
}

function randomSecret(): string {
  return Buffer.from(
    globalThis.crypto.getRandomValues(new Uint8Array(32)),
  ).toString("base64url")
}
