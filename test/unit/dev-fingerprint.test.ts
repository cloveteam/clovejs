import { mkdtemp, mkdir, rm, writeFile, utimes } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { fingerprint } from "../../src/dev/index.js"

const scratchRoot = join(dirname(fileURLToPath(import.meta.url)), "..", ".scratch")

let dir: string | undefined

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

async function project(files: Record<string, string> = {}): Promise<string> {
  await mkdir(scratchRoot, { recursive: true })
  const root = await mkdtemp(join(scratchRoot, "fp-"))
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path)
    await mkdir(join(full, ".."), { recursive: true })
    await writeFile(full, contents, "utf8")
  }
  return root
}

/**
 * The detector behind the dev server's startup reconciliation sweeps.
 *
 * A recursive filesystem watch can report itself ready before the OS is
 * actually delivering events, so a file saved moments after `clove dev` starts
 * is dropped outright — no error, no retry. The sweeps compare the tree
 * against what the app was built from, which only works if this notices every
 * kind of change a reload would care about.
 */
describe("fingerprint", () => {
  it("is stable when nothing changes", async () => {
    dir = await project({ "services/a.ts": "export default 1\n" })
    expect(await fingerprint(dir)).toBe(await fingerprint(dir))
  })

  it("notices a new file", async () => {
    dir = await project({ "services/a.ts": "export default 1\n" })
    const before = await fingerprint(dir)

    await writeFile(join(dir, "services/b.ts"), "export default 2\n", "utf8")
    expect(await fingerprint(dir)).not.toBe(before)
  })

  it("notices a new file in a new directory", async () => {
    dir = await project({ "services/a.ts": "export default 1\n" })
    const before = await fingerprint(dir)

    await mkdir(join(dir, "api"), { recursive: true })
    await writeFile(join(dir, "api/hello.get.ts"), "export default 1\n", "utf8")
    expect(await fingerprint(dir)).not.toBe(before)
  })

  it("notices an edit that changes the file's length", async () => {
    dir = await project({ "services/a.ts": "export default 1\n" })
    const before = await fingerprint(dir)

    await writeFile(join(dir, "services/a.ts"), "export default 12345\n", "utf8")
    expect(await fingerprint(dir)).not.toBe(before)
  })

  it("notices a same-length edit, via the modification time", async () => {
    dir = await project({ "services/a.ts": "export default 1\n" })
    const before = await fingerprint(dir)

    // Same byte count, so size alone would miss it.
    await writeFile(join(dir, "services/a.ts"), "export default 2\n", "utf8")
    await utimes(join(dir, "services/a.ts"), new Date(), new Date(Date.now() + 1000))
    expect(await fingerprint(dir)).not.toBe(before)
  })

  it("notices a deleted file", async () => {
    dir = await project({
      "services/a.ts": "export default 1\n",
      "services/b.ts": "export default 2\n",
    })
    const before = await fingerprint(dir)

    await rm(join(dir, "services/b.ts"))
    expect(await fingerprint(dir)).not.toBe(before)
  })

  it("ignores the generated types it would otherwise trigger on", async () => {
    dir = await project({ "services/a.ts": "export default 1\n" })
    const before = await fingerprint(dir)

    // Written by `generateTypes` on every reload. Counting it would make each
    // sweep see drift and rebuild forever.
    await mkdir(join(dir, ".clove"), { recursive: true })
    await writeFile(join(dir, ".clove/types.d.ts"), "export {}\n", "utf8")
    expect(await fingerprint(dir)).toBe(before)
  })

  it("ignores files the watcher ignores, so the two cannot disagree", async () => {
    dir = await project({ "services/a.ts": "export default 1\n" })
    const before = await fingerprint(dir)

    await mkdir(join(dir, "node_modules/pkg"), { recursive: true })
    await writeFile(join(dir, "node_modules/pkg/index.js"), "module.exports = 1\n", "utf8")
    await writeFile(join(dir, "services/a.ts~"), "editor backup\n", "utf8")
    await writeFile(join(dir, "README.md"), "# not source\n", "utf8")

    expect(await fingerprint(dir)).toBe(before)
  })

  it("survives a directory that does not exist", async () => {
    expect(await fingerprint(join(scratchRoot, "definitely-not-here"))).toBe("")
  })
})
