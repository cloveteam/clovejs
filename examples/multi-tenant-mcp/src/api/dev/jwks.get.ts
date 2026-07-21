import { error, get } from "clovejs"

// The dev authorization server's public JWKS, so a verifier (including this
// server itself) can check the signatures of tokens it minted. A real IdP
// publishes the equivalent at its own `/.well-known/jwks.json`.
export default get(async (_req, _res, ctx) => {
  if (ctx.keys.mode !== "dev") {
    throw error(404, { message: "A real IdP is configured; use its JWKS" })
  }
  return ctx.keys.jwks()
})
