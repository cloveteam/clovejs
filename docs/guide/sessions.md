# Sessions

Declaring any `session`-scoped value turns sessions on. There is no separate
switch:

```ts
// src/di/currentUser.ts
import { di } from "clovejs"

export default di({
  lifetime: "session",
  value: null as User | null,
})
```

Visitors are identified by a signed `clove.sid` cookie, issued only when a
session is actually needed — a request that never touches a session-scoped
value never sets a cookie.

## Using session values

Write from a middleware, read anywhere:

```ts
// src/middlewares/authenticate.1.ts
export default middleware(async ({ handler, req, ctx }) => {
  if (!ctx.currentUser) {
    ctx.currentUser = await ctx.auth.verify(req.cookie.token)
  }
  return handler.execute()
})
```

```ts
// src/api/me.get.ts
export default get(async (req, res, ctx) => {
  return ctx.currentUser        // null -> 404, per the JSON middleware
})
```

The value persists across requests from the same visitor until the session
expires.

## The signing secret

::: danger Set a secret in production
Set `CLOVE_SECRET` (or pass `sessionSecret`) in production; without it the
signing key is ephemeral and sessions do not survive a restart. The framework
logs a warning at boot when no secret is configured.
:::

```bash
CLOVE_SECRET="$(openssl rand -hex 32)"
```

```ts
bootstrap({ sessionSecret: process.env.CLOVE_SECRET })
```

An ephemeral key is fine for local development, and is why `clove dev` does not
nag beyond the warning.

## Expiry

Sessions use a **sliding** TTL — activity extends the lifetime. The default is
24 hours; override it in milliseconds:

```ts
bootstrap({ sessionTtl: 60 * 60 * 1000 })   // one hour
```

When a session expires, its container is disposed and any `onDestroy` hooks
registered by session-scoped factories run.

## Custom stores

The default store keeps sessions in memory, which is fine for a single process
and wrong the moment you run two. To use something else, define
`services/sessionStore.ts` returning an object with `get`, `set`, `touch` and
`destroy` — it is picked up automatically, with no configuration:

```ts
// src/services/sessionStore.ts
import { service } from "clovejs"
import type { SessionStore } from "clovejs"

export default service(async (ctx): Promise<SessionStore> => {
  const redis = await ctx.redis
  const key = (id: string) => `sess:${id}`
  const ttl = 60 * 60 * 24

  return {
    async get(id) {
      const raw = await redis.get(key(id))
      return raw ? JSON.parse(raw) : undefined
    },
    async set(id, data) {
      await redis.set(key(id), JSON.stringify(data), { EX: ttl })
    },
    async touch(id) {
      await redis.expire(key(id), ttl)
    },
    async destroy(id) {
      await redis.del(key(id))
    },
  }
})
```

`touch` extends the TTL without rewriting the data — implement it as a cheap
expiry bump rather than a read-modify-write.

## Sessions over WebSockets

A WebSocket upgrade carries cookies, so session-scoped values resolve for
socket connections too. The session is read at connect time; a value written
during the connection's lifetime is persisted like any other.
