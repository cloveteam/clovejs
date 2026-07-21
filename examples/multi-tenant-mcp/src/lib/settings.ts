/**
 * One place that reads the environment, so `di/config.ts`, `services/keys.ts`
 * and `mcp/auth.ts` all agree on the URLs and scopes. This is a plain module,
 * not a CloveJS convention file — it lives outside `di/`, `services/` and
 * `mcp/`, so the scanner never treats it as a route or provider.
 *
 * `mcp/auth.ts` publishes its metadata at module load, before any DI context
 * exists, which is why these values are resolved here at import time rather
 * than inside a service.
 */

const PUBLIC_URL = (process.env.PUBLIC_URL ?? "http://localhost:3000").replace(/\/$/, "")

/** The tenants the built-in dev authorization server will mint tokens for. */
export const TENANTS = ["acme", "globex"] as const
export type Tenant = (typeof TENANTS)[number]

/** Scopes this resource understands, advertised in its metadata. */
export const SCOPES = ["notes:read", "notes:write"] as const

export const settings = {
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

  scopes: [...SCOPES] as string[],
  tenants: [...TENANTS] as string[],
}

/** True when we sign our own tokens (no external IdP configured). */
export const isDevIdp = settings.jwksUrl === null
