import { tool } from "clovejs/mcp"

// A tool with no `input` takes no arguments at all.
//
// `ctx.currentUser` is session-scoped. Over HTTP that means one browser; over
// MCP it means one client connection, identified by its `Mcp-Session-Id`. The
// same declaration in `di/currentUser.ts` covers both, which is why `login`
// below can sign you in for the rest of the connection.
export default tool({
  description: "Report who is signed in on this MCP session",
  async handler(_input, ctx, { sessionId }) {
    return {
      user: ctx.currentUser?.username ?? null,
      isAdmin: ctx.currentUser?.isAdmin ?? false,
      sessionId,
    }
  },
}).meta({
  readOnly: true,
})
