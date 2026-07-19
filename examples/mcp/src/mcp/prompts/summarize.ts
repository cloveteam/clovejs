import { prompt, error } from "clovejs/mcp"
import { z } from "zod"

// A prompt is a template the *user* picks from a menu, unlike a tool, which
// the model decides to call. Arguments must be `z.string()` — MCP transports
// them as strings, and the project refuses to boot if you declare otherwise.
export default prompt({
  description: "Summarize a note in three bullets",
  input: z.object({
    noteId: z.string().describe("The id of the note to summarize"),
  }),
  async handler({ noteId }, ctx) {
    const note = ctx.notes.findById(Number(noteId))
    if (!note) throw error(404, { message: `No note with id ${noteId}` })
    return `Summarize the following note in exactly 3 bullets:\n\n${note.body}`
  },
})
