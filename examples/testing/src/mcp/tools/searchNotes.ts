import { tool } from "clovejs/mcp"
import { z } from "zod"

// The same notes service, exposed to an AI assistant. The MCP test calls this
// through `app.mcp.callTool` — no JSON-RPC transport, real schema validation.
export default tool({
  description: "Full-text search across the notes",
  input: z.object({
    query: z.string().describe("Search query"),
    limit: z.number().int().max(50).default(10),
  }),
  async handler({ query, limit }, ctx) {
    return ctx.notes.search(query).slice(0, limit)
  },
}).meta({
  readOnly: true,
})
