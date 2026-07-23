# Testing

CloveJS ships a testing layer under `clovejs/testing`. It boots your project
**in memory** — no port, no socket — and dispatches requests through the real
router, middleware chain, DI containers and JSON rules. The one thing it adds
that production forbids is the ability to swap a dependency for a fake.

It bundles no test runner or assertion library. Use Vitest, Jest or
`node:test` — the examples here use Vitest.

## Three levels

| Level | Exercises | Import |
| --- | --- | --- |
| **Unit** | one handler / middleware, with a hand-built `ctx` | `runHandler`, `createMockCtx` |
| **Integration** | the booted app, dispatched in-memory | `createTestApp` |
| **End-to-end** | a real server on a port | `bootstrap({ port: 0 })` |

Most tests want the middle one.

## Integration: `createTestApp()`

```ts
import { createTestApp, type TestApp } from "clovejs/testing"
import { afterEach, expect, test } from "vitest"

let app: TestApp
afterEach(() => app?.close())

test("GET /api/v1/users/:id", async () => {
  app = await createTestApp()

  const res = await app.get("/api/v1/users/1")

  expect(res.status).toBe(200)
  expect(res.json).toEqual({ id: 1, name: "Ada" })
})
```

`createTestApp()` accepts everything [`bootstrap()`](./bootstrap) accepts, plus
`overrides`. By default it reads your project from the current directory; point
it elsewhere with `rootDir`.

Each response has `status`, `headers` (a `Headers`), `text`, `json` and
`cookies`. The verbs mirror the framework's own — `get`, `post`, `put`, `patch`,
`del`, `head`, `options` — plus a low-level `request(path, init)` for custom
headers or non-JSON bodies:

```ts
await app.post("/api/login", { username: "ada", password: "secret" })
await app.request("/api/upload", {
  method: "POST",
  headers: { "content-type": "text/csv" },
  body: "a,b,c",
})
```

### Sessions and cookies

The harness keeps a cookie jar across requests, so session flows read
naturally:

```ts
test("session persists across requests", async () => {
  app = await createTestApp()

  await app.post("/api/login", { username: "ada", password: "secret" })
  const me = await app.get("/api/me") // the clove.sid cookie rides along

  expect(me.json.username).toBe("ada")
})
```

Seed or inspect the jar through `app.cookies.set(name, value)`,
`app.cookies.get(name)` and `app.cookies.all()`. `app.reset()` clears it without
rebooting.

### `close()`

`close()` runs the real shutdown path — MCP, sockets, sessions, then the
singleton scope — so `onDestroy` hooks are exercised. Pair it with your runner's
teardown (`afterEach`) and every test starts from a clean singleton scope.

## Overrides

Replace any injectable by its `ctx` key. A plain value swaps the dependency; a
function is a factory with the same `(ctx, hooks)` contract as a `service` or
`di` file. Overrides are typed against your generated context, so a renamed
service breaks the test at compile time.

```ts
const app = await createTestApp({
  overrides: {
    // a plain value replaces the real singleton
    db: fakeDb,

    // a factory receives ctx, exactly like a services/ or di/ file
    auth: (ctx) => ({
      async login({ username }: LoginParams) {
        return { user: { username }, token: "test-token" }
      },
    }),
  },
})
```

Mocking libraries stay your choice:

```ts
import { vi } from "vitest"

const login = vi.fn().mockResolvedValue({ user, token })
const app = await createTestApp({ overrides: { auth: { login } } })

await app.post("/api/login", { username: "ada", password: "secret" })
expect(login).toHaveBeenCalledOnce()
```

An override keeps the lifetime of the key it replaces, and an override for an
unknown key registers as a new singleton — handy for seeding a value a
middleware would normally set.

## MCP tools, resources and prompts

The MCP runtime boots with the app, so its surface is reachable directly — no
JSON-RPC transport, no stdio subprocess:

```ts
const app = await createTestApp()

const notes = await app.mcp.callTool("searchNotes", { query: "clove" })
expect(notes).toHaveLength(2)

const note = await app.mcp.readResource("notes://42")
expect(note.mimeType).toBe("text/markdown")
expect(note.text).toContain("# ")

const prompt = await app.mcp.getPrompt("summarize", { noteId: "42" })
```

`callTool` runs the real input schema — defaults applied, invalid input
rejected. Unlike the wire transport, a thrown `error(status, ...)` propagates as
an `HttpError` so you can assert on it:

```ts
await expect(app.mcp.callTool("deleteNote", { id: "x" })).rejects.toMatchObject({
  status: 404,
})
```

When the project defines `mcp/auth.ts`, pass a token; it runs through your
`authenticate` handler and reaches the tool as `args.auth`:

```ts
const who = await app.mcp.callTool("whoami", {}, { token: "tenant-a-token" })
```

## WebSockets

`app.ws.connect(path)` opens an in-memory connection that speaks the same
`send` / `onMessage` contract as your handler:

```ts
const socket = app.ws.connect("/ws/echo")

expect(JSON.parse(String(await socket.next())).hello).toBe(true)

socket.send("ping")
expect(await socket.next()).toBe("ping")

await socket.close() // runs the handler's onDestroy
```

`next(timeoutMs?)` resolves with the next message the handler sends (default
timeout 1s). `[param]` segments resolve the same way routes do, and `close()`
disposes the request scope just like a real disconnect.

## Unit level

To test one handler with no project scan, build a `ctx` and run it directly.

```ts
import { createMockCtx, runHandler } from "clovejs/testing"
import handler from "../src/api/v1/users/[id].get.ts"

test("looks the user up by id", async () => {
  const ctx = createMockCtx({
    users: { findById: (id: number) => ({ id, name: "Ada" }) },
  })

  const res = await runHandler(handler, { params: { id: "1" }, ctx })

  expect(res.json).toEqual({ id: 1, name: "Ada" })
})
```

`runHandler(def, opts)` accepts `params`, `query`, `body`, `headers`, `method`
and `ctx`, then applies the JSON rules — so `undefined` is a 204, `null` from a
GET is a 404, and a thrown `error(status, ...)` becomes that status. An
unexpected throw propagates for your test to catch.

`createMockCtx(overrides)` returns a `ctx`-shaped object with the same
`get`/`set`/`has` semantics as the real container, so a handler that writes
`ctx.currentUser = …` behaves as it would in the pipeline. Every override is a
plain value; a `logger` is provided unless you supply one.

Middlewares have their own runner, with a stubbed `handler.execute`:

```ts
import { runMiddleware } from "clovejs/testing"

const { result, response } = await runMiddleware(authGuard, {
  ctx: createMockCtx({ currentUser: null }),
  route: { meta: { adminOnly: true } },
  execute: () => "reached the handler",
})
```

## End-to-end

When you want a real socket — to point an external client or `fetch` at it — use
`bootstrap` on an ephemeral port:

```ts
import { bootstrap } from "clovejs"

const clove = await bootstrap({ port: 0, logLevel: "silent" })
const res = await fetch(`${clove.url}/api/v1/users`)
await clove.close()
```

Reserve this for cases that genuinely need the network; the in-memory harness is
faster and deterministic for everything else.

## A worked example

[`examples/testing`](https://github.com/cloveteam/clovejs/tree/main/examples/testing)
is a runnable notes API with a full suite covering every level above —
integration, overrides, MCP, WebSockets and the unit helpers. Clone it and run
`npm test` to see the whole thing green.
