import { tool } from "clovejs/mcp"
import { z } from "zod"
import { requireScope } from "../../lib/scope.js"

// A writing tool: it demands the `notes:write` scope, so a read-only token
// gets a 403 here while still being able to call `listNotes`. The new note
// lands in the caller's tenant bucket and nobody else's.
export default tool({
  title: "Create note",
  description: "Create a note in your tenant (needs the notes:write scope)",
  input: z.object({
    title: z.string().min(1),
    body: z.string().default(""),
  }),
  async handler({ title, body }, ctx, { auth }) {
    const { tenant } = requireScope(auth, "notes:write")
    ctx.session.toolCalls++
    return ctx.notes.create(tenant, { title, body })
  },
}).meta({
  readOnly: false,
  idempotent: false,
})
