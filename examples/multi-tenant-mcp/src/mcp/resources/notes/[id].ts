import { error, resource } from "clovejs/mcp"
import { requireScope } from "../../../lib/scope.js"

// `mcp/resources/notes/[id].ts` serves `notes://{id}`. Resources get the same
// `args.auth` as tools, so this read is tenant-scoped too: a note id that
// exists for another tenant simply reads as "not found" here.
export default resource({
  description: "A single note from your tenant, as markdown",
  mimeType: "text/markdown",
  async handler({ id }, ctx, { auth }) {
    const { tenant } = requireScope(auth, "notes:read")
    const note = ctx.notes.findById(tenant, Number(id))
    if (!note) throw error(404, { message: `No note ${id} in this tenant` })
    return `# ${note.title}\n\n${note.body}\n`
  },
})
