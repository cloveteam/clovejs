import { stat } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { join } from "node:path"
import { createApp, CloveApp, type AppOptions } from "../app.js"
import { createLogger, type Logger } from "../container/logger.js"
import { generateTypes, tsconfigIncludeWarning } from "../codegen/index.js"
import { resolveSourceDir, walkDir } from "../scanner/index.js"

/**
 * When to re-check the source tree against what the running app was built
 * from, in milliseconds after the watcher reports itself ready.
 *
 * A recursive filesystem watch is not necessarily delivering events by the
 * time it says it is ready — on macOS the OS-level watch takes a moment to
 * arm, and a file saved in that window is dropped with no error and no retry.
 * Waiting for `ready` narrows the gap but does not close it. These sweeps
 * close it: they compare the tree against the snapshot the app was built from,
 * so a change that slipped through is still picked up.
 *
 * They stop after a couple of seconds because this is a startup problem. A
 * watch that has begun delivering events keeps doing so.
 */
const RECONCILE_DELAYS = [150, 600, 1500]

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

  // Taken before anything reads the tree — before the types are generated, not
  // just before the app is scanned. A file that lands in between would
  // otherwise make it into the app but not into `.clove/types.d.ts`, and
  // comparing against a snapshot that already included it would report no
  // drift, so nothing would ever put the two back in step.
  //
  // Erring this way costs at most one extra rebuild at startup; erring the
  // other way silently serves stale code.
  let built = await fingerprint(sourceDir)

  await generateTypes({ rootDir, sourceDir })
  const includeWarning = await tsconfigIncludeWarning(rootDir)
  if (includeWarning) logger.warn(includeWarning)

  let app = await createApp({
    ...options,
    rootDir,
    sourceDir,
    logLevel: "silent",
    moduleCache: false,
  })
  let reloading: Promise<void> | undefined
  /** Set while a rebuild is queued but has not started, so saves can coalesce. */
  let pending: { changed: string } | undefined
  let closed = false

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
    // Serialise reloads so a burst of saves does not interleave rebuilds. A
    // reload always re-reads the whole project, so several queued behind one
    // in flight would all produce the same result — collapse them into a
    // single rebuild and keep the name of the file that triggered it.
    if (pending) {
      pending.changed = changed
      return reloading ?? Promise.resolve()
    }
    const batch: { changed: string } = { changed }
    pending = batch

    reloading = (reloading ?? Promise.resolve()).then(async () => {
      pending = undefined
      const started = Date.now()
      const snapshot = await fingerprint(sourceDir).catch(() => built)
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
        built = snapshot
        await previous.close().catch(() => undefined)
        logger.info(
          `Reloaded after ${relativeTo(sourceDir, batch.changed)} (${Date.now() - started}ms)`,
        )
      } catch (err) {
        // Keep serving the last good build so a typo does not take the app
        // down. The snapshot still moves forward, because re-running the same
        // failing build on the next sweep would only repeat the error.
        built = snapshot
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

  // A watcher error is not fatal — events may still be arriving — but it does
  // explain a dev server that has stopped noticing saves, so say so.
  watcher.on("error", (err: unknown) => {
    logger.error(`File watcher error: ${err instanceof Error ? err.message : String(err)}`)
  })

  // Chokidar drops events raised during its initial scan, so hold off on
  // reporting the server as ready until it is actually watching. Otherwise an
  // edit made right after startup is silently ignored.
  await new Promise<void>((resolve) => {
    watcher.once("ready", () => resolve())
  })

  // `ready` is necessary but not sufficient — see RECONCILE_DELAYS. These run
  // in the background so startup is not held up by them.
  const sweeps = RECONCILE_DELAYS.map((delay) =>
    setTimeout(() => {
      void (async () => {
        if (closed) return
        const current = await fingerprint(sourceDir).catch(() => null)
        if (current === null || current === built) return
        logger.debug("Source changed before the watcher was live; reloading.")
        await reload("a change the watcher missed")
      })()
    }, delay),
  )
  for (const sweep of sweeps) sweep.unref?.()

  return {
    server,
    url,
    async close() {
      closed = true
      for (const sweep of sweeps) clearTimeout(sweep)
      await watcher.close()
      // A rebuild in flight would otherwise finish after this returns and
      // replace `app` with one nothing ever disposes, leaking its singletons.
      await reloading?.catch(() => undefined)
      await new Promise<void>((resolve) => server.close(() => resolve()))
      server.closeAllConnections?.()
      await app.close()
    },
  }
}

/**
 * A cheap snapshot of every source file under `sourceDir`.
 *
 * Exported for testing: this is the detector the startup sweeps rely on, and
 * it is worth knowing directly that it notices an added, edited or removed
 * file rather than only inferring it from a race that reproduces on some
 * machines and not others.
 *
 * Path, size and mtime are enough to notice the changes a reload cares about —
 * a file added, removed or edited — without reading any contents. The walk is
 * the same one the scanner does, so the two agree on which files count.
 */
export async function fingerprint(sourceDir: string): Promise<string> {
  const files = await walkDir(sourceDir)
  const entries = await Promise.all(
    files.map(async (file) => {
      const stats = await stat(file.absolute).catch(() => null)
      return stats ? `${file.relative}:${stats.size}:${stats.mtimeMs}` : `${file.relative}:gone`
    }),
  )
  return entries.join("\n")
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
