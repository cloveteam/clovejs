import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Clove } from "../../src/index.js"
import { startFixture } from "./helpers.js"

let clove: Clove

/** Connects a real MCP client carrying a bearer token on every request. */
async function connect(token?: string): Promise<{ client: Client; sessionId?: string }> {
  const client = new Client({ name: "test-client", version: "1.0.0" })
  const transport = new StreamableHTTPClientTransport(new URL(`${clove.url}/mcp`), {
    requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : {},
  })
  await client.connect(transport)
  return { client, sessionId: transport.sessionId }
}

/** The text payload of a tool result. */
function resultText(result: any): string {
  return (result.content ?? []).map((c: any) => c.text).join("")
}

beforeAll(async () => {
  clove = await startFixture("mcp-auth")
})

afterAll(async () => {
  await clove?.close()
})

describe("challenge and discovery", () => {
  it("rejects an unauthenticated request with a WWW-Authenticate challenge", async () => {
    const res = await fetch(`${clove.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } },
      }),
    })
    expect(res.status).toBe(401)
    const header = res.headers.get("www-authenticate") ?? ""
    expect(header).toMatch(/^Bearer /)
    expect(header).toContain("resource_metadata=")
    expect(header).toContain("/.well-known/oauth-protected-resource/mcp")
  })

  it("rejects an unknown token with 401", async () => {
    const res = await fetch(`${clove.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer nope",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    })
    expect(res.status).toBe(401)
  })

  it("serves RFC 9728 protected-resource metadata", async () => {
    const res = await fetch(`${clove.url}/.well-known/oauth-protected-resource/mcp`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.resource).toBe(`${clove.url}/mcp`)
    expect(body.authorization_servers).toEqual(["https://auth.test"])
    expect(body.scopes_supported).toContain("notes:write")
    expect(body.bearer_methods_supported).toEqual(["header"])
  })
})

describe("authenticated calls", () => {
  it("exposes the principal to a tool via args.auth", async () => {
    const { client, sessionId } = await connect("acme-rw")
    const result = await client.callTool({ name: "whoami", arguments: {} })
    expect(JSON.parse(resultText(result))).toEqual({
      subject: "ada@acme",
      tenant: "acme",
      scopes: ["notes:read", "notes:write"],
      sessionId,
    })
    await client.close()
  })

  it("isolates data by tenant", async () => {
    const acme = await connect("acme-rw")
    await acme.client.callTool({ name: "addNote", arguments: { title: "Acme secret" } })
    const acmeNotes = JSON.parse(resultText(await acme.client.callTool({ name: "listNotes", arguments: {} })))
    expect(acmeNotes.map((n: any) => n.title)).toContain("Acme secret")

    const globex = await connect("globex-rw")
    const globexNotes = JSON.parse(resultText(await globex.client.callTool({ name: "listNotes", arguments: {} })))
    expect(globexNotes.map((n: any) => n.title)).not.toContain("Acme secret")
    expect(globexNotes).toEqual([{ id: 1, title: "globex welcome" }])

    await acme.client.close()
    await globex.client.close()
  })

  it("enforces scopes: a read-only token cannot write", async () => {
    const { client } = await connect("acme-ro")
    const result = await client.callTool({ name: "addNote", arguments: { title: "nope" } })
    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain("notes:write")
    await client.close()
  })
})

describe("tenant binding", () => {
  it("refuses to let another tenant's token ride an existing session", async () => {
    const { client, sessionId } = await connect("acme-rw")
    const res = await fetch(`${clove.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer globex-rw",
        "mcp-session-id": sessionId!,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as any
    expect(body.error.message).toContain("tenant")
    await client.close()
  })
})
