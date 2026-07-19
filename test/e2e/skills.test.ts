import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { installSkills, unknownIdes, TARGETS } from "../../src/cli/skills/index.js"

const scratchRoot = join(dirname(fileURLToPath(import.meta.url)), "..", ".scratch")

let dir: string | undefined

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

async function scratch(): Promise<string> {
  await mkdir(scratchRoot, { recursive: true })
  return mkdtemp(join(scratchRoot, "skills-"))
}

describe("clove skills", () => {
  it("writes a file for every editor in its own format", async () => {
    dir = await scratch()
    const result = await installSkills({ rootDir: dir })

    expect(result.written).toEqual(TARGETS.map((t) => t.path))

    const claude = await readFile(join(dir, ".claude/skills/clovejs/SKILL.md"), "utf8")
    expect(claude).toMatch(/^---\nname: clovejs\n/)
    expect(claude).toContain("handler.execute()")

    const cursor = await readFile(join(dir, ".cursor/rules/clovejs.mdc"), "utf8")
    expect(cursor).toContain("globs: **/api/**,")
    expect(cursor).toContain("alwaysApply: false")

    const antigravity = await readFile(join(dir, ".antigravity/rules/clovejs.md"), "utf8")
    expect(antigravity).toContain("# CloveJS")

    const agents = await readFile(join(dir, "AGENTS.md"), "utf8")
    expect(agents).toContain("<!-- clovejs:begin -->")
    expect(agents).toContain("<!-- clovejs:end -->")
  })

  it("installs only the editors named by --ide", async () => {
    dir = await scratch()
    const result = await installSkills({ rootDir: dir, ides: ["cursor"] })

    expect(result.written).toEqual([".cursor/rules/clovejs.mdc"])
    await expect(readFile(join(dir, "AGENTS.md"), "utf8")).rejects.toThrow()
  })

  it("leaves files it owns alone unless forced", async () => {
    dir = await scratch()
    await installSkills({ rootDir: dir, ides: ["cursor"] })
    await writeFile(join(dir, ".cursor/rules/clovejs.mdc"), "// mine\n", "utf8")

    const second = await installSkills({ rootDir: dir, ides: ["cursor"] })
    expect(second.skipped).toEqual([".cursor/rules/clovejs.mdc"])
    expect(await readFile(join(dir, ".cursor/rules/clovejs.mdc"), "utf8")).toBe("// mine\n")

    const forced = await installSkills({ rootDir: dir, ides: ["cursor"], force: true })
    expect(forced.updated).toEqual([".cursor/rules/clovejs.mdc"])
    expect(await readFile(join(dir, ".cursor/rules/clovejs.mdc"), "utf8")).toContain("CloveJS")
  })

  it("preserves unrelated content in an existing AGENTS.md", async () => {
    dir = await scratch()
    await writeFile(join(dir, "AGENTS.md"), "# House rules\n\nRun the linter.\n", "utf8")
    await installSkills({ rootDir: dir, ides: ["codex"] })

    const agents = await readFile(join(dir, "AGENTS.md"), "utf8")
    expect(agents).toContain("Run the linter.")
    expect(agents).toContain("## CloveJS")
  })

  it("replaces its own AGENTS.md block instead of appending a second one", async () => {
    dir = await scratch()
    await installSkills({ rootDir: dir, ides: ["codex"] })
    const first = await readFile(join(dir, "AGENTS.md"), "utf8")

    // A stale block, as if written by an older version of the CLI.
    await writeFile(
      join(dir, "AGENTS.md"),
      first.replace("## CloveJS", "## CloveJS (old)"),
      "utf8",
    )

    const second = await installSkills({ rootDir: dir, ides: ["codex"] })
    expect(second.updated).toEqual(["AGENTS.md"])

    const agents = await readFile(join(dir, "AGENTS.md"), "utf8")
    expect(agents).not.toContain("## CloveJS (old)")
    expect(agents.match(/<!-- clovejs:begin -->/g)).toHaveLength(1)
  })

  it("is a no-op on an AGENTS.md that is already up to date", async () => {
    dir = await scratch()
    await installSkills({ rootDir: dir, ides: ["codex"] })
    const before = await readFile(join(dir, "AGENTS.md"), "utf8")

    const second = await installSkills({ rootDir: dir, ides: ["codex"] })
    expect(second.skipped).toEqual(["AGENTS.md"])
    expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toBe(before)
  })

  it("reports editor ids it does not know", () => {
    expect(unknownIdes(["cursor", "notepad"])).toEqual(["notepad"])
    expect(unknownIdes(TARGETS.map((t) => t.id))).toEqual([])
  })
})
