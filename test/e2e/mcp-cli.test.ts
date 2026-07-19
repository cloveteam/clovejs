import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { execFile } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"
import { fixturePath } from "./helpers.js"

const run = promisify(execFile)
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const cli = join(root, "dist", "cli.js")

describe("clove mcp", () => {
  it("prints the MCP surface", async () => {
    const { stdout } = await run(process.execPath, [cli, "mcp", "--dir", fixturePath("mcp")])

    expect(stdout).toContain("Endpoint  /mcp")
    expect(stdout).toMatch(/tool\s+searchNotes\s+Full-text search/)
    expect(stdout).toMatch(/resource\s+notes:\/\/\{id\}/)
    expect(stdout).toMatch(/resource\s+config:\/\/app/)
    expect(stdout).toMatch(/prompt\s+summarize/)
  })

  it("says so when a project has no MCP definitions", async () => {
    const { stdout } = await run(process.execPath, [cli, "mcp", "--dir", fixturePath("basic")])
    expect(stdout).toContain("No MCP definitions found")
  })

  it("lists the endpoint in `clove routes`", async () => {
    const { stdout } = await run(process.execPath, [cli, "routes", "--dir", fixturePath("mcp")])
    expect(stdout).toContain("GET     /api/health")
    expect(stdout).toContain("MCP     /mcp")
  })
})

describe("clove mcp --stdio", () => {
  it("serves the same project over stdio", async () => {
    const client = new Client({ name: "stdio-test", version: "1.0.0" })
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [cli, "mcp", "--stdio", "--dir", fixturePath("mcp")],
      }),
    )

    try {
      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name)).toContain("searchNotes")

      const result = await client.callTool({
        name: "searchNotes",
        arguments: { query: "cloves" },
      })
      const content = result.content as Array<{ text: string }>
      expect(JSON.parse(content[0]!.text)[0]).toMatchObject({ title: "Groceries" })

      const note = await client.readResource({ uri: "notes://1" })
      expect(note.contents[0]!.uri).toBe("notes://1")

      // Logging must not reach stdout, which is the protocol stream.
      const listed = await client.listResources()
      expect(listed.resources.length).toBeGreaterThan(0)
    } finally {
      await client.close()
    }
  }, 30000)
})
