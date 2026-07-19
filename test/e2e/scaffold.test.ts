import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { scaffold } from "../../src/cli/scaffold.js"
import { generateTypes } from "../../src/codegen/index.js"
import { createApp } from "../../src/index.js"

const scratchRoot = join(dirname(fileURLToPath(import.meta.url)), "..", ".scratch")

let dir: string | undefined

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

async function scratch(): Promise<string> {
  await mkdir(scratchRoot, { recursive: true })
  return mkdtemp(join(scratchRoot, "scaffold-"))
}

async function isDir(path: string): Promise<boolean> {
  return stat(path)
    .then((s) => s.isDirectory())
    .catch(() => false)
}

describe("scaffold", () => {
  it("creates the TypeScript layout from the concept document", async () => {
    dir = await scratch()
    const result = await scaffold({ rootDir: dir, typescript: true })

    for (const sub of ["api", "ws", "di", "services", "middlewares"]) {
      expect(await isDir(join(dir, "src", sub))).toBe(true)
    }
    expect(result.created).toContain("src/main.ts")
    expect(result.created).toContain("tsconfig.json")

    const tsconfig = JSON.parse(await readFile(join(dir, "tsconfig.json"), "utf8"))
    expect(tsconfig.include).toContain(".clove")

    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"))
    expect(pkg.scripts.dev).toBe("clove dev")
    expect(pkg.type).toBe("module")

    const gitignore = await readFile(join(dir, ".gitignore"), "utf8")
    expect(gitignore).toContain(".clove/")
  })

  it("creates the JavaScript layout at the project root", async () => {
    dir = await scratch()
    await scaffold({ rootDir: dir, typescript: false })

    expect(await isDir(join(dir, "api"))).toBe(true)
    expect(await isDir(join(dir, "src"))).toBe(false)
    await expect(readFile(join(dir, "main.js"), "utf8")).resolves.toContain("bootstrap")
  })

  it("does not overwrite existing files unless forced", async () => {
    dir = await scratch()
    await scaffold({ rootDir: dir, typescript: true })
    await writeFile(join(dir, "src/main.ts"), "// mine\n", "utf8")

    const second = await scaffold({ rootDir: dir, typescript: true })
    expect(second.skipped).toContain("src/main.ts")
    expect(await readFile(join(dir, "src/main.ts"), "utf8")).toBe("// mine\n")

    const forced = await scaffold({ rootDir: dir, typescript: true, force: true })
    expect(forced.created).toContain("src/main.ts")
    expect(await readFile(join(dir, "src/main.ts"), "utf8")).toContain("bootstrap")
  })

  it("produces a project that boots and serves its example route", async () => {
    dir = await scratch()
    await scaffold({ rootDir: dir, typescript: true })

    const app = await createApp({ rootDir: dir, logLevel: "silent" })
    try {
      expect(app.routes.list().map((r) => `${r.method} ${r.path}`)).toEqual([
        "GET /api/hello",
      ])
      expect(app.registry.has("greeter")).toBe(true)
      expect(app.registry.has("config")).toBe(true)
    } finally {
      await app.close()
    }
  })

  it("generates types the scaffolded tsconfig picks up", async () => {
    dir = await scratch()
    await scaffold({ rootDir: dir, typescript: true })
    const out = await generateTypes({ rootDir: dir, sourceDir: join(dir, "src") })

    const contents = await readFile(out, "utf8")
    expect(contents).toContain("interface Ctx")
    expect(contents).toContain("greeter")
    expect(contents).toContain("config")
  })
})

describe("codegen", () => {
  it("emits a valid empty declaration for a project with no providers", async () => {
    dir = await scratch()
    await mkdir(join(dir, "api"), { recursive: true })
    const out = await generateTypes({ rootDir: dir, sourceDir: dir })
    const contents = await readFile(out, "utf8")
    expect(contents).toContain("interface Ctx {}")
    expect(contents).toContain("export {}")
  })

  it("camelCases nested provider paths", async () => {
    dir = await scratch()
    await mkdir(join(dir, "di", "db"), { recursive: true })
    await writeFile(
      join(dir, "di/db/pool.ts"),
      `import { di } from "clovejs"\nexport default di({ lifetime: "singleton", value: 1 })\n`,
      "utf8",
    )
    const out = await generateTypes({ rootDir: dir, sourceDir: dir })
    expect(await readFile(out, "utf8")).toContain("dbPool:")
  })

  it("declares the built-in logger unless the project overrides it", async () => {
    dir = await scratch()
    await mkdir(join(dir, "services"), { recursive: true })
    await writeFile(
      join(dir, "services/thing.ts"),
      `import { service } from "clovejs"\nexport default service(async () => ({}))\n`,
      "utf8",
    )
    const out = await generateTypes({ rootDir: dir, sourceDir: dir })
    expect(await readFile(out, "utf8")).toContain("logger: Logger")

    await writeFile(
      join(dir, "services/logger.ts"),
      `import { service } from "clovejs"\nexport default service(async () => ({ info() {} }))\n`,
      "utf8",
    )
    const out2 = await generateTypes({ rootDir: dir, sourceDir: dir })
    const contents = await readFile(out2, "utf8")
    expect(contents).not.toContain("logger: Logger")
    expect(contents).toContain("logger: CloveService")
  })
})
