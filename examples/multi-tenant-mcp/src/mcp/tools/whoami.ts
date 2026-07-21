import { error, tool } from "clovejs/mcp"

// No `input`, so this tool takes no arguments.
//
// `args.auth` is the principal the runtime authenticated for THIS call, fresh
// from the bearer token every time. `ctx.session` is per-connection state that
// persists across calls on the same `Mcp-Session-Id` — the `toolCalls` counter
// proves the session is real and being reused.
export default tool({
  description: "Report who is calling, their tenant, and this session's state",
  async handler(_input, ctx, { auth, sessionId }) {
    if (!auth) throw error(401, { message: "Authentication required" })

    ctx.session.tenant = auth.tenant
    ctx.session.subject = auth.subject
    ctx.session.toolCalls++

    return {
      subject: auth.subject,
      tenant: auth.tenant,
      scopes: auth.scopes,
      sessionId,
      toolCalls: ctx.session.toolCalls,
    }
  },
}).meta({
  readOnly: true,
})
