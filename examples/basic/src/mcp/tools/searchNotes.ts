import { tool } from "clovejs/mcp"
import { z } from "zod"

// The tool name comes from the filename: `searchNotes`. The `input` schema is
// published to the client as JSON Schema, validated before this handler runs,
// and types the first argument — note that `query` and `limit` need no
// annotation.
export default tool({
  description: "Full-text search across the notes, by title or body",
  input: z.object({
    query: z.string().describe("Text to look for"),
    limit: z.number().int().min(1).max(50).default(10),
  }),
  async handler({ query, limit }, ctx) {
    const needle = query.toLowerCase()
    return ctx.notes
      .list()
      .filter(
        (note) =>
          note.title.toLowerCase().includes(needle) ||
          note.body.toLowerCase().includes(needle),
      )
      .slice(0, limit)
  },
}).meta({
  // Advisory hints for the client. A read-only tool usually runs without
  // asking the user first.
  readOnly: true,
})
