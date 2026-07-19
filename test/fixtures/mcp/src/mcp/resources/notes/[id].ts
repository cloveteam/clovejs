import { error, resource } from "clovejs/mcp"

/** Serves `notes://{id}`. */
export default resource({
  description: "A single note by id",
  mimeType: "text/markdown",
  async handler({ id }, ctx) {
    const note = ctx.notes.findById(id)
    if (!note) throw error(404, { message: `No note with id ${id}` })
    return `# ${note.title}\n\n${note.body}\n`
  },
})
