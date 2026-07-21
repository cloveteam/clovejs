import { error, mcpAuth } from "clovejs/mcp"

// A dependency-free authenticator: opaque tokens mapped to a tenant and
// scopes. Real projects verify a JWT here (see examples/multi-tenant-mcp); the
// framework only cares about the principal that comes back.
const TOKENS: Record<string, { subject: string; tenant: string; scopes: string[] }> = {
  "acme-rw": { subject: "ada@acme", tenant: "acme", scopes: ["notes:read", "notes:write"] },
  "acme-ro": { subject: "grace@acme", tenant: "acme", scopes: ["notes:read"] },
  "globex-rw": { subject: "bob@globex", tenant: "globex", scopes: ["notes:read", "notes:write"] },
}

export default mcpAuth({
  metadata: {
    authorizationServers: ["https://auth.test"],
    scopesSupported: ["notes:read", "notes:write"],
    resourceName: "Test resource",
  },
  async authenticate({ token }) {
    if (!token) throw error(401, { message: "Bearer token required" })
    const principal = TOKENS[token]
    if (!principal) throw error(401, { message: "Unknown token" })
    return { ...principal, claims: { sub: principal.subject }, token }
  },
})
