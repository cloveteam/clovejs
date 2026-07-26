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

  it("rejects a web file that exports the wrong definition", async () => {
    const promise = boot({
      "web/page.get.ts": `import { service } from "clovejs"\nexport default service(async () => ({}))\n`,
    })
    await expect(promise).rejects.toThrow(CloveBootError)
    await expect(promise).rejects.toThrow(/Files in web\/ must default-export a route handler/)
  })

  it("rejects a views file that exports the wrong definition", async () => {
    const promise = boot({
      "views.ts": `import { service } from "clovejs"\nexport default service(async () => ({}))\n`,
    })
    await expect(promise).rejects.toThrow(CloveBootError)
    await expect(promise).rejects.toThrow(/views\.ts must default-export views\(\.\.\.\)/)
  })

  it("boots an empty project without complaint", async () => {
    await expect(boot({})).resolves.toBeUndefined()
  })
})

describe("mcp validation", () => {
  it("rejects an mcp/tools file that exports the wrong definition", async () => {
    const promise = boot({
      "mcp/tools/thing.ts": `import { get } from "clovejs"\nexport default get(async () => ({}))\n`,
    })
    await expect(promise).rejects.toThrow(/must default-export tool\(\.\.\.\)/)
    await expect(promise).rejects.toThrow(/thing\.ts/)
  })

  it("rejects a resource() placed in mcp/tools/", async () => {
    const promise = boot({
      "mcp/tools/thing.ts":
        `import { resource } from "clovejs/mcp"\n` +
        `export default resource({ description: "x", handler: async () => "" })\n`,
    })
    await expect(promise).rejects.toThrow(/must default-export tool\(\.\.\.\)/)
  })

  it("rejects a prompt() placed in mcp/resources/", async () => {
    const promise = boot({
      "mcp/resources/thing.ts":
        `import { prompt } from "clovejs/mcp"\n` +
        `export default prompt({ description: "x", handler: async () => "" })\n`,
    })
    await expect(promise).rejects.toThrow(/must default-export resource\(\.\.\.\)/)
  })

  it("names both files when two tools claim the same name", async () => {
    const tool = (name: string) =>
      `import { tool } from "clovejs/mcp"\n` +
      `export default tool({ name: ${JSON.stringify(name)}, description: "x", handler: async () => "" })\n`

    const promise = boot({
      "mcp/tools/a.ts": tool("search"),
      "mcp/tools/b.ts": tool("search"),
    })
    await expect(promise).rejects.toThrow(/Duplicate tool name "search"/)
    await expect(promise).rejects.toThrow(/a\.ts/)
    await expect(promise).rejects.toThrow(/b\.ts/)
  })

  it("names both files when two resources claim the same URI", async () => {
    const promise = boot({
      "mcp/resources/notes/[id].ts":
        `import { resource } from "clovejs/mcp"\n` +
        `export default resource({ description: "x", handler: async () => "" })\n`,
      "mcp/resources/other.ts":
        `import { resource } from "clovejs/mcp"\n` +
        `export default resource({ uri: "notes://{id}", description: "x", handler: async () => "" })\n`,
    })
    await expect(promise).rejects.toThrow(/Duplicate resource URI "notes:\/\/\{id\}"/)
  })

  it("rejects a non-object input schema", async () => {
    const promise = boot({
      "mcp/tools/thing.ts":
        `import { tool } from "clovejs/mcp"\nimport { z } from "zod"\n` +
        `export default tool({ description: "x", input: z.string() as any, handler: async () => "" })\n`,
    })
    await expect(promise).rejects.toThrow(/must be an object schema/)
  })

  it("rejects a non-string prompt argument, which MCP cannot transport", async () => {
    const promise = boot({
      "mcp/prompts/thing.ts":
        `import { prompt } from "clovejs/mcp"\nimport { z } from "zod"\n` +
        `export default prompt({ description: "x", input: z.object({ n: z.number() }), handler: async () => "" })\n`,
    })
    await expect(promise).rejects.toThrow(/transports prompt arguments as strings/)
  })

  it("boots a project with no mcp/ directory", async () => {
    await expect(
      boot({ "api/ok.get.ts": `import { get } from "clovejs"\nexport default get(async () => ({}))\n` }),
    ).resolves.toBeUndefined()
  })
})

