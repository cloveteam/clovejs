import { afterEach, describe, expect, it } from "vitest"
import type { Clove } from "../../src/index.js"
import { Client, startFixture } from "./helpers.js"

const KEYS = [
  "CLOVE_FIXTURE_PLAIN",
  "CLOVE_FIXTURE_MODE",
  "CLOVE_FIXTURE_LOCAL",
  "CLOVE_FIXTURE_OVERRIDE",
  "CLOVE_FIXTURE_QUOTED",
]

let clove: Clove | undefined

afterEach(async () => {
  await clove?.close()
  clove = undefined
  for (const key of KEYS) delete process.env[key]
})

async function boot(options = {}): Promise<any> {
  // The fixture snapshots process.env at module scope, so every boot has to
  // re-evaluate it rather than replay a cached module.
  clove = await startFixture("env", { moduleCache: false, ...options })
  const client = new Client(clove.url)
  return (await client.get("/api/config")).json
}

describe("dotenv loading", () => {
  it("makes .env values visible to modules evaluated during boot", async () => {
    const config = await boot()
    expect(config.fromEnv).toBe("plain-value")
  })

  it("prefers .env.test over .env under NODE_ENV=test", async () => {
    const config = await boot()
    expect(config.fromModeFile).toBe("from-test")
  })

  it("ignores .env.local in test mode", async () => {
    const config = await boot()
    expect(config.fromLocalFile).toBeNull()
  })

  it("lets the real environment win over the file", async () => {
    process.env.CLOVE_FIXTURE_OVERRIDE = "from-shell"
    const config = await boot()
    expect(config.overridden).toBe("from-shell")
  })

  it("parses a quoted value containing a hash", async () => {
    const config = await boot()
    expect(config.quoted).toBe("a#b with spaces")
  })

  it("loads nothing when env is disabled", async () => {
    const config = await boot({ env: false })
    expect(config.fromEnv).toBeNull()
    expect(config.fromModeFile).toBeNull()
  })
})
