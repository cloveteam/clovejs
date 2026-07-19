import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { createApp, CloveBootError } from "../../src/index.js"

// Throwaway projects live inside the repo rather than the OS temp directory so
// that `import "clovejs"` resolves through node_modules, exactly as it would
// in a real project.
const scratchRoot = join(dirname(fileURLToPath(import.meta.url)), "..", ".scratch")

let dir: string | undefined

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

/**
 * Writes a throwaway project and tries to boot it.
 *
 * Fixtures are `.ts` so they load through jiti. Plain `.js` would go through a
 * native dynamic import, which vitest's module runner intercepts — fine in a
 * real Node process, but not inside this test harness.
 */
async function boot(files: Record<string, string>): Promise<void> {
  await mkdir(scratchRoot, { recursive: true })
  dir = await mkdtemp(join(scratchRoot, "boot-"))
  for (const [path, contents] of Object.entries(files)) {
    const full = join(dir, path)
    await mkdir(join(full, ".."), { recursive: true })
    await writeFile(full, contents, "utf8")
  }
  const app = await createApp({ rootDir: dir, logLevel: "silent" })
  await app.close()
}

describe("boot-time validation", () => {
  it("names both files when two routes resolve to the same path", async () => {
    const promise = boot({
      "api/users.get.ts": `import { get } from "clovejs"\nexport default get(async () => [])\n`,
      "api/users/get.ts": `import { get } from "clovejs"\nexport default get(async () => [])\n`,
    })
    await expect(promise).rejects.toThrow(CloveBootError)
    await expect(promise).rejects.toThrow(/Duplicate route: GET \/api\/users/)
    await expect(promise).rejects.toThrow(/users\.get\.ts/)
    await expect(promise).rejects.toThrow(/users[/\\]get\.ts/)
  })

  it("rejects a filename method that disagrees with the wrapper", async () => {
    const promise = boot({
      "api/thing.post.ts": `import { get } from "clovejs"\nexport default get(async () => ({}))\n`,
    })
    await expect(promise).rejects.toThrow(/Method mismatch/)
    await expect(promise).rejects.toThrow(/thing\.post\.ts/)
  })

  it("rejects a route file that exports the wrong definition", async () => {
    const promise = boot({
      "api/thing.get.ts": `import { service } from "clovejs"\nexport default service(async () => ({}))\n`,
    })
    await expect(promise).rejects.toThrow(/must default-export a route handler/)
  })

  it("rejects a route file with no default export", async () => {
    const promise = boot({
      "api/thing.get.ts": `export const notDefault = 1\n`,
    })
    await expect(promise).rejects.toThrow(/no default export/)
  })

  it("rejects two providers claiming the same ctx key", async () => {
    const promise = boot({
      "services/thing.ts": `import { service } from "clovejs"\nexport default service(async () => ({}))\n`,
      "di/thing.ts": `import { di } from "clovejs"\nexport default di({ lifetime: "singleton", value: 1 })\n`,
    })
    await expect(promise).rejects.toThrow(/Duplicate context key "thing"/)
  })

  it("rejects an unknown lifetime", async () => {
    const promise = boot({
      "di/thing.ts": `import { di } from "clovejs"\nexport default di({ lifetime: "forever", value: 1 })\n`,
    })
    await expect(promise).rejects.toThrow(/Unknown lifetime "forever"/)
  })

  it("rejects mismatched parameter names at the same position", async () => {
    const promise = boot({
      "api/users/[id].get.ts": `import { get } from "clovejs"\nexport default get(async () => ({}))\n`,
      "api/users/[userId]/books.get.ts": `import { get } from "clovejs"\nexport default get(async () => [])\n`,
    })
    await expect(promise).rejects.toThrow(/parameter name conflict/i)
  })

  it("boots an empty project without complaint", async () => {
    await expect(boot({})).resolves.toBeUndefined()
  })
})
