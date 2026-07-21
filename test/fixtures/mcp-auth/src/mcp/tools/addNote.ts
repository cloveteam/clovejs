import { error, tool } from "clovejs/mcp"
import { z } from "zod"

// Requires the notes:write scope, so a read-only token is refused.
export default tool({
  description: "Add a note to the caller's tenant (needs notes:write)",
  input: z.object({ title: z.string() }),
  async handler({ title }, ctx, { auth }) {
    if (!auth) throw error(401, { message: "Authentication required" })
    if (!auth.scopes.includes("notes:write")) {
      throw error(403, { message: 'This action needs the "notes:write" scope' })
    }
    return ctx.notes.create(auth.tenant, title)
  },
})
