import { error, post } from "clovejs"

/**
 * The built-in dev authorization server's token endpoint — a stand-in for a
 * real IdP, so you can get a token with `curl` and no external setup.
 *
 * `POST /api/dev/token` with `{ tenant, subject?, scopes? }` returns a signed
 * RS256 access token. In production you delete this file and point
 * `OAUTH_ISSUER` / `OAUTH_JWKS_URL` at Auth0, Okta, Keycloak or Entra instead;
 * when `OAUTH_JWKS_URL` is set this endpoint refuses to mint, since the real
 * IdP owns that job.
 *
 * This is deliberately NOT the full OAuth 2.1 authorization-code + PKCE dance
 * (that belongs to the IdP and its login UI); it is just enough to hand out a
 * valid bearer token for the protected resource this example is about.
 */
export default post(async (req, res, ctx) => {
  if (ctx.keys.mode !== "dev") {
    throw error(404, { message: "A real IdP is configured; mint tokens there" })
  }

  const body = (req.body ?? {}) as {
    tenant?: string
    subject?: string
    scopes?: string[]
  }

  if (!body.tenant || !ctx.config.tenants.includes(body.tenant)) {
    throw error(400, {
      message: `"tenant" must be one of: ${ctx.config.tenants.join(", ")}`,
    })
  }

  const scopes = body.scopes ?? ctx.config.scopes
  const invalid = scopes.filter((s) => !ctx.config.scopes.includes(s))
  if (invalid.length) {
    throw error(400, { message: `Unknown scope(s): ${invalid.join(", ")}` })
  }

  const access_token = await ctx.keys.mint({
    sub: body.subject ?? `user@${body.tenant}`,
    tenant: body.tenant,
    scope: scopes.join(" "),
  })

  res.status(201)
  return { access_token, token_type: "Bearer", expires_in: 3600, scope: scopes.join(" ") }
})
