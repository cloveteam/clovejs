import { tool } from "clovejs/mcp"
import { z } from "zod"

export default tool({
  description: "Full-text search across the user's notes",
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
