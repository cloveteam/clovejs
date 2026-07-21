import { error, type McpAuthInfo } from "clovejs/mcp"

/**
 * Asserts the caller holds a scope, and narrows `auth` to non-null so a tool
 * can use `auth.tenant` afterwards without a further check.
 *
 * The runtime already rejects an unauthenticated request before a tool runs,
 * so `auth` is only null when this project defines no `mcp/auth.ts` — never
 * the case here. The guard keeps the types honest and doubles as the scope
 * check. A 403 comes back to the model as a readable failure.
 */
export function requireScope(auth: McpAuthInfo | null, scope: string): McpAuthInfo {
  if (!auth) throw error(401, { message: "Authentication required" })
  if (!auth.scopes.includes(scope)) {
    throw error(403, { message: `This action needs the "${scope}" scope` })
  }
  return auth
}
