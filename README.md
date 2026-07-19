<div align="center">

<img src="https://raw.githubusercontent.com/cloveteam/clovejs/main/docs/public/logo.svg" alt="CloveJS" width="96" height="96">

# CloveJS

**Files in, routes out.**

A convention-driven Node.js HTTP framework. Routes, services, middlewares and
injectables are discovered from the filesystem — there is nothing to register.

[![CI](https://github.com/cloveteam/clovejs/actions/workflows/ci.yml/badge.svg)](https://github.com/cloveteam/clovejs/actions/workflows/ci.yml)
<!-- Uncomment once the package is published to npm; until then it renders red.
[![npm](https://img.shields.io/npm/v/clovejs?color=3f9d6f)](https://www.npmjs.com/package/clovejs)
-->
[![node](https://img.shields.io/badge/node-%3E%3D20-3f9d6f)](https://nodejs.org)
[![types](https://img.shields.io/badge/types-included-3178c6)](https://cloveteam.github.io/clovejs/guide/typed-context)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE.md)

[Documentation](https://cloveteam.github.io/clovejs/) ·
[Getting started](https://cloveteam.github.io/clovejs/guide/getting-started) ·
[CLI](https://cloveteam.github.io/clovejs/reference/cli) ·
[Contributing](./CONTRIBUTING.md)

</div>

---

- 🗂️ **Nothing to wire up.** Drop a file in a directory and it is live.
- 🔤 **TypeScript from the box.** `ctx` is fully typed via generated declarations.
- 🧩 **DI in the box.** Singleton, session and request lifetime scopes.
- 🔌 **WebSockets included.** Same conventions, `[param]` segments and all.
- 🤝 **Drops into Express.** Unmatched requests fall through to your own stack.
- 🤖 **Agent-ready.** `npx clove skills` teaches your AI editor the conventions.

```bash
npm i clovejs
npx clove scaffold      # create the default project structure
npm run dev
```

📖 **[Full documentation](https://cloveteam.github.io/clovejs/)** — guides, API
reference and deployment notes. Sources live in [`docs/`](./docs).

## Contents

- 🗂️ [Project structure](#project-structure)
- 🛣️ [Routes](#routes)
- 🔖 [Route parameters](#route-parameters)
- 🏷️ [Route metadata](#route-metadata)
- 🛠️ [Services](#services)
- 🧩 [Value dependencies and lifetime scopes](#value-dependencies-and-lifetime-scopes)
- 🧅 [Middlewares](#middlewares)
- 📦 [The JSON middleware](#the-json-middleware)
- 🚨 [Errors](#errors)
- 🔌 [WebSockets](#websockets)
- 🍪 [Sessions](#sessions)
- 🤝 [Bootstrap and Express interop](#bootstrap-and-express-interop)
- 🧪 [Example](#example)
- ⌨️ [CLI](#cli)
- 🤖 [AI editor support](#ai-editor-support)
- 🔤 [Typed context](#typed-context)

## Project structure

TypeScript projects keep sources under `src/`; JavaScript projects put the same
directories at the root. Both are detected automatically.

```
src/
  api/          route handlers      -> HTTP endpoints
  ws/           socket handlers     -> WebSocket endpoints
  di/           injectable values
  services/     injectable services
  middlewares/  request middlewares
  main.ts       bootstrap()
.clove/        generated types (gitignored)
```

## Routes

The default export of `api/v1/login.post.ts` becomes `POST /api/v1/login`:

```ts
import { post, error } from "clovejs"

export default post(async (req, res, ctx) => {
  if (!req.body.username || !req.body.password) {
    throw error(400, { message: "username and password are required" })
  }
  const { user, token } = await ctx.auth.login({
    username: req.body.username,
    password: req.body.password,
  })
  res.cookie("token", token, { httpOnly: true })
  // returning nothing responds 204
})
```

The `.{method}.ts` suffix is conventional and can be omitted, as long as the
handler is wrapped in the matching function. If a filename and its wrapper
disagree, the project refuses to boot and tells you which file to fix.

Available wrappers: `get`, `post`, `put`, `patch`, `del`, `head`, `options`,
and `all` (matches every method).

## Route parameters

`GET /api/v1/users/1` resolves to `api/v1/users/[id].get.ts`:

```ts
import { get } from "clovejs"

export default get(async (req, res, ctx) => {
  return ctx.users.findById(parseInt(req.params.id, 10))
})
```

Both file and directory forms work, and are interchangeable:

| Request | File |
| --- | --- |
| `GET /api/v1/users` | `api/v1/users.get.ts` or `api/v1/users/get.ts` |
| `GET /api/v1/users/1` | `api/v1/users/[id].get.ts` or `api/v1/users/[id]/get.ts` |
| `GET /api/v1/users/1/books` | `api/v1/users/[id]/books.get.ts` or `api/v1/users/[id]/books/get.ts` |
| `GET /api/v1/users/1/books/2` | `api/v1/users/[userId]/books/[bookId].get.ts` |

A literal segment always beats a parameter, so `users/me.get.ts` wins over
`users/[id].get.ts` for `/users/me`.

## Route metadata

```ts
export default get(async (req, res, ctx) => {
  // ...
}).meta({
  adminOnly: true,
})
```

Middlewares read it as `route.meta.adminOnly`.

## Services

Files in `services/` are injected into `ctx` under their filename. They are
singletons, created once at boot.

```ts
import { service, error } from "clovejs"

export default service(async (ctx, { onDestroy }) => {
  ctx.logger.info("auth service initialized")
  let logins = 0

  onDestroy(async () => {
    ctx.logger.info("auth service destroyed")
  })

  return {
    async login({ username, password }: LoginParams) {
      const user = await ctx.db.user.find({
        username,
        password: ctx.users.hash(password),
      })
      if (!user) {
        throw error(401, { message: "Username / password pair mismatch" })
      }
      logins++
      return { user, token: sign(user) }
    },
  }
})
```

> **Calling sibling methods.** Prefer a local function in the closure over
> `this.other()`. TypeScript cannot infer a method's return type when it
> depends on the object literal that contains it, so `this` usage inside an
> async factory forces you to annotate return types by hand.

## Value dependencies and lifetime scopes

Files in `di/` inject plain values. Each declares how long it lives:
`singleton` (the whole process), `session` (one visitor), or `request`.

```ts
import { di } from "clovejs"

export default di({
  lifetime: "session",
  value: null as User | null,
})
```

Assigning from a middleware writes into the scope the value was declared with:

```ts
ctx.currentUser = await ctx.auth.verify(req.cookie.token)
```

A value can also be computed, with access to other dependencies and to
teardown hooks:

```ts
import { di } from "clovejs"
import { Client } from "pg"

export default di({
  lifetime: "singleton",
  async value(ctx, { onDestroy }) {
    const config = ctx.config.db
    const client = new Client({ user: config.user, password: config.password })
    await client.connect()
    onDestroy(async () => client.end())
    return client
  },
})
```

### Resolution rules

Singletons are all resolved before the server accepts traffic, so reading
`ctx.db` from a handler or a service method is synchronous and safe.

Inside a **factory**, `await` anything you depend on — `await` on a plain value
is harmless, so awaiting uniformly is always correct:

```ts
async value(ctx) {
  const db = await ctx.db          // another factory: await it
  const config = ctx.config        // a plain value: already resolved
}
```

Session- and request-scoped factories resolve on first access within their
scope, so the first read returns a promise.

## Middlewares

Any file in `middlewares/` wraps every route. Code before `handler.execute()`
runs on the way in, code after it on the way out; returning without calling it
short-circuits.

```ts
import { middleware, error } from "clovejs"

export default middleware(async ({ route, handler, ctx }) => {
  if (route.meta.adminOnly && !ctx.currentUser?.isAdmin) {
    throw error(403, { message: "Forbidden for non-admins" })
  }
  return handler.execute()
})
```

### Ordering

Middlewares run alphabetically by default, which stops scaling quickly. Add a
numeric suffix to pin the order — lower runs first:

```
middlewares/
  trace.0.ts         first
  authenticate.1.ts
  audit.1.2.ts       between .1 and .2, no renames needed
  authorize.2.ts
  stamp.ts           unnumbered: after everything numbered
```

## The JSON middleware

Enabled for every route by default:

| Handler returns | Response |
| --- | --- |
| an object or array | `200` with a JSON body |
| `undefined` | `204 No Content` |
| `null` from a `GET` | `404 Not Found` |
| `null` from another method | `204 No Content` |

It steps aside automatically when the handler picks a non-JSON content type:

```ts
export default get(async (req, res, ctx) => {
  res.type("html")           // disables it
  return "<h1>Hello</h1>"
})
```

Or explicitly:

```ts
export default get(async (req, res, ctx) => {
  res.raw.end("anything")
}).meta({ json: false })
```

## Errors

`error(status, body)` produces a response instead of a crash. Anything else
that escapes a handler becomes a `500`, with the details logged; stacks are
included in the response body only outside production.

```ts
throw error(404, { message: "No such user" })
```

## WebSockets

Files in `ws/` map to socket endpoints the same way routes do, `[param]`
segments included. `ws/echo.ts` serves `/ws/echo`:

```ts
import { ws } from "clovejs"

export default ws(async ({ onMessage, onDestroy, send, ctx, params }) => {
  onMessage((msg) => {
    ctx.logger.info("message received: " + msg)
    send(msg)
  })
  onDestroy(async () => {
    ctx.logger.info("socket closed")
  })
})
```

Each connection gets its own request-scoped container, disposed when the socket
closes. HTTP middlewares do **not** run for upgrades — authenticate inside the
handler using `ctx`.

## Sessions

Declaring any `session`-scoped value turns sessions on. Visitors are identified
by a signed `clove.sid` cookie, issued only when a session is actually needed.

Set `CLOVE_SECRET` (or pass `sessionSecret`) in production; without it the
signing key is ephemeral and sessions do not survive a restart.

The default store keeps sessions in memory, which is fine for a single process.
To use something else, define `services/sessionStore.ts` returning an object
with `get`, `set`, `touch` and `destroy` — it is picked up automatically.

## Bootstrap and Express interop

```ts
import { bootstrap } from "clovejs"

bootstrap()
```

Alongside an existing Express app:

```ts
import { engine } from "clovejs"
import express from "express"

const app = express()
const clove = await engine(app)
const server = app.listen(3000)
clove.attachUpgrade(server)   // only if you use WebSockets
```

Requests that match no Clove route fall through to the host's own stack.

## Example

A runnable app exercising every convention above — routes, all three DI
lifetimes, middleware ordering, sessions, WebSockets — lives in
[`examples/basic`](./examples/basic):

```bash
git clone https://github.com/cloveteam/clovejs.git
cd clovejs
npm install
npm run dev -w clovejs-example-basic
```

Then, from another terminal:

```bash
# Public
curl localhost:3000/api/notes

# Guarded — 401 until you log in
curl localhost:3000/api/me

# Log in (ada/secret or grace/secret — see examples/basic/src/services/auth.ts)
curl -c cookies.txt -X POST localhost:3000/api/login \
  -H 'content-type: application/json' \
  -d '{"username":"ada","password":"secret"}'

# The clove.sid cookie now carries the session
curl -b cookies.txt localhost:3000/api/me

# ada is an admin; grace is not
curl -b cookies.txt localhost:3000/api/admin/stats
```

[`examples/basic/README.md`](./examples/basic/README.md) maps each file in the
example to the concept it demonstrates.

Prefer clicking through requests to typing them? [`examples/basic/requests.http`](./examples/basic/requests.http)
covers the same flow, no Postman account required — it's read natively by
JetBrains IDEs and by VS Code's [REST Client
extension](https://marketplace.visualstudio.com/items?itemName=humao.rest-client).

## CLI

| Command | Purpose |
| --- | --- |
| `clove dev` | Run with file watching and type generation |
| `clove build` | Generate types, then compile with `tsc` |
| `clove types` | Regenerate `.clove/types.d.ts` only |
| `clove scaffold` | Create the default structure (`--js` for JavaScript) |
| `clove routes` | Print the resolved route table |
| `clove skills` | Install CloveJS instructions for AI editors |

Scaffolding is an explicit command rather than an install-time prompt: package
managers suppress or sandbox `postinstall`, and prompts break CI.

## AI editor support

A convention-driven framework is only pleasant if your assistant knows the
conventions. One command writes them in each editor's own format:

```bash
npx clove skills                      # all of them
npx clove skills --ide cursor,codex   # or pick
```

| Editor | File |
| --- | --- |
| Claude Code | `.claude/skills/clovejs/SKILL.md` |
| Cursor | `.cursor/rules/clovejs.mdc` |
| Antigravity | `.antigravity/rules/clovejs.md` |
| Codex, Gemini CLI, Jules, … | `AGENTS.md` |

`AGENTS.md` is shared with your own instructions, so the command maintains a
single `<!-- clovejs:begin -->` block there and leaves the rest of the file
alone. Re-run it after upgrading CloveJS; it refreshes in place.

## Typed context

`clove dev` and `clove build` write `.clove/types.d.ts`, which augments the
`Ctx` interface with one entry per file in `services/` and `di/`. The
scaffolded `tsconfig.json` already includes it, so `ctx.auth.login()` is typed
with no manual declaration.

Generation is a path-level scan — files are never executed — so it stays fast
and cannot be broken by a module that throws at import time.

## License

MIT
