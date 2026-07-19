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

1. Scan the source directory; validate conventions. A violation throws
   [`CloveBootError`](/guide/errors#boot-errors) here, before anything starts.
2. Build the registry and the router.
3. Resolve **all** singleton services and `di/` values.
4. Start listening.

Because step 3 completes before step 4, no request can observe a
half-initialised container — which is why `ctx.db` is safe to read
synchronously in a handler.

## Next

- [Express interop](/guide/express-interop) — when Clove is not the whole app
- [Deployment](/guide/deployment) — building and running in production
- [Configuration reference](/reference/configuration) — every option
