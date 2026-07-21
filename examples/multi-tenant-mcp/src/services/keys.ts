import { service } from "clovejs"
import {
  SignJWT,
  createLocalJWKSet,
  createRemoteJWKSet,
  exportJWK,
  generateKeyPair,
  jwtVerify,
  type JSONWebKeySet,
  type JWK,
  type JWTPayload,
} from "jose"

/**
 * The token verifier — and, in dev mode, the signer behind the built-in
 * authorization server.
 *
 * Two modes, chosen by whether `OAUTH_JWKS_URL` is set:
 *
 *  - **remote** — verify RS256 tokens against a real IdP's published JWKS.
 *    This is production. Minting is the IdP's job, so `mint`/`jwks` are off.
 *  - **dev** — generate an in-process RS256 keypair at boot, sign tokens with
 *    the private half, and verify with the public half. Zero external setup.
 *
 * The verify path is identical in shape either way (RS256 + JWKS), so moving
 * from the dev IdP to Auth0/Okta/Keycloak is a change of environment, not of
 * code.
 */
export interface Keys {
  mode: "dev" | "remote"
  /** Verifies a token's signature, issuer and audience; returns its claims. */
  verify(token: string): Promise<JWTPayload>
  /** The public JWK set, for the dev IdP's discovery endpoint. */
  jwks(): JSONWebKeySet
  /** Signs a dev token. Throws when a real IdP is configured. */
  mint(claims: JWTPayload): Promise<string>
}

export default service(async (ctx): Promise<Keys> => {
  const verifyOptions = { issuer: ctx.config.issuer, audience: ctx.config.audience }

  if (ctx.config.jwksUrl) {
    const remote = createRemoteJWKSet(new URL(ctx.config.jwksUrl))
    ctx.logger.info(`Verifying tokens against IdP JWKS at ${ctx.config.jwksUrl}`)
    return {
      mode: "remote",
      async verify(token) {
        return (await jwtVerify(token, remote, verifyOptions)).payload
      },
      jwks() {
        throw new Error("JWKS is served by the configured IdP, not this server")
      },
      async mint() {
        throw new Error("Tokens are minted by the configured IdP, not this server")
      },
    }
  }

  // Dev authorization server: a fresh keypair every boot.
  const kid = `dev-${Date.now().toString(36)}`
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true })
  const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" }
  const keySet: JSONWebKeySet = { keys: [publicJwk] }
  const local = createLocalJWKSet(keySet)
  ctx.logger.info("Signing dev tokens in-process (no external IdP configured)")

  return {
    mode: "dev",
    jwks: () => keySet,
    async verify(token) {
      return (await jwtVerify(token, local, verifyOptions)).payload
    },
    async mint(claims) {
      return new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid })
        .setIssuedAt()
        .setIssuer(ctx.config.issuer)
        .setAudience(ctx.config.audience)
        .setExpirationTime("1h")
        .sign(privateKey)
    },
  }
})
