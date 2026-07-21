import { tool } from "clovejs/mcp"
import { requireScope } from "../../lib/scope.js"

// Reads are scoped to the caller's tenant: `ctx.notes.list(auth.tenant)` can
// only ever return this tenant's notes. `requireScope` also enforces that the
// token was granted `notes:read`.
export default tool({
  description: "List every note belonging to your tenant",
  async handler(_input, ctx, { auth }) {
    const { tenant } = requireScope(auth, "notes:read")
    ctx.session.toolCalls++
    return ctx.notes.list(tenant)
  },
}).meta({
  readOnly: true,
})
