import { tool } from "clovejs/mcp"
import { z } from "zod"

// `ctx.notes` is the same singleton the HTTP route uses, so a note created
// here shows up at GET /api/notes straight away.
export default tool({
  description: "Create a note",
  title: "Create note",
  input: z.object({
    title: z.string().min(1),
    body: z.string(),
  }),
  async handler({ title, body }, ctx) {
    const note = ctx.notes.create({ title, body })
    ctx.logger.info(`MCP created note ${note.id}`)
    return note
  },
}).meta({
  readOnly: false,
  idempotent: false,
})
