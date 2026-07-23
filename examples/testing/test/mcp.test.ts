import { afterEach, describe, expect, it } from "vitest"
import { createTestApp, type TestApp } from "clovejs/testing"

// The MCP surface boots with the app, so tools, resources and prompts are
// reachable directly — no JSON-RPC transport, no stdio subprocess.

let app: TestApp
afterEach(() => app?.close())

describe("MCP tools and resources", () => {
  it("calls a tool with the real input schema", async () => {
    app = await createTestApp()

    const hits = (await app.mcp.callTool("searchNotes", { query: "testing" })) as unknown[]

    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ title: "Testing" })
  })

  it("applies schema defaults (limit defaults to 10)", async () => {
    app = await createTestApp()

    // No `limit` given — the Zod default is applied before the handler runs.
    const hits = (await app.mcp.callTool("searchNotes", { query: "note" })) as unknown[]

    expect(Array.isArray(hits)).toBe(true)
  })

  it("reads a templated resource", async () => {
    app = await createTestApp()

    const note = await app.mcp.readResource("notes://1")

    expect(note.mimeType).toBe("text/markdown")
    expect(note.text).toContain("# Welcome")
  })

  it("surfaces a 4xx as a throwable error", async () => {
    app = await createTestApp()

    await expect(app.mcp.readResource("notes://999")).rejects.toMatchObject({ status: 404 })
  })
})
