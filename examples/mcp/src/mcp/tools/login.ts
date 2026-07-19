import { tool } from "clovejs/mcp"
import { z } from "zod"

// Writing to a session-scoped value from a tool is how an MCP server holds
// state across calls. HTTP middlewares do not run for MCP, so authentication
// happens here rather than in a middleware.
//
// `ctx.auth.login` throws `error(401, ...)` on a bad pair. A 4xx comes back to
// the model as a readable failure it can act on, so there is nothing to catch.
export default tool({
  description: "Sign in for the rest of this MCP session (try ada / secret)",
  input: z.object({
    username: z.string(),
    password: z.string(),
  }),
  async handler({ username, password }, ctx) {
    ctx.currentUser = ctx.auth.login(username, password)
    return `Signed in as ${ctx.currentUser.username}`
  },
}).meta({
  openWorld: false,
})
