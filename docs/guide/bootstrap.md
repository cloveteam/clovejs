# Bootstrap

`bootstrap()` scans the project, resolves every singleton, and starts
listening:

```ts
// src/main.ts
import { bootstrap } from "clovejs"

bootstrap()
```

That is the whole entry point in a default project.

## Options

```ts
await bootstrap({
  port: 8080,
  host: "0.0.0.0",
  logLevel: "info",
  sessionSecret: process.env.CLOVE_SECRET,
  exposeErrors: false,
})
```

Every [`AppOptions`](/reference/configuration) field is accepted, plus:

| Option | Default | Meaning |
| --- | --- | --- |
| `port` | `PORT` env, else `3000` | Port to listen on. Pass `0` to let the OS choose — `clove.port` reports the real one |
| `host` | `HOST` env, else `localhost` | Interface to bind. Use `0.0.0.0` in a container |
| `handleSignals` | `true` | Register `SIGINT`/`SIGTERM` handlers for graceful shutdown |

## Environment variables

Clove loads `.env` files on startup, before any of your files are evaluated —
so a service or `di/` value can read `process.env` at module scope and see the
value:

```bash
# .env
DATABASE_URL=postgres://localhost/app
CLOVE_SECRET=dev-only-secret
```

```ts
// src/di/config.ts
import { di } from "clovejs"

export default di({
  lifetime: "singleton",
  value: { databaseUrl: process.env.DATABASE_URL },
})
```

No dependency and no import are needed; this happens inside `bootstrap()`,
`engine()`, `createApp()` and `clove dev` alike.

### Which files are read

Four files are consulted, and the first one to define a key wins:

| Order | File | Purpose |
| --- | --- | --- |
| 1 | `.env.[NODE_ENV].local` | Machine-specific overrides for one mode. Never commit |
| 2 | `.env.[NODE_ENV]` | Per-mode defaults, e.g. `.env.production` |
| 3 | `.env.local` | Machine-specific overrides. Never commit |
| 4 | `.env` | Shared defaults. Safe to commit when it holds no secrets |

Keys are merged across files rather than the search stopping at the first
file — a key set only in `.env` still applies when `.env.production` exists.

`.local` files are skipped when `NODE_ENV=test`, so a test run does not depend
on one developer's machine.

::: warning The real environment always wins
A variable already present in `process.env` is never overwritten by a file. An
exported shell variable, a value injected by your host, or a secret from your
orchestrator takes precedence over anything committed to the repo — which is
what makes it safe to keep a `.env` of development defaults in version control.
:::

### Syntax

```bash
# Comments and blank lines are ignored.
PLAIN=value                  # trailing comments too
QUOTED="value with #hash"    # quotes preserve spaces and #
SINGLE='no \n escapes here'  # single quotes are literal
ESCAPED="line one\nline two" # double quotes expand \n \r \t \b \f
MULTILINE="spans
several lines"
export PREFIXED=works        # a leading `export` is allowed
EMPTY=                       # an empty string
```

### Controlling it

```ts
await bootstrap({ env: false })                    // load nothing
await bootstrap({ env: [".env.shared", ".env"] })  // an explicit list
```

An explicit list replaces the cascade and keeps the same precedence: earlier
files win, and the real environment beats them all.

## What you get back

```ts
const clove = await bootstrap()

clove.app        // the CloveApp: registry, routes, DI root, logger
clove.server     // the node http.Server
clove.port       // resolved port
clove.host       // resolved host
clove.url        // e.g. "http://localhost:3000"
await clove.close()
```

`close()` shuts the server, closes WebSocket connections, and runs every
`onDestroy` hook. With `handleSignals` left on, `SIGINT` and `SIGTERM` do this
for you.

Awaiting `bootstrap()` is optional in `main.ts` — the promise resolves once the
server is listening, which is only interesting if you have something to do
afterwards, such as in a test.

## Booting without listening

`createApp()` does everything `bootstrap()` does except open a socket. Useful in
tests, or when the app is going to be driven by something else:

```ts
import { createApp } from "clovejs"

const app = await createApp({ logLevel: "silent" })

app.routes.list()      // the resolved route table
app.listener           // a (req, res) function for http.createServer
app.middleware         // a connect/express-style middleware
app.attachUpgrade(server)
await app.close()
```

## Graceful shutdown

```ts
const clove = await bootstrap({ handleSignals: false })

process.on("SIGTERM", async () => {
  await clove.close()
  process.exit(0)
})
```

Turn `handleSignals` off when the surrounding process manager — or a test
harness — owns the lifecycle.

## Startup order

1. Load `.env` files into `process.env`.
2. Scan the source directory; validate conventions. A violation throws
   [`CloveBootError`](/guide/errors#boot-errors) here, before anything starts.
3. Build the registry and the router.
4. Resolve **all** singleton services and `di/` values.
5. Start listening.

Step 1 comes first, so every module the scanner evaluates already sees its
environment. Because step 4 completes before step 5, no request can observe a
half-initialised container — which is why `ctx.db` is safe to read
synchronously in a handler.

## Next

- [Express interop](/guide/express-interop) — when Clove is not the whole app
- [Deployment](/guide/deployment) — building and running in production
- [Configuration reference](/reference/configuration) — every option
