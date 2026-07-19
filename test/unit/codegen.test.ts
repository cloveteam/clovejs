import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { generateTypes, tsconfigIncludeWarning } from "../../src/codegen/index.js"

const scratchRoot = join(dirname(fileURLToPath(import.meta.url)), "..", ".scratch")

let dir: string | undefined

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

async function project(files: Record<string, string>): Promise<string> {
  await mkdir(scratchRoot, { recursive: true })
  const root = await mkdtemp(join(scratchRoot, "codegen-"))
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(root, dirname(path)), { recursive: true })
    await writeFile(join(root, path), contents, "utf8")
  }
  return root
}

const SERVICE = `import { service } from "clovejs"\nexport default service(() => ({}))\n`
const DI = `import { di } from "clovejs"\nexport default di({ lifetime: "singleton", value: 1 })\n`

async function generated(root: string): Promise<string> {
  const out = await generateTypes({ rootDir: root, sourceDir: join(root, "src") })
  return readFile(out, "utf8")
}

describe("generateTypes imports", () => {
  it("imports only CloveService when the project has no di values", async () => {
    dir = await project({ "src/services/notes.ts": SERVICE })
    const types = await generated(dir)
    expect(types).toContain('import type { CloveService, Logger } from "clovejs"')
    expect(types).not.toContain("CloveDi")
  })

  it("imports only CloveDi when the project has no services", async () => {
    dir = await project({ "src/di/config.ts": DI })
    const types = await generated(dir)
    expect(types).toContain('import type { CloveDi, Logger } from "clovejs"')
    expect(types).not.toContain("CloveService")
  })

  it("drops the Logger import when the project overrides the logger", async () => {
    dir = await project({ "src/services/logger.ts": SERVICE })
    const types = await generated(dir)
    expect(types).toContain('import type { CloveService } from "clovejs"')
    expect(types).not.toContain("Logger")
  })
})

describe("tsconfigIncludeWarning", () => {
  it("warns on a bare .clove entry, which TypeScript silently ignores", async () => {
    dir = await project({ "tsconfig.json": '{ "include": ["src", ".clove"] }\n' })
    expect(await tsconfigIncludeWarning(dir)).toContain('".clove/**/*"')
  })

  it("warns when the include list never mentions .clove", async () => {
    dir = await project({ "tsconfig.json": '{ "include": ["src"] }\n' })
    expect(await tsconfigIncludeWarning(dir)).toContain('".clove/**/*"')
  })

  it("accepts a glob over the generated directory", async () => {
    dir = await project({ "tsconfig.json": '{ "include": ["src", ".clove/**/*"] }\n' })
    expect(await tsconfigIncludeWarning(dir)).toBeNull()
  })

  it("accepts the generated file listed in files", async () => {
    dir = await project({
      "tsconfig.json": '{ "files": ["./.clove/types.d.ts"], "include": ["src"] }\n',
    })
    expect(await tsconfigIncludeWarning(dir)).toBeNull()
  })

  it("stays quiet without a tsconfig, or with one it cannot parse", async () => {
    dir = await project({})
    expect(await tsconfigIncludeWarning(dir)).toBeNull()
    await writeFile(
      join(dir, "tsconfig.json"),
      '{ "include": ["src"], // a comment JSON.parse rejects\n}\n',
      "utf8",
    )
    expect(await tsconfigIncludeWarning(dir)).toBeNull()
  })
})