describe("message bus", () => {
  /** A bus file whose capabilities are whatever the test needs to prove. */
  const busFile = (caps: Record<string, boolean>): string =>
    `import { bus } from "clovejs/bus"\n` +
    `export default bus({\n` +
    `  capabilities: ${JSON.stringify(caps)},\n` +
    `  async publish() {},\n` +
    `  async subscribe() { return { async close() {} } },\n` +
    `})\n`

  const FULL = {
    redelivery: true,
    attempts: true,
    delayedRetry: true,
    patterns: true,
    confirms: true,
  }

  const consumerFile = (spec: string, chain = ""): string =>
    `import { consume } from "clovejs/bus"\n` +
    `export default consume({ ${spec}, handler: async () => {} })${chain}\n`

  it("names both files when a consumer names a bus that does not exist", async () => {
    const promise = boot({
      "bus/events.ts": busFile(FULL),
      "consumers/a.ts": consumerFile(
        `bus: "typo", channel: "c", subscription: "s"`,
      ),
    })
    await expect(promise).rejects.toThrow(CloveBootError)
    await expect(promise).rejects.toThrow(/Unknown bus "typo".*defines: events/s)
  })

  it("refuses consumers with no bus at all, rather than inventing one", async () => {
    const promise = boot({
      "consumers/a.ts": consumerFile(`bus: "events", channel: "c", subscription: "s"`),
    })
    await expect(promise).rejects.toThrow(/no bus\/ directory/)
  })

  it("names both files when two consumers claim one bus, channel and subscription", async () => {
    const promise = boot({
      "bus/events.ts": busFile(FULL),
      "consumers/a.ts": consumerFile(`bus: "events", channel: "c", subscription: "s"`),
      "consumers/b.ts": consumerFile(`bus: "events", channel: "c", subscription: "s"`),
    })
    await expect(promise).rejects.toThrow(/Duplicate consumer for channel "c"/)
    await expect(promise).rejects.toThrow(/a\.ts/)
    await expect(promise).rejects.toThrow(/b\.ts/)
  })

  it("allows two consumers on one channel under different subscriptions", async () => {
    await expect(
      boot({
        "bus/events.ts": busFile(FULL),
        "consumers/billing.ts": consumerFile(
          `bus: "events", channel: "orders.created", subscription: "billing"`,
        ),
        "consumers/email.ts": consumerFile(
          `bus: "events", channel: "orders.created", subscription: "email"`,
        ),
      }),
    ).resolves.toBeUndefined()
  })

  it("refuses retry() on a bus that never redelivers", async () => {
    const promise = boot({
      "bus/fanout.ts": busFile({ ...FULL, redelivery: false, attempts: false }),
      "consumers/a.ts": consumerFile(
        `bus: "fanout", channel: "c", subscription: "s"`,
        `.retry({ attempts: 3 })`,
      ),
    })
    await expect(promise).rejects.toThrow(/redelivery: false/)
    await expect(promise).rejects.toThrow(/retrying cannot happen/)
  })

  it("refuses retry() on a bus that cannot count attempts, so the cap never fires", async () => {
    const promise = boot({
      "bus/events.ts": busFile({ ...FULL, attempts: false }),
      "consumers/a.ts": consumerFile(
        `bus: "events", channel: "c", subscription: "s"`,
        `.retry({ attempts: 3 })`,
      ),
    })
    await expect(promise).rejects.toThrow(/attempts: false/)
    await expect(promise).rejects.toThrow(/redeliver forever/)
  })

  it("refuses a backoff the bus would silently drop", async () => {
    const promise = boot({
      "bus/events.ts": busFile({ ...FULL, delayedRetry: false }),
      "consumers/a.ts": consumerFile(
        `bus: "events", channel: "c", subscription: "s"`,
        `.retry({ attempts: 3, backoff: { base: 500 } })`,
      ),
    })
    await expect(promise).rejects.toThrow(/delayedRetry: false/)
  })

  it("refuses a wildcard selector on a bus without pattern support", async () => {
    const promise = boot({
      "bus/events.ts": busFile({ ...FULL, patterns: false }),
      "consumers/a.ts": consumerFile(
        `bus: "events", channel: "orders.#", subscription: "s"`,
      ),
    })
    await expect(promise).rejects.toThrow(/patterns: false/)
  })

  it("allows retry() with no backoff against a bus that cannot delay", async () => {
    await expect(
      boot({
        "bus/events.ts": busFile({ ...FULL, delayedRetry: false }),
        "consumers/a.ts": consumerFile(
          `bus: "events", channel: "c", subscription: "s"`,
          `.retry({ attempts: 3 })`,
        ),
      }),
    ).resolves.toBeUndefined()
  })

  it("names the file when a bus resolves to something that is not a bus", async () => {
    const promise = boot({
      "bus/events.ts": `import { bus } from "clovejs/bus"\nexport default bus({} as any)\n`,
    })
    await expect(promise).rejects.toThrow(/must resolve to a MessageBus/)
    await expect(promise).rejects.toThrow(/no publish\(\) method/)
  })

  it("names the file when capabilities are incomplete", async () => {
    const promise = boot({
      "bus/events.ts":
        `import { bus } from "clovejs/bus"\n` +
        `export default bus({ capabilities: { redelivery: true } as any, ` +
        `async publish() {}, async subscribe() { return { async close() {} } } })\n`,
    })
    await expect(promise).rejects.toThrow(/capabilities.attempts is undefined/)
  })

  it("rejects a consumer missing a required field", async () => {
    const promise = boot({
      "bus/events.ts": busFile(FULL),
      "consumers/a.ts": consumerFile(`bus: "events", channel: "", subscription: "s"`),
    })
    await expect(promise).rejects.toThrow(/consume\(\{ channel \}\) is required/)
  })

  it("rejects `eager` on a plain di value, which has nothing to run", async () => {
    const promise = boot({
      "di/thing.ts":
        `import { di } from "clovejs"\n` +
        `export default di({ lifetime: "request", eager: true, value: { a: 1 } })\n`,
    })
    await expect(promise).rejects.toThrow(/only makes sense with a factory/)
  })

  it("refuses a service that claims the reserved `bus` key", async () => {
    const promise = boot({
      "services/bus.ts": `import { service } from "clovejs"\nexport default service(async () => ({}))\n`,
    })
    await expect(promise).rejects.toThrow(/`ctx.bus` is reserved by CloveJS/)
  })

  it("boots a project with no bus/ directory", async () => {
    await expect(
      boot({ "api/ok.get.ts": `import { get } from "clovejs"\nexport default get(async () => ({}))\n` }),
    ).resolves.toBeUndefined()
  })
})
