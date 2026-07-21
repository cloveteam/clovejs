import { di } from "clovejs"

export interface McpSession {
  /** The tenant that opened this MCP connection. */
  tenant: string | null
  /** The principal that opened it. */
  subject: string | null
  /** How many tool calls this connection has made. */
  toolCalls: number
}

// Session-scoped, so it is one object per MCP connection (identified by its
// `Mcp-Session-Id`) and survives across calls — declaring it is what turns
// sessions on. A *factory* rather than a bare object, so every session gets
// its own fresh state instead of sharing one.
//
// Bearer auth already identifies the caller on every request, so this is not
// where identity lives; it is per-connection working state (here, a call
// counter) that persists for the life of the session. `whoami` reads it back.
export default di({
  lifetime: "session",
  value: (): McpSession => ({ tenant: null, subject: null, toolCalls: 0 }),
})
