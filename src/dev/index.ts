import { createServer, type Server } from "node:http"
import { join } from "node:path"
import { createApp, CloveApp, type AppOptions } from "../app.js"
import { createLogger, type Logger } from "../container/logger.js"
import { generateTypes } from "../codegen/index.js"
import { resolveSourceDir } from "../scanner/index.js"

export interface DevServerOptions extends AppOptions {
  port?: number
  host?: string
}

export interface DevServer {
  server: Server
  url: string
  close(): Promise<void>
}

/**
 * Runs the project with file watching.
 *
 * Any change under the source directory rebuilds the application in-process:
 * routes, middlewares, services and di values are all re-read. The listening
 * socket stays open, so in-flight connections and the terminal URL survive.
 */
export async function startDevServer(
  options: DevServerOptions = {},
): Promise<DevServer> {
  const rootDir = options.rootDir ?? process.cwd()
  const sourceDir = options.sourceDir ?? resolveSourceDir(rootDir)
  const logger = createLogger(options.logLevel ?? "debug")

  await generateTypes({ rootDir, sourceDir })

  let app = await createApp({
    ...options,
    rootDir,
    sourceDir,
    logLevel: "silent",
    moduleCache: false,
  })
  let reloading: Promise<void> | undefined

  const server = createServer((req, res) => app.listener(req, res))
  server.on("upgrade", (req, socket, head) => app.handleUpgrade(req, socket, head))

  const port = options.port ?? Number(process.env.PORT ?? 3000)
  const host = options.host ?? process.env.HOST ?? "localhost"
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
  logSummary(app, logger, url)

  const reload = async (changed: string): Promise<void> => {
    // Serialise reloads so a burst of saves does not interleave rebuilds.
    reloading = (reloading ?? Promise.resolve()).then(async () => {
      const started = Date.now()
      try {
        await generateTypes({ rootDir, sourceDir })
        const next = await createApp({
          ...options,
          rootDir,
          sourceDir,
          logLevel: "silent",
          moduleCache: false,
        })
        const previous = app
        app = next
        await previous.close().catch(() => undefined)
        logger.info(
          `Reloaded after ${relativeTo(sourceDir, changed)} (${Date.now() - started}ms)`,
        )
      } catch (err) {
        // Keep serving the last good build so a typo does not take the app down.
        logger.error(
          `Reload failed, still serving the previous build:\n${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    })
    return reloading
  }

  const { watch } = await import("chokidar")
  const watcher = watch(sourceDir, {
    ignoreInitial: true,
    // Editors and formatters commonly save in two steps (truncate, then
    // write). Without this, a reload can read a half-written file, fail
    // validation, and then never retry because no further event arrives.
    awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 20 },
    ignored: (path: string) =>
      path.includes("node_modules") ||
      path.includes(`${join(".clove")}`) ||
      path.endsWith("~"),
  })
  watcher.on("all", (_event: string, path: string) => {
    if (!/\.[cm]?[jt]s$/.test(path)) return
    void reload(path)
  })

  // Chokidar drops events raised during its initial scan, so hold off on
  // reporting the server as ready until it is actually watching. Otherwise an
  // edit made right after startup is silently ignored.
  await new Promise<void>((resolve) => {
    watcher.once("ready", () => resolve())
  })

  return {
    server,
    url,
    async close() {
      await watcher.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      server.closeAllConnections?.()
      await app.close()
    },
  }
}

function logSummary(app: CloveApp, logger: Logger, url: string): void {
  const routes = app.routes.list()
  logger.info(`CloveJS dev server ready on ${url}`)
  for (const route of routes) {
    logger.info(`  ${route.method.padEnd(7)} ${route.path}`)
  }
  for (const path of app.scan.socketHandlers.keys()) {
    logger.info(`  ${"WS".padEnd(7)} ${path}`)
  }
  if (!app.mcp.empty) {
    const { tools, resources, prompts } = app.mcp.counts
    const parts = [
      `${tools} tool${tools === 1 ? "" : "s"}`,
      `${resources} resource${resources === 1 ? "" : "s"}`,
      `${prompts} prompt${prompts === 1 ? "" : "s"}`,
    ]
    logger.info(`  ${"MCP".padEnd(7)} ${app.mcp.path}  (${parts.join(", ")})`)
  }
  if (routes.length === 0 && app.scan.socketHandlers.size === 0 && app.mcp.empty) {
    logger.warn(
      "No routes found. Add a file under api/, e.g. api/hello.get.ts, " +
        "or run `clove scaffold` to create the project structure.",
    )
  }
}

function relativeTo(base: string, path: string): string {
  return path.startsWith(base) ? path.slice(base.length + 1) : path
}
