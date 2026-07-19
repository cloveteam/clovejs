/**
 * The one source of truth for what an AI assistant should know about CloveJS.
 *
 * Every editor target renders this same body behind its own front matter, so
 * guidance never drifts between `.cursor/rules` and `.claude/skills`.
 */

export const SKILL_NAME = "clovejs"

export const SKILL_DESCRIPTION =
  "Conventions for writing CloveJS code — file-based routes, services, DI " +
  "lifetimes, middlewares, WebSockets and the CLI. Use whenever editing a " +
  "project that depends on the `clovejs` package."

/** Globs that mark a file as CloveJS-shaped, for editors that scope by path. */
export const SKILL_GLOBS = [
  "**/api/**",
  "**/ws/**",
  "**/di/**",
  "**/services/**",
  "**/middlewares/**",
  "**/main.ts",
  "**/main.js",
]

export const SKILL_BODY = `
CloveJS is a convention-driven Node.js HTTP framework. Routes, services,
middlewares and injectables are discovered from the filesystem — **there is no
registration step and no central config to edit**. Adding behaviour means
adding a file in the right place with the right name.

## Project layout

TypeScript projects keep sources under \`src/\`; JavaScript projects put the
same directories at the repository root. Both are detected automatically —
match whichever the project already uses.

\`\`\`
src/
  api/          route handlers      -> HTTP endpoints
  ws/           socket handlers     -> WebSocket endpoints
  di/           injectable values
  services/     injectable services
  middlewares/  request middlewares
  main.ts       bootstrap()
.clove/         generated types (gitignored — never edit by hand)
\`\`\`

## Routes

A file's default export becomes an endpoint. \`api/v1/login.post.ts\` serves
\`POST /api/v1/login\`:

\`\`\`ts
import { post, error } from "clovejs"

export default post(async (req, res, ctx) => {
  if (!req.body.username) {
    throw error(400, { message: "username is required" })
  }
  return ctx.users.findByName(req.body.username)
})
\`\`\`

Wrappers: \`get\`, \`post\`, \`put\`, \`patch\`, \`del\`, \`head\`, \`options\`,
\`all\`. The \`.{method}.ts\` suffix is conventional and may be omitted, but the
filename and the wrapper must agree — if they disagree the project refuses to
boot and names the offending file.

\`[param]\` segments capture path parameters, in either file or directory form:

| Request | File |
| --- | --- |
| \`GET /api/v1/users\` | \`api/v1/users.get.ts\` or \`api/v1/users/get.ts\` |
| \`GET /api/v1/users/1\` | \`api/v1/users/[id].get.ts\` |
| \`GET /api/v1/users/1/books/2\` | \`api/v1/users/[userId]/books/[bookId].get.ts\` |

Params arrive as strings on \`req.params\` — parse them yourself. A literal
segment always beats a parameter, so \`users/me.get.ts\` wins for \`/users/me\`.

Attach metadata for middlewares to read as \`route.meta.*\`:

\`\`\`ts
export default get(async (req, res, ctx) => { /* ... */ }).meta({ adminOnly: true })
\`\`\`

## Return values (the JSON middleware)

Enabled for every route by default:

| Handler returns | Response |
| --- | --- |
| object or array | \`200\` with a JSON body |
| \`undefined\` | \`204 No Content\` |
| \`null\` from a \`GET\` | \`404 Not Found\` |
| \`null\` from another method | \`204 No Content\` |

Prefer returning data over calling \`res\` methods. The middleware steps aside
when the handler picks a non-JSON content type (\`res.type("html")\`) or opts
out with \`.meta({ json: false })\`.

## Errors

\`error(status, body)\` produces a response instead of a crash; anything else
escaping a handler becomes a \`500\` with details logged. Stacks reach the
response body only outside production.

\`\`\`ts
throw error(404, { message: "No such user" })
\`\`\`

## Services

Files in \`services/\` are singletons created at boot and injected into \`ctx\`
under their filename — \`services/auth.ts\` becomes \`ctx.auth\`.

\`\`\`ts
import { service, error } from "clovejs"

export default service(async (ctx, { onDestroy }) => {
  onDestroy(async () => { /* teardown */ })

  return {
    async login(params: LoginParams) {
      const user = await ctx.db.user.find(params)
      if (!user) throw error(401, { message: "Bad credentials" })
      return user
    },
  }
})
\`\`\`

**Call siblings through a local function in the closure, not \`this.other()\`.**
TypeScript cannot infer a method's return type when it depends on the object
literal containing it, so \`this\` forces hand-written return type annotations.

## DI values and lifetime scopes

Files in \`di/\` inject plain values, each declaring how long it lives:
\`singleton\` (the process), \`session\` (one visitor) or \`request\`.

\`\`\`ts
import { di } from "clovejs"

export default di({ lifetime: "session", value: null as User | null })
\`\`\`

Assigning from a middleware writes into the declared scope:
\`ctx.currentUser = await ctx.auth.verify(req.cookie.token)\`.

A value may instead be computed, with access to other dependencies and to
teardown hooks:

\`\`\`ts
export default di({
  lifetime: "singleton",
  async value(ctx, { onDestroy }) {
    const client = new Client(ctx.config.db)
    await client.connect()
    onDestroy(async () => client.end())
    return client
  },
})
\`\`\`

**Resolution rules.** Singletons all resolve before traffic is accepted, so
reading \`ctx.db\` from a handler or service method is synchronous and safe.
Inside a *factory*, \`await\` whatever you depend on — awaiting a plain value is
harmless, so awaiting uniformly is always correct. Session- and request-scoped
factories resolve on first access in their scope, so that first read is a
promise.

## Middlewares

Every file in \`middlewares/\` wraps every route. Code before
\`handler.execute()\` runs inbound, code after it outbound; returning without
calling it short-circuits.

\`\`\`ts
import { middleware, error } from "clovejs"

export default middleware(async ({ route, handler, ctx }) => {
  if (route.meta.adminOnly && !ctx.currentUser?.isAdmin) {
    throw error(403, { message: "Forbidden" })
  }
  return handler.execute()
})
\`\`\`

Ordering is alphabetical by default. Pin it with a numeric suffix — lower runs
first, and fractional suffixes let you insert without renaming:

\`\`\`
middlewares/
  trace.0.ts         first
  authenticate.1.ts
  audit.1.2.ts       between .1 and .2
  authorize.2.ts
  stamp.ts           unnumbered: after everything numbered
\`\`\`

## WebSockets

Files in \`ws/\` map to socket endpoints like routes do, \`[param]\` segments
included. \`ws/echo.ts\` serves \`/ws/echo\`:

\`\`\`ts
import { ws } from "clovejs"

export default ws(async ({ onMessage, onDestroy, send, ctx, params }) => {
  onMessage((msg) => send(msg))
  onDestroy(async () => { /* cleanup */ })
})
\`\`\`

Each connection gets its own request-scoped container, disposed when the socket
closes. **HTTP middlewares do not run for upgrades** — authenticate inside the
handler using \`ctx\`.

## Sessions

Declaring any \`session\`-scoped value turns sessions on. Visitors are
identified by a signed \`clove.sid\` cookie issued only when a session is
actually needed. Set \`CLOVE_SECRET\` (or pass \`sessionSecret\`) in production,
or sessions will not survive a restart.

The default store is in-memory. To replace it, define
\`services/sessionStore.ts\` returning \`get\`, \`set\`, \`touch\` and
\`destroy\` — it is picked up automatically.

## Bootstrap and Express interop

\`\`\`ts
import { bootstrap } from "clovejs"

bootstrap()
\`\`\`

Alongside an existing Express app:

\`\`\`ts
import { engine } from "clovejs"

const app = express()
const clove = await engine(app)
const server = app.listen(3000)
clove.attachUpgrade(server)   // only if you use WebSockets
\`\`\`

Requests matching no Clove route fall through to the host's own stack.

## CLI

| Command | Purpose |
| --- | --- |
| \`clove dev\` | Run with file watching and type generation |
| \`clove build\` | Generate types, then compile with \`tsc\` |
| \`clove types\` | Regenerate \`.clove/types.d.ts\` only |
| \`clove scaffold\` | Create the default structure (\`--js\` for JavaScript) |
| \`clove routes\` | Print the resolved route table |
| \`clove skills\` | Install these instructions for AI editors |

Every command takes \`--dir <path>\` to target another project root.

## Typed context

\`clove dev\` and \`clove build\` write \`.clove/types.d.ts\`, augmenting the
\`Ctx\` interface with one entry per file in \`services/\` and \`di/\`. After
adding or renaming a provider, run \`npx clove types\` so \`ctx\` type-checks —
generation is a path-level scan, so it never executes project code.

## Checklist when editing a CloveJS project

- Put the file where the convention says; do not add a registry or router.
- Match the wrapper to the filename's method suffix.
- Return data and let the JSON middleware respond; throw \`error()\` for
  failures.
- Reach dependencies through \`ctx\`, never by importing another provider
  module directly.
- Run \`npx clove routes\` to confirm a filename produced the URL you expected,
  and \`npx clove types\` after touching \`services/\` or \`di/\`.
`.trim()
