import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { generateTypes, ensureGitignore } from "../codegen/index.js"
import { startDevServer } from "../dev/index.js"
import { CloveBootError } from "../errors.js"
import { resolveSourceDir } from "../scanner/index.js"
import { scaffold } from "./scaffold.js"
import { installSkills, unknownIdes, TARGETS } from "./skills/index.js"

const USAGE = `
clove — CloveJS project commands

  clove dev [--port <n>] [--host <h>]   Run the dev server with file watching
  clove build                           Generate types and compile with tsc
  clove types                           Generate .clove/types.d.ts only
  clove scaffold [--js] [--force]       Create the default project structure
  clove routes                          Print the resolved route table
  clove mcp [--stdio]                   Print the MCP surface, or serve it over stdio
  clove skills [--ide <a,b>] [--force]  Install CloveJS instructions for AI editors

Options:
  --dir <path>   Project root (defaults to the current directory)
  --help         Show this message
`.trim()

interface Args {
  command: string
  flags: Record<string, string | boolean>
}

function parseArgs(argv: string[]): Args {
  const [command = "help", ...rest] = argv
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!
    if (!arg.startsWith("--")) continue
    const name = arg.slice(2)
    const next = rest[i + 1]
    if (next && !next.startsWith("--")) {
      flags[name] = next
      i++
    } else {
      flags[name] = true
    }
  }
  return { command, flags }
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2))

  if (flags.help || command === "help" || command === "--help") {
    console.log(USAGE)
    return
  }

  const rootDir = typeof flags.dir === "string" ? flags.dir : process.cwd()
  const sourceDir = resolveSourceDir(rootDir)

  switch (command) {
    case "dev": {
      const dev = await startDevServer({
        rootDir,
        ...(flags.port ? { port: Number(flags.port) } : {}),
        ...(typeof flags.host === "string" ? { host: flags.host } : {}),
      })
      const shutdown = () => {
        void dev.close().then(() => process.exit(0))
      }
      process.on("SIGINT", shutdown)
      process.on("SIGTERM", shutdown)
      return
    }

    case "types": {
      const out = await generateTypes({ rootDir, sourceDir })
      await ensureGitignore(rootDir)
      console.log(`Generated ${out}`)
      return
    }

    case "build": {
      await generateTypes({ rootDir, sourceDir })
      if (!existsSync(join(rootDir, "tsconfig.json"))) {
        console.log("No tsconfig.json found — nothing to compile.")
        return
      }
      console.log("Compiling with tsc...")
      try {
        execFileSync("npx", ["tsc"], { cwd: rootDir, stdio: "inherit" })
      } catch {
        // tsc has already printed the diagnostics; adding a stack trace here
        // would only bury them.
        console.error("\nBuild failed: tsc reported errors (see above).")
        process.exitCode = 1
        return
      }
      console.log("Build complete.")
      return
    }

    case "scaffold": {
      const typescript = !flags.js
      const result = await scaffold({
        rootDir,
        typescript,
        force: Boolean(flags.force),
      })
      for (const file of result.created) console.log(`  created  ${file}`)
      for (const file of result.skipped) console.log(`  skipped  ${file} (exists)`)
      console.log(
        `\nDone. Run \`npm run dev\` to start the server.` +
          (result.skipped.length ? " Use --force to overwrite skipped files." : ""),
      )
      return
    }

    case "skills": {
      const ides =
        typeof flags.ide === "string"
          ? flags.ide.split(",").map((id) => id.trim()).filter(Boolean)
          : []

      const unknown = unknownIdes(ides)
      if (unknown.length) {
        console.error(`Unknown editor: ${unknown.join(", ")}\n`)
        console.error(`Known editors: ${TARGETS.map((t) => t.id).join(", ")}`)
        process.exitCode = 1
        return
      }

      const result = await installSkills({
        rootDir,
        ides,
        force: Boolean(flags.force),
      })
      for (const file of result.written) console.log(`  created  ${file}`)
      for (const file of result.updated) console.log(`  updated  ${file}`)
      for (const file of result.skipped) console.log(`  skipped  ${file} (exists)`)
      console.log(
        `\nDone. Your assistant picks these up on its next session.` +
          (result.skipped.length ? " Use --force to overwrite skipped files." : ""),
      )
      return
    }

    case "routes": {
      const { createApp } = await import("../app.js")
      const app = await createApp({ rootDir, logLevel: "silent" })
      for (const route of app.routes.list()) {
        console.log(`${route.method.padEnd(7)} ${route.path}`)
      }
      for (const path of app.scan.socketHandlers.keys()) {
        console.log(`${"WS".padEnd(7)} ${path}`)
      }
      if (!app.mcp.empty) {
        console.log(`${"MCP".padEnd(7)} ${app.mcp.path}`)
      }
      await app.close()
      return
    }

    case "mcp": {
      const { createApp } = await import("../app.js")

      if (flags.stdio) {
        // stdout *is* the protocol stream here, and console.log/info/debug all
        // write to it. Redirect them to stderr before anything boots, so a
        // stray log line in project code cannot corrupt the transport.
        console.log = console.error
        console.info = console.error
        console.debug = console.error

        const app = await createApp({ rootDir, logLevel: "info" })
        if (app.mcp.empty) {
          console.error(`No MCP definitions found under ${sourceDir}/mcp/.`)
          await app.close()
          process.exitCode = 1
          return
        }
        const shutdown = () => {
          void app.close().then(() => process.exit(0))
        }
        process.on("SIGINT", shutdown)
        process.on("SIGTERM", shutdown)
        await app.mcp.serveStdio()
        await app.close()
        return
      }

      const app = await createApp({ rootDir, logLevel: "silent" })
      const { tools, resources, prompts } = app.scan.mcp

      if (app.mcp.empty) {
        console.log(`No MCP definitions found under ${sourceDir}/mcp/.`)
      } else {
        console.log(`Endpoint  ${app.mcp.path}\n`)
        for (const tool of tools) {
          console.log(`${"tool".padEnd(9)} ${tool.name.padEnd(24)} ${tool.description}`)
        }
        for (const res of resources) {
          console.log(`${"resource".padEnd(9)} ${res.uri.padEnd(24)} ${res.description}`)
        }
        for (const p of prompts) {
          console.log(`${"prompt".padEnd(9)} ${p.name.padEnd(24)} ${p.description}`)
        }
      }
      await app.close()
      return
    }

    default:
      console.error(`Unknown command: ${command}\n`)
      console.log(USAGE)
      process.exitCode = 1
  }
}

main().catch((err) => {
  if (err instanceof CloveBootError) {
    console.error(`\n${err.message}\n`)
  } else {
    console.error(err)
  }
  process.exit(1)
})
