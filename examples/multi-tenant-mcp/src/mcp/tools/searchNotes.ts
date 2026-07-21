import { tool } from "clovejs/mcp"
import { z } from "zod"
import { requireScope } from "../../lib/scope.js"

export default tool({
  description: "Full-text search across your tenant's notes, by title or body",
  input: z.object({
    query: z.string().describe("Search query"),
    limit: z.number().int().max(50).default(10),
  }),
  async handler({ query, limit }, ctx, { auth }) {
    const { tenant } = requireScope(auth, "notes:read")
    ctx.session.toolCalls++
    return ctx.notes.search(tenant, query, limit)
  },
}).meta({
  readOnly: true,
})
