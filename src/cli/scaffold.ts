import { mkdir, readFile, writeFile, access } from "node:fs/promises"
import { join } from "node:path"

export interface ScaffoldOptions {
  rootDir: string
  /** TypeScript layout (`src/`) or plain JavaScript at the root. */
  typescript: boolean
  /** Overwrite files that already exist. */
  force?: boolean
}

export interface ScaffoldResult {
  created: string[]
  skipped: string[]
}

/**
 * Writes the default project structure from the concept document.
 *
 * Never clobbers existing files unless `force` is set, so it is safe to run
 * inside a project that is already partly set up.
 */
export async function scaffold(options: ScaffoldOptions): Promise<ScaffoldResult> {
  const { rootDir, typescript } = options
  const ext = typescript ? "ts" : "js"
  const base = typescript ? join(rootDir, "src") : rootDir

  const created: string[] = []
  const skipped: string[] = []

  const write = async (path: string, contents: string): Promise<void> => {
    const full = join(rootDir, path)
    if (!options.force && (await exists(full))) {
      skipped.push(path)
      return
    }
    await mkdir(join(full, ".."), { recursive: true })
    await writeFile(full, contents, "utf8")
    created.push(path)
  }

  for (const dir of ["api", "ws", "di", "services", "middlewares"]) {
    await mkdir(join(base, dir), { recursive: true })
  }

  const prefix = typescript ? "src/" : ""

  await write(
    `${prefix}main.${ext}`,
    `import { bootstrap } from "clovejs"\n\nbootstrap()\n`,
  )

  await write(
    `${prefix}api/hello.get.${ext}`,
    typescript
      ? `import { get } from "clovejs"\n\nexport default get(async (req, res, ctx) => {\n  return { message: "Hello from CloveJS" }\n})\n`
      : `import { get } from "clovejs"\n\nexport default get(async (req, res, ctx) => {\n  return { message: "Hello from CloveJS" }\n})\n`,
  )

  await write(
    `${prefix}di/config.${ext}`,
    `import { di } from "clovejs"\n\nexport default di({\n  lifetime: "singleton",\n  value: {\n    url: process.env.URL ?? "http://localhost:3000",\n  },\n})\n`,
  )

  await write(
    `${prefix}services/greeter.${ext}`,
    `import { service } from "clovejs"\n\nexport default service(async (ctx) => ({\n  greet(name${typescript ? ": string" : ""}) {\n    return \`Hello, \${name}!\`\n  },\n}))\n`,
  )

  if (typescript) {
    await write(
      "tsconfig.json",
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "Bundler",
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true,
            outDir: "dist",
            rootDir: "src",
            types: ["node"],
          },
          include: ["src", ".clove"],
        },
        null,
        2,
      ) + "\n",
    )
  }

  await write(
    ".gitignore",
    ["node_modules/", "dist/", ".clove/", ".env", ""].join("\n"),
  )

  await upsertPackageJson(rootDir, typescript)

  return { created, skipped }
}

/** Adds the scripts and `type: module` a fresh project needs. */
async function upsertPackageJson(rootDir: string, typescript: boolean): Promise<void> {
  const path = join(rootDir, "package.json")
  const raw = await readFile(path, "utf8").catch(() => null)
  const pkg = raw ? JSON.parse(raw) : { name: "my-clove-app", version: "0.1.0" }

  pkg.type ??= "module"
  pkg.scripts = {
    dev: "clove dev",
    ...(typescript ? { build: "clove build", start: "node dist/main.js" } : { start: "node main.js" }),
    ...pkg.scripts,
  }

  await writeFile(path, JSON.stringify(pkg, null, 2) + "\n", "utf8")
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
