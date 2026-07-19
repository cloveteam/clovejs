# Express interop

CloveJS does not have to own the process. `engine()` boots the project without
listening and returns a middleware you can mount:

```ts
import { engine } from "clovejs"
import express from "express"

const app = express()
const clove = await engine(app)
const server = app.listen(3000)
clove.attachUpgrade(server)   // only if you use WebSockets
```

This lets you adopt Clove inside an app you already have. Existing Express
routes keep running unchanged while you migrate to Clove's conventions one
route at a time.

## Mounting manually

Passing the app to `engine()` calls `app.use()` for you. Skip it when you want
control over ordering:

```ts
const clove = await engine()

app.use(express.static("public"))   // static files win
app.use(clove.middleware)           // then Clove
app.use(legacyRouter)               // then whatever is left
```

Anything mounted before Clove takes precedence; anything after it handles what
Clove did not match.

## What `engine()` returns

The returned value *is* the middleware function, with extras attached:

| Member | What it is |
| --- | --- |
| `clove.app` | The underlying `CloveApp` |
| `clove.middleware` | The `(req, res, next)` middleware — same function |
| `clove.listener` | A `(req, res)` handler for `http.createServer` |
| `clove.attachUpgrade(server)` | Wires the WebSocket upgrade handler |
| `clove.close()` | Runs teardown for every scope |

It accepts any host with a `use()` method, so Connect and Connect-compatible
frameworks work the same way.

## Without a framework

```ts
import { createServer } from "node:http"
import { createApp } from "clovejs"

const app = await createApp()
const server = createServer(app.listener)
app.attachUpgrade(server)
server.listen(3000)
```

## Body parsing

Clove parses request bodies itself, by reading the request stream.

::: warning Do not parse the body twice
A host body parser mounted **before** `clove.middleware` — `express.json()`,
say — consumes the stream, and Clove has nothing left to read. Mount such
parsers *after* Clove, or drop them for the paths Clove handles.
:::

```ts
app.use(clove.middleware)
app.use(express.json())     // only the fall-through side needs it
app.use(legacyRouter)
```

## Shutdown

`engine()` does not register signal handlers — the host owns the lifecycle.
Call `clove.close()` yourself so `onDestroy` hooks run:

```ts
process.on("SIGTERM", async () => {
  server.close()
  await clove.close()
  process.exit(0)
})
```

## Migrating incrementally

The fall-through behaviour makes a route-by-route migration practical:

1. Mount `clove.middleware` **before** your existing router.
2. Move one endpoint at a time into `api/`, deleting the Express route as you
   go — Clove now matches it first.
3. When the old router handles nothing, remove it.

Services and `di/` values are available to the Clove side from day one, so
shared logic can move ahead of the routes that use it.
