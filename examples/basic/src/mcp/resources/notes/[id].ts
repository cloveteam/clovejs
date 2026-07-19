import { resource, error } from "clovejs/mcp"

// The URI comes from the file path, the same way a route's URL does: the first
// directory segment is the scheme and `[id]` becomes a `{id}` template
// variable, so this serves `notes://{id}`.
export default resource({
  description: "A single note, as markdown",
  mimeType: "text/markdown",
  async handler({ id }, ctx) {
    const note = ctx.notes.findById(Number(id))
    if (!note) throw error(404, { message: `No note with id ${id}` })
    return `# ${note.title}\n\n${note.body}\n`
  },
})
