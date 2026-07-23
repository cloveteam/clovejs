# CloveJS — testing example

A small notes API bundled with a **full test suite**, showing how to test a
CloveJS app from the client side with `clovejs/testing`. The app itself is
deliberately familiar — it's the [`../rest`](../rest) notes API plus a
WebSocket and an MCP tool — so the interesting part is the [`test/`](./test)
folder.

The testing layer boots your app **in memory** (no port, no socket), dispatches
through the real router, middleware chain, DI and JSON rules, and lets you swap
any dependency for a fake. It bundles no runner; this example uses
[Vitest](https://vitest.dev).

## Run it

From the repository root (one install covers every example workspace, and it
builds the framework the example links against):

```bash
npm install
npm run build            # builds clovejs, which provides clovejs/testing
npm test -w clovejs-example-testing
```

Or from this directory once the root install and build have run:

```bash
cd examples/testing
npm test                 # or: npm run test:watch
```

You can also run the app itself:

```bash
npm run dev              # http://localhost:3000/api/notes
```

## The three levels of testing

| Level | Boots the project? | Used for | File |
| --- | --- | --- | --- |
| **Integration** | yes, in memory | routes, middleware, sessions end-to-end | [`test/integration.test.ts`](./test/integration.test.ts) |
| **Integration + fakes** | yes | swapping a dependency for a stub or spy | [`test/overrides.test.ts`](./test/overrides.test.ts) |
| **Unit** | no | one handler / middleware with a mock `ctx` | [`test/unit.test.ts`](./test/unit.test.ts) |

Plus the two surfaces beyond HTTP, reachable from the same harness:

| Surface | File |
| --- | --- |
| MCP tools & resources | [`test/mcp.test.ts`](./test/mcp.test.ts) |
| WebSockets | [`test/websocket.test.ts`](./test/websocket.test.ts) |

## What each test file shows

### `integration.test.ts` — `createTestApp()`

Boots the app and drives it with `app.get` / `app.post` / `app.del`. Covers the
JSON status-code rules (`201`, `404`, `204`, `400`), the session cookie jar
carrying `clove.sid` across a login → `me` flow, and the admin-only middleware
rejecting an anonymous `DELETE` while letting an admin through.

```ts
const app = await createTestApp()
await app.post("/api/login", { username: "ada", password: "secret" })
const me = await app.get("/api/me") // rides the stored cookie
expect(me.json).toMatchObject({ username: "ada" })
```

### `overrides.test.ts` — swapping dependencies

Replaces `ctx.notes`, `ctx.config` and `ctx.auth` with fakes — a plain stub, a
factory, and a Vitest spy — keyed by their `ctx` name and checked against the
generated context.

```ts
const app = await createTestApp({
  overrides: { notes: { list: () => [{ id: 99, title: "Faked", body: "" }] } },
})
```

### `mcp.test.ts` — the MCP surface

Calls the `searchNotes` tool and reads the `notes://{id}` resource directly —
real Zod validation, no JSON-RPC transport.

```ts
const hits = await app.mcp.callTool("searchNotes", { query: "testing" })
const note = await app.mcp.readResource("notes://1")
```

### `websocket.test.ts` — the WebSocket surface

Opens an in-memory connection to `ws/echo`, exchanges messages and closes.

```ts
const socket = app.ws.connect("/ws/echo")
socket.send("ping")
expect(await socket.next()).toBe("ping")
```

### `unit.test.ts` — `runHandler`, `runMiddleware`, `createMockCtx`

Runs one handler or middleware with a hand-built `ctx`, no project scan. The
JSON rules still apply, so `null` from a GET is a `404` and a thrown
`error(400, …)` is rendered into the response.

```ts
const ctx = createMockCtx({ notes: { findById: () => null } })
const res = await runHandler(getNote, { params: { id: "42" }, ctx })
expect(res.status).toBe(404)
```

## Guide

The full write-up lives in the docs: [Testing](https://cloveteam.github.io/clovejs/guide/testing).
