import { tool } from "clovejs/mcp"

/** Exercises session-scoped DI: the count is per MCP session. */
export default tool({
  description: "Counts calls within the current MCP session",
  async handler(_input, ctx, { sessionId }) {
    ctx.callCount += 1
    return { count: ctx.callCount, sessionId }
  },
})
