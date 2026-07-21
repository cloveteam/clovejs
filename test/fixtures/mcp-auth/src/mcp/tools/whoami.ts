import { error, tool } from "clovejs/mcp"

export default tool({
  description: "Report the authenticated principal for this call",
  async handler(_input, _ctx, { auth, sessionId }) {
    if (!auth) throw error(401, { message: "Authentication required" })
    return { subject: auth.subject, tenant: auth.tenant, scopes: auth.scopes, sessionId }
  },
}).meta({ readOnly: true })
