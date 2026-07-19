import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { startDevServer, type DevServer } from "../../src/dev/index.js"

const scratchRoot = join(dirname(fileURLToPath(import.meta.url)), "..", ".scratch")

let dir: string | undefined
let dev: DevServer | undefined

afterEach(async () => {
  await dev?.close()
  dev = undefined
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

async function project(files: Record<string, string>): Promise<string> {
  await mkdir(scratchRoot, { recursive: true })
  const root = await mkdtemp(join(scratchRoot, "dev-"))
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path)
    await mkdir(join(full, ".."), { recursive: true })
    await writeFile(full, contents, "utf8")
  }
  return root
}

const route = (message: string) =>
  `import { get } from "clovejs"\nexport default get(async () => ({ message: ${JSON.stringify(message)} }))\n`

/** Polls until the response body matches, or the attempts run out. */
async function waitFor(
  url: string,
  predicate: (body: any) => boolean,
  attempts = 50,
): Promise<any> {
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(url)
    const body = res.status === 200 ? await res.json() : undefined
    if (body !== undefined && predicate(body)) return body
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`Condition not met for ${url} after ${attempts} attempts`)
}

describe("dev server", () => {
  it("serves routes and picks up edits without a restart", async () => {
    dir = await project({ "api/hello.get.ts": route("first") })
    dev = await startDevServer({ rootDir: dir, port: 0, host: "127.0.0.1", logLevel: "silent" })

    const res = await fetch(`${dev.url}/api/hello`)
    expect(await res.json()).toEqual({ message: "first" })

    await writeFile(join(dir, "api/hello.get.ts"), route("second"), "utf8")
    const body = await waitFor(`${dev.url}/api/hello`, (b) => b.message === "second")
    expect(body).toEqual({ message: "second" })
  })

  it("picks up a newly added route file", async () => {
    dir = await project({ "api/hello.get.ts": route("hi") })
    dev = await startDevServer({ rootDir: dir, port: 0, host: "127.0.0.1", logLevel: "silent" })

    expect((await fetch(`${dev.url}/api/added`)).status).toBe(404)

    await writeFile(join(dir, "api/added.get.ts"), route("added"), "utf8")
    const body = await waitFor(`${dev.url}/api/added`, (b) => b.message === "added")
    expect(body).toEqual({ message: "added" })
  })

  it("picks up an edit to a service, not just a route", async () => {
    dir = await project({
      "api/hello.get.ts": `import { get } from "clovejs"\nexport default get(async (_r, _s, ctx) => ({ message: ctx.greeter.greet() }))\n`,
      "services/greeter.ts": `import { service } from "clovejs"\nexport default service(async () => ({ greet: () => "first" }))\n`,
    })
    dev = await startDevServer({ rootDir: dir, port: 0, host: "127.0.0.1", logLevel: "silent" })

    expect(await (await fetch(`${dev.url}/api/hello`)).json()).toEqual({
      message: "first",
    })

    await writeFile(
      join(dir, "services/greeter.ts"),
      `import { service } from "clovejs"\nexport default service(async () => ({ greet: () => "second" }))\n`,
      "utf8",
    )
    expect(await waitFor(`${dev.url}/api/hello`, (b) => b.message === "second")).toEqual({
      message: "second",
    })
  })

  it("recovers after a half-written file, without needing another save", async () => {
    dir = await project({
      "api/hello.get.ts": `import { get } from "clovejs"\nexport default get(async (_r, _s, ctx) => ({ message: ctx.greeter.greet() }))\n`,
      "services/greeter.ts": `import { service } from "clovejs"\nexport default service(async () => ({ greet: () => "first" }))\n`,
    })
    dev = await startDevServer({ rootDir: dir, port: 0, host: "127.0.0.1", logLevel: "silent" })

    // Mimic an editor saving in two steps: truncate, then write the content.
    const target = join(dir, "services/greeter.ts")
    await writeFile(target, "", "utf8")
    await writeFile(
      target,
      `import { service } from "clovejs"\nexport default service(async () => ({ greet: () => "second" }))\n`,
      "utf8",
    )

    expect(await waitFor(`${dev.url}/api/hello`, (b) => b.message === "second")).toEqual({
      message: "second",
    })
  })

  it("keeps serving the previous build when a reload fails", async () => {
    dir = await project({ "api/hello.get.ts": route("good") })
    dev = await startDevServer({ rootDir: dir, port: 0, host: "127.0.0.1", logLevel: "silent" })

    // A route file exporting the wrong thing fails validation at boot.
    await writeFile(
      join(dir, "api/broken.get.ts"),
      `export const nope = 1\n`,
      "utf8",
    )
    await new Promise((r) => setTimeout(r, 600))

    const res = await fetch(`${dev.url}/api/hello`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ message: "good" })
  })

  it("generates types on start and regenerates them on change", async () => {
    dir = await project({
      "api/hello.get.ts": route("hi"),
      "services/greeter.ts": `import { service } from "clovejs"\nexport default service(async () => ({ hi: () => "hi" }))\n`,
    })
    dev = await startDevServer({ rootDir: dir, port: 0, host: "127.0.0.1", logLevel: "silent" })

    const typesPath = join(dir, ".clove", "types.d.ts")
    expect(await readFile(typesPath, "utf8")).toContain("greeter")

    await writeFile(
      join(dir, "services/mailer.ts"),
      `import { service } from "clovejs"\nexport default service(async () => ({ send: () => true }))\n`,
      "utf8",
    )

    for (let i = 0; i < 50; i++) {
      if ((await readFile(typesPath, "utf8")).includes("mailer")) break
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(await readFile(typesPath, "utf8")).toContain("mailer")
  })
})
