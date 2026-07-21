# CloveJS — multi-tenant MCP with OAuth 2.1

A Model Context Protocol server over **Streamable HTTP**, guarded by **OAuth 2.1
bearer tokens**, serving **many tenants** from one process — each token only
ever reaches its own tenant's data.

This is the [`../mcp`](../mcp) example with an identity boundary added:

- Every request to `/mcp` must carry a valid bearer token, or it is rejected
  with `401` and a `WWW-Authenticate` challenge.
- The server publishes OAuth **protected-resource metadata** (RFC 9728) so a
  client can discover where to get a token.
- The token's `tenant` claim scopes everything: the MCP **session is bound to
  that tenant**, and a token for a different tenant cannot ride an existing
  connection.
- Tools enforce OAuth **scopes** (`notes:read`, `notes:write`).

The whole thing runs with **zero external services**: a built-in dev
authorization server mints RS256 tokens the server verifies against its own
JWKS. The verify path is real (RS256 + JWKS), so pointing at Auth0, Okta,
Keycloak or Entra is a change of environment variables, not of code.

## How auth plugs into CloveJS

One file turns the server into an OAuth protected resource:

```ts
// src/mcp/auth.ts
export default mcpAuth({
  metadata: { authorizationServers: [settings.issuer], scopesSupported: [...] },
  async authenticate({ ctx, token, resource }) {
    const claims = await ctx.keys.verify(token)          // RS256 + JWKS
    return { subject: claims.sub, tenant: claims.tenant, scopes: [...], claims, token }
  },
})
```

The runtime does the rest: it enforces the token on every request, serves
`/.well-known/oauth-protected-resource`, binds the session to `tenant`, and
hands the returned principal to every tool as `args.auth`.

## Run it

From the repository root (this is an npm workspace, so one install covers it):

```bash
npm install
npm run dev -w clovejs-example-multi-tenant-mcp
```

Or from this directory once the root install has run:

```bash
cd examples/multi-tenant-mcp
npm run dev
```

The server listens on `http://localhost:3000` — the MCP endpoint is `/mcp`.
(Using a different port? Set `PUBLIC_URL` to match, so the token audience lines
up with the URL clients actually call.)

## Walk the flow with curl

```bash
# 1. An unauthenticated call is refused, and told where to get a token.
curl -i -X POST localhost:3000/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"c","version":"1"}}}'
# -> 401, with:  WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp"

# 2. Discover the authorization server (RFC 9728).
curl localhost:3000/.well-known/oauth-protected-resource/mcp

# 3. Get a token from the built-in dev authorization server.
#    tenant is required; scopes default to read + write.
curl -X POST localhost:3000/api/dev/token \
  -H 'content-type: application/json' \
  -d '{"tenant":"acme"}'
# -> { "access_token": "eyJ…", "token_type": "Bearer", … }
```

Then point an MCP client at the server with that token as a bearer credential.
An `mcp.json` for a client that supports static headers:

```json
{
  "mcpServers": {
    "clove-acme": {
      "url": "http://localhost:3000/mcp",
      "headers": { "Authorization": "Bearer eyJ…" }
    }
  }
}
```

Mint a second token for `tenant: "globex"` and you have two isolated tenants on
the same server: `globex` never sees `acme`'s notes.

## What to look at

| File | Demonstrates |
| --- | --- |
| [`src/mcp/auth.ts`](./src/mcp/auth.ts) | **The whole point** — `mcpAuth`: verify the bearer token, publish metadata, extract the tenant claim |
| [`src/services/keys.ts`](./src/services/keys.ts) | RS256 verification via JWKS; a dev keypair in-process, or a real IdP's remote JWKS |
| [`src/services/notes.ts`](./src/services/notes.ts) | Tenant-isolated data — the multi-tenant boundary, keyed by `auth.tenant` |
| [`src/mcp/tools/listNotes.ts`](./src/mcp/tools/listNotes.ts) | A tool reading `args.auth`, scoped to one tenant |
| [`src/mcp/tools/createNote.ts`](./src/mcp/tools/createNote.ts) | Enforcing the `notes:write` scope — a read-only token gets a `403` |
| [`src/mcp/tools/whoami.ts`](./src/mcp/tools/whoami.ts) | Per-connection session state (`di/session.ts`) persisting across calls |
| [`src/mcp/resources/notes/[id].ts`](./src/mcp/resources/notes/%5Bid%5D.ts) | A resource under the same auth and tenant scope |
| [`src/api/dev/token.post.ts`](./src/api/dev/token.post.ts) | The dev authorization server — a stand-in for a real IdP |
| [`src/lib/settings.ts`](./src/lib/settings.ts) | The one place URLs, scopes and tenants are resolved; swap in a real IdP here |

## Two identities, one connection

There are two distinct things at work, and it is worth keeping them apart:

- **The bearer token** identifies the caller on *every* request. It is the
  source of truth for who you are and which tenant you belong to. Auth is
  stateless — the token is re-verified each call.
- **The MCP session** (`Mcp-Session-Id`) is per-connection working state that
  *persists across* calls. Here that is the `toolCalls` counter in
  [`src/di/session.ts`](./src/di/session.ts); call `whoami` twice and watch it
  climb. The runtime binds the session to the tenant that opened it, so the two
  identities can never disagree.

## Moving to a real IdP

Set three environment variables (see [`.env.example`](./.env.example)) and the
dev authorization server switches itself off:

```bash
OAUTH_ISSUER=https://your-tenant.us.auth0.com/
OAUTH_AUDIENCE=http://localhost:3000/mcp
OAUTH_JWKS_URL=https://your-tenant.us.auth0.com/.well-known/jwks.json
```

Now `services/keys.ts` verifies against the IdP's published JWKS, and
`/api/dev/token` and `/api/dev/jwks` return `404`. Configure your IdP to put a
`tenant` claim on the token (a custom claim or an org/namespace mapping) and
nothing else changes.

Full explanations live in the [guide](https://cloveteam.github.io/clovejs/).
