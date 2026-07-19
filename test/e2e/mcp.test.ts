import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Clove } from "../../src/index.js"
import { startFixture } from "./helpers.js"

let clove: Clove

/** Reads the text of a resource content entry, which may instead be a blob. */
function textOf(entry: unknown): string {
  const text = (entry as { text?: unknown } | undefined)?.text
  if (typeof text !== "string") throw new Error("expected a text resource")
  return text
}

/** Connects a real MCP client, so the protocol itself is under test too. */
async function connect(): Promise<Client> {
  const client = new Client({ name: "test-client", version: "1.0.0" })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${clove.url}/mcp`)))
  return client
}

beforeAll(async () => {
  clove = await startFixture("mcp")
})

afterAll(async () => {
  await clove?.close()
})

describe("discovery", () => {
  it("lists every tool with its derived name", async () => {
    const client = await connect()
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([
      "counter",
      "createNote",
      "explode",
      "rejected",
      "searchNotes",
    ])
    await client.close()
  })

  it("exposes descriptions, titles and input schemas", async () => {
    const client = await connect()
    const { tools } = await client.listTools()
    const search = tools.find((t) => t.name === "searchNotes")!

    expect(search.description).toBe("Full-text search across the user's notes")
    expect(search.inputSchema.properties).toHaveProperty("query")
    expect(search.inputSchema.properties).toHaveProperty("limit")
    expect(search.inputSchema.required).toEqual(["query"])

    const create = tools.find((t) => t.name === "createNote")!
    expect(create.title ?? create.annotations?.title).toBe("Create note")
    await client.close()
  })

  it("maps .meta() onto MCP annotations", async () => {
    const client = await connect()
    const { tools } = await client.listTools()
    expect(tools.find((t) => t.name === "searchNotes")!.annotations).toMatchObject({
      readOnlyHint: true,
    })
    expect(tools.find((t) => t.name === "createNote")!.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: false,
    })
    await client.close()
  })

  it("lists static resources and templated ones separately", async () => {
    const client = await connect()
    const { resources } = await client.listResources()
    const { resourceTemplates } = await client.listResourceTemplates()

    expect(resources.map((r) => r.uri)).toContain("config://app")
    expect(resourceTemplates.map((r) => r.uriTemplate)).toContain("notes://{id}")
    await client.close()
  })

  it("lists prompts with their arguments", async () => {
    const client = await connect()
    const { prompts } = await client.listPrompts()
    const summarize = prompts.find((p) => p.name === "summarize")!

    expect(summarize.description).toBe("Summarize a note in three bullets")
    expect(summarize.arguments?.map((a) => a.name)).toEqual(["noteId"])
    await client.close()
  })
})

describe("calling tools", () => {
  it("injects ctx and serialises the return value", async () => {
    const client = await connect()
    const result = await client.callTool({
      name: "searchNotes",
      arguments: { query: "cloves" },
    })

    const content = result.content as Array<{ type: string; text: string }>
    expect(content[0]!.type).toBe("text")
    expect(JSON.parse(content[0]!.text)).toEqual([
      { id: "1", title: "Groceries", body: "Milk, eggs, cloves" },
    ])
    await client.close()
  })

  it("applies zod defaults before the handler runs", async () => {
    const client = await connect()
    const result = await client.callTool({ name: "searchNotes", arguments: { query: "e" } })
    const content = result.content as Array<{ text: string }>
    // limit defaults to 10, so both matching notes come back.
    expect(JSON.parse(content[0]!.text)).toHaveLength(2)
    await client.close()
  })

  it("rejects arguments that fail validation", async () => {
    const client = await connect()
    const result = await client.callTool({
      name: "searchNotes",
      arguments: { query: 42 },
    })
    expect(result.isError).toBe(true)
    await client.close()
  })

  it("mutates shared singleton state through a service", async () => {
    const client = await connect()
    await client.callTool({
      name: "createNote",
      arguments: { title: "Fresh", body: "A new note" },
    })
    const result = await client.callTool({
      name: "searchNotes",
      arguments: { query: "Fresh" },
    })
    const content = result.content as Array<{ text: string }>
    expect(JSON.parse(content[0]!.text)[0]).toMatchObject({ title: "Fresh" })
    await client.close()
  })
})

describe("errors", () => {
  it("returns a 4xx as a readable result the model can act on", async () => {
    const client = await connect()
    const result = await client.callTool({ name: "rejected", arguments: {} })

    expect(result.isError).toBe(true)
    expect((result.content as Array<{ text: string }>)[0]!.text).toBe("No such note")
    await client.close()
  })

  it("redacts an unexpected throw instead of leaking it", async () => {
    const client = await connect()
    const result = await client.callTool({ name: "explode", arguments: {} })

    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ text: string }>)[0]!.text
    // The fixture boots in dev, so the message is included but still framed as
    // internal. In production `exposeErrors` is off and only the prefix shows.
    expect(text).toBe("Internal error: kaboom")
    await client.close()
  })

  it("reports unknown tools as an error result", async () => {
    const client = await connect()
    const result = await client.callTool({ name: "nope", arguments: {} })
    expect(result.isError).toBe(true)
    await client.close()
  })
})

describe("resources", () => {
  it("resolves a [param] segment as a URI template variable", async () => {
    const client = await connect()
    const result = await client.readResource({ uri: "notes://2" })

    expect(result.contents[0]).toMatchObject({
      uri: "notes://2",
      mimeType: "text/markdown",
    })
    expect(textOf(result.contents[0])).toContain("Finish the MCP specification")
    await client.close()
  })

  it("serves a static URI", async () => {
    const client = await connect()
    const result = await client.readResource({ uri: "config://app" })
    expect(JSON.parse(textOf(result.contents[0]))).toMatchObject({
      name: "clove-mcp-fixture",
    })
    await client.close()
  })

  it("surfaces a 4xx from a resource handler as a protocol error", async () => {
    const client = await connect()
    // Resources have no `isError` field, so the failure has to be a JSON-RPC
    // error — but it still carries the handler's own message.
    await expect(client.readResource({ uri: "notes://999" })).rejects.toThrow(
      /No note with id 999/,
    )
    await client.close()
  })
})

describe("prompts", () => {
  it("renders a prompt with its arguments", async () => {
    const client = await connect()
    const result = await client.getPrompt({
      name: "summarize",
      arguments: { noteId: "1" },
    })

    expect(result.messages[0]!.role).toBe("user")
    expect((result.messages[0]!.content as { text: string }).text).toContain(
      "Milk, eggs, cloves",
    )
    await client.close()
  })
})

describe("session scoping", () => {
  it("keeps session-scoped di per MCP session", async () => {
    const first = await connect()
    const countOf = async (client: Client) => {
      const result = await client.callTool({ name: "counter", arguments: {} })
      return JSON.parse((result.content as Array<{ text: string }>)[0]!.text)
    }

    expect((await countOf(first)).count).toBe(1)
    expect((await countOf(first)).count).toBe(2)

    // A second connection is a separate MCP session, so it starts over.
    const second = await connect()
    expect((await countOf(second)).count).toBe(1)

    // The first session is untouched by the second.
    expect((await countOf(first)).count).toBe(3)

    await first.close()
    await second.close()
  })

  it("exposes the MCP session id to handlers", async () => {
    const client = await connect()
    const result = await client.callTool({ name: "counter", arguments: {} })
    const { sessionId } = JSON.parse((result.content as Array<{ text: string }>)[0]!.text)
    expect(sessionId).toMatch(/[0-9a-f-]{36}/)
    await client.close()
  })
})

describe("coexistence with HTTP routes", () => {
  it("serves normal routes alongside the MCP endpoint", async () => {
    const res = await fetch(`${clove.url}/api/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true })
  })

  it("rejects an unknown MCP session id", async () => {
    const res = await fetch(`${clove.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": "not-a-real-session",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    })
    expect(res.status).toBe(404)
  })
})
