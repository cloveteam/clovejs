import { error, prompt } from "clovejs/mcp"
import { z } from "zod"

export default prompt({
  description: "Summarize a note in three bullets",
  input: z.object({
    noteId: z.string(),
  }),
  async handler({ noteId }, ctx) {
    const note = ctx.notes.findById(noteId)
    if (!note) throw error(404, { message: `No note with id ${noteId}` })
    return `Summarize the following note in 3 bullets:\n\n${note.body}`
  },
})
