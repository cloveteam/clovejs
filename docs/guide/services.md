# Services

Files in `services/` are injected into `ctx` under their filename. They are
singletons, created once at boot, and available to handlers, middlewares,
WebSocket handlers and to each other.

```ts
// src/services/auth.ts
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

That file is now `ctx.auth`, typed, everywhere.

## The factory

```ts
service((ctx, hooks) => T | Promise<T>)
```

- `ctx` — the same DI context handlers see, so a service can depend on other
  services and on `di/` values.
- `hooks.onDestroy(fn)` — register teardown, run in reverse registration order
  when the scope is disposed.

Whatever the factory returns becomes the value on `ctx`. It does not have to be
an object — a service may return a function, a class instance, or a client
library's handle.

## Private state lives in the closure

Anything declared inside the factory but not returned is private. There is no
visibility modifier to remember and no `#field` syntax to reach for:

```ts
export default service(async (ctx) => {
  const cache = new Map<string, User>()      // private

  return {
    get(id: string) {                        // public
      return cache.get(id)
    },
  }
})
```

## Private helpers

To share logic between methods without exposing it on the service, declare a
plain function in the closure:

```ts
export default service(async (ctx) => {
  function hash(password: string) {
    return createHash("sha256").update(password).digest("hex")
  }

  return {
    verify(password: string, digest: string) {
      return hash(password) === digest        // private to the closure
    },
  }
})
```

## Initialisation order

You do not declare one. Services and `di/` values resolve on demand: reading
`ctx.db` from inside the `auth` factory resolves `db` first. All singletons are
fully resolved **before the server accepts traffic**, so by the time a request
arrives, every `ctx.<service>` read is synchronous.

Inside a factory, though, `await` anything you depend on — see
[resolution rules](/guide/dependency-injection#resolution-rules).

## Teardown

```ts
export default service(async (ctx, { onDestroy }) => {
  const consumer = await connectQueue(ctx.config.amqp)
  onDestroy(async () => consumer.close())
  return consumer
})
```

`onDestroy` callbacks run when the app shuts down — on `SIGINT`/`SIGTERM` under
[`bootstrap()`](/guide/bootstrap), or when you call `close()` yourself.

## Services vs. `di/` values

| Use `services/` when… | Use `di/` when… |
| --- | --- |
| You are exposing behaviour — methods | You are exposing a value — config, a client, the current user |
| A singleton is right | You need `session` or `request` lifetime |

Both land on `ctx` and are typed the same way. See
[Values and lifetimes](/guide/dependency-injection).

## Special filenames

One name is interpreted by the framework:

| File | Effect |
| --- | --- |
| `services/cacheStore.ts` | Replaces the in-process [route cache store](/guide/caching#store-adapters) |
| `services/sessionStore.ts` | Returned object is used as the [session store](/guide/sessions#custom-stores) |
| `services/logger.ts` | Replaces the built-in `ctx.logger` |

`ctx.logger` exists without you defining anything — the framework registers a
console logger before scanning, and steps aside if your project provides its
own `logger` service.
