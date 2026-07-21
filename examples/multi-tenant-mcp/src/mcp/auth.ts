import { error, mcpAuth } from "clovejs/mcp"

/**
 * Turns this server into an OAuth 2.1 protected resource.
 *
 * The runtime enforces this on every request to `/mcp`: no valid bearer token,
 * no access. It also publishes the `metadata` below at
 * `/.well-known/oauth-protected-resource`, and answers an unauthenticated
 * request with `401` + a `WWW-Authenticate` header pointing there — the
 * discovery handshake an MCP client follows to find where to get a token.
 *
 * `authenticate` validates the token and returns the principal, which the
 * runtime hands to every tool as `args.auth`. The `tenant` claim is what makes
 * the server multi-tenant: the runtime binds the MCP session to it, and each
 * tool scopes its data by it, so one connection can only ever touch one
 * tenant's records.
 */
export default mcpAuth({
  // Published verbatim (snake_cased) at the well-known endpoint. A factory
  // rather than a plain object: it runs once, lazily, with the container up, so
  // it can read `ctx.config` — a bare object here is captured at import time,
  // before any DI context exists.
  metadata: ({ ctx }) => ({
    authorizationServers: [ctx.config.issuer],
    scopesSupported: ctx.config.scopes,
    resourceName: "CloveJS multi-tenant notes",
  }),

  async authenticate({ ctx, token, resource }) {
    if (!token) {
      throw error(401, { message: "A bearer access token is required" })
    }

    // `ctx.keys.verify` checks the RS256 signature against the JWKS and that
    // the token's issuer and audience match this resource. A bad token throws;
    // we translate that into a 401 so the client re-runs the OAuth flow.
    let claims
    try {
      claims = await ctx.keys.verify(token)
    } catch (err) {
      throw error(401, { message: `Invalid token: ${(err as Error).message}` })
    }

    // Defence in depth: the audience is also checked here so a token minted for
    // another API can never be replayed against this one.
    if (claims.aud !== resource && !(Array.isArray(claims.aud) && claims.aud.includes(resource))) {
      throw error(401, { message: "Token audience does not match this resource" })
    }

    const tenant = typeof claims.tenant === "string" ? claims.tenant : null
    if (!tenant) {
      throw error(403, { message: "Token is missing a tenant claim" })
    }

    const scope = typeof claims.scope === "string" ? claims.scope : ""
    return {
      subject: typeof claims.sub === "string" ? claims.sub : "unknown",
      tenant,
      scopes: scope ? scope.split(" ") : [],
      claims,
      token,
    }
  },
})
