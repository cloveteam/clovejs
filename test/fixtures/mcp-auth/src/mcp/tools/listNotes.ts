import { error, tool } from "clovejs/mcp"

export default tool({
  description: "List notes for the caller's tenant",
  async handler(_input, ctx, { auth }) {
    if (!auth) throw error(401, { message: "Authentication required" })
    return ctx.notes.list(auth.tenant)
  },
}).meta({ readOnly: true })
