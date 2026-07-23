import { resource, error } from "clovejs/mcp"

// Serves `notes://{id}`. The MCP test reads it with `app.mcp.readResource`.
export default resource({
  description: "A single note by id",
  mimeType: "text/markdown",
  async handler({ id }, ctx) {
    const note = ctx.notes.findById(Number(id))
    if (!note) throw error(404, { message: `No note with id ${id}` })
    return `# ${note.title}\n\n${note.body}\n`
  },
})
