# Values and lifetime scopes

Files in `di/` inject plain values onto `ctx`. Each declares how long it lives:
`singleton` (the whole process), `session` (one visitor), or `request`.

```ts
// src/di/currentUser.ts
import { di } from "clovejs"

export default di({
  lifetime: "session",
  value: null as User | null,
})
```

## The three lifetimes

| Lifetime | Created | Disposed | Typical use |
| --- | --- | --- | --- |
| `singleton` | Once, at boot, before the server listens | On shutdown | Config, database clients, caches |
| `session` | On first access within a visitor's session | When the session expires or is destroyed | The signed-in user, a cart |
| `request` | On first access within one request | When the response finishes | Request id, per-request transaction |

Declaring **any** `session`-scoped value turns [sessions](/guide/sessions) on
for the app. `request` scope needs no setup.

WebSocket connections each get their own request-scoped container, disposed
when the socket closes.

## Assigning from a middleware

Writing to `ctx` writes into the scope the value was declared with, so a
`session` value assigned during one request is still there on the next:

```ts
// src/middlewares/authenticate.1.ts
import { middleware } from "clovejs"

export default middleware(async ({ handler, req, ctx }) => {
  ctx.currentUser = await ctx.auth.verify(req.cookie.token)
  return handler.execute()
})
```

## Computed values

A value can be a factory, with access to other dependencies and to teardown
hooks:

```ts
// src/di/db.ts
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

The distinction is made by type: if `value` is a function, it is treated as a
factory. To inject a function *as a value*, wrap it — `value: () => myFn` —
or return it from a [service](/guide/services) instead.

## Resolution rules

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
scope, so the first read returns a promise:

```ts
export default get(async (req, res, ctx) => {
  const tx = await ctx.transaction   // request-scoped factory
  return tx.query("select 1")
})
```

::: tip Rule of thumb
In a handler, `await` anything that is not a `singleton`. In a factory,
`await` everything.
:::

## Configuration values

The most common `di/` file is plain config, read from the environment once:

```ts
// src/di/config.ts
import { di } from "clovejs"

export default di({
  lifetime: "singleton",
  value: {
    url: process.env.URL ?? "http://localhost:3000",
    db: {
      user: process.env.DB_USER ?? "postgres",
      password: process.env.DB_PASSWORD ?? "",
    },
  },
})
```

`ctx.config` is typed from this file's inferred type — no interface to
maintain. See [Typed context](/guide/typed-context).

## Teardown ordering

`onDestroy` hooks run in reverse registration order when their scope is
disposed, so a dependency is always torn down after the things that used it.
