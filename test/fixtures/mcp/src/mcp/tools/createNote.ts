import { tool } from "clovejs/mcp"
import { z } from "zod"

export default tool({
  description: "Create a new note",
  title: "Create note",
  input: z.object({
    title: z.string(),
    body: z.string(),
  }),
  async handler({ title, body }, ctx) {
    return ctx.notes.create(title, body)
  },
}).meta({
  readOnly: false,
  idempotent: false,
})
