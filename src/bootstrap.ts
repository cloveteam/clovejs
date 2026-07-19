import { createServer, type Server } from "node:http"
import { createApp, CloveApp, type AppOptions } from "./app.js"

export interface BootstrapOptions extends AppOptions {
  port?: number
  host?: string
  /** Register SIGINT/SIGTERM handlers for graceful shutdown. Default true. */
  handleSignals?: boolean
}

export interface Clove {
  app: CloveApp
  server: Server
  port: number
  host: string
  url: string
  close(): Promise<void>
}

/**
 * Boots the project and starts listening.
 *
 * ```ts
 * import { bootstrap } from "clovejs"
 * bootstrap()
 * ```
 */
export async function bootstrap(options: BootstrapOptions = {}): Promise<Clove> {
  const app = await createApp(options)

  const port = options.port ?? Number(process.env.PORT ?? 3000)
  const host = options.host ?? process.env.HOST ?? "localhost"

  const server = createServer(app.listener)
  app.attachUpgrade(server)

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, host, () => {
      server.off("error", reject)
      resolve()
    })
  })

  const address = server.address()
  const actualPort = typeof address === "object" && address ? address.port : port
  const url = `http://${host}:${actualPort}`

  const routeCount = app.routes.list().length
  const socketCount = app.scan.socketHandlers.size
  const { tools } = app.mcp.counts
  app.logger.info(
    `CloveJS listening on ${url} — ${routeCount} route${routeCount === 1 ? "" : "s"}` +
      (socketCount ? `, ${socketCount} socket${socketCount === 1 ? "" : "s"}` : "") +
      (app.mcp.empty
        ? ""
        : `, MCP on ${app.mcp.path} with ${tools} tool${tools === 1 ? "" : "s"}`),
  )

  let closing: Promise<void> | undefined
  const close = async (): Promise<void> => {
    closing ??= (async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      server.closeAllConnections?.()
      await app.close()
    })()
    return closing
  }

  if (options.handleSignals !== false) {
    const onSignal = (signal: string) => {
      app.logger.info(`Received ${signal}, shutting down.`)
      void close().then(
        () => process.exit(0),
        (err) => {
          app.logger.error("Error during shutdown:", err)
          process.exit(1)
        },
      )
    }
    process.once("SIGINT", () => onSignal("SIGINT"))
    process.once("SIGTERM", () => onSignal("SIGTERM"))
  }

  return { app, server, port: actualPort, host, url, close }
}

/**
 * Boots the project without listening, for mounting inside another server.
 *
 * ```ts
 * const app = express()
 * const clove = await engine(app)
 * app.listen(3000)
 * ```
 *
 * When an Express app is passed it is mounted automatically; otherwise the
 * returned engine can be used as a handler with `app.use(clove.middleware)`.
 * WebSockets need the host's server: `clove.attachUpgrade(server)`.
 */
export async function engine(host?: ExpressLike, options: AppOptions = {}): Promise<CloveEngine> {
  const app = await createApp(options)
  if (host && typeof host.use === "function") {
    host.use(app.middleware)
  }
  return Object.assign(app.middleware, {
    app,
    middleware: app.middleware,
    listener: app.listener,
    attachUpgrade: (server: Server) => app.attachUpgrade(server),
    close: () => app.close(),
  })
}

export interface ExpressLike {
  use(handler: (...args: any[]) => void): unknown
}

export type CloveEngine = CloveApp["middleware"] & {
  app: CloveApp
  middleware: CloveApp["middleware"]
  listener: CloveApp["listener"]
  attachUpgrade(server: Server): void
  close(): Promise<void>
}
