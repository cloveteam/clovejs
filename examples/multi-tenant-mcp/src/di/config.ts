import { di } from "clovejs"

const PUBLIC_URL = (process.env.PUBLIC_URL ?? "http://localhost:3000").replace(/\/$/, "")

/** The tenants the built-in dev authorization server will mint tokens for. */
const TENANTS = ["acme", "globex"]

/** Scopes this resource understands, advertised in its metadata. */
const SCOPES = ["notes:read", "notes:write"]

/**
 * The one place that reads the environment, exposed as `ctx.config`. Resolved
 * once at boot; every consumer — services, routes, and `mcp/auth.ts` (whose
 * metadata factory receives `ctx`) — reads URLs, scopes and issuer from here,
 * so they all agree.
 */
export default di({
  lifetime: "singleton",
  value: {
    publicUrl: PUBLIC_URL,

    /** The MCP endpoint. Also the expected token audience (RFC 8707). */
    resource: `${PUBLIC_URL}/mcp`,
    audience: process.env.OAUTH_AUDIENCE ?? `${PUBLIC_URL}/mcp`,

    /**
     * Who issues valid tokens. Defaults to this server's own built-in dev
     * authorization server; set OAUTH_ISSUER to defer to a real IdP.
     */
    issuer: process.env.OAUTH_ISSUER ?? PUBLIC_URL,

    /**
     * When set, tokens are verified against this remote JWKS (a real IdP) and
     * the dev token endpoints switch off. When unset, the server runs its own
     * in-process keypair so the example needs no external services.
     */
    jwksUrl: process.env.OAUTH_JWKS_URL ?? null,

    scopes: SCOPES,
    tenants: TENANTS,
  },
})
