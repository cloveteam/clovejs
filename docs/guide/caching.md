# Caching

Clove caches the terminal route handler, not the middleware pipeline around it.
Every request still enters and unwinds through all middlewares. An interceptor
may authenticate the caller before `handler.execute()`, short-circuit without
touching the cache, or transform the cached handler result afterwards.

## Cache a route

Add `.cache()` to a `GET` or `HEAD` route:

```ts
import { get } from "clovejs"

export default get(async (req, _res, ctx) => {
  return ctx.notes.findById(Number(req.params.id))
}).cache({
  ttl: "1m",
  scope: "public",
  staleWhileRevalidate: "5m",
  tags: ({ req }) => ["notes", `note:${req.params.id}`],
  client: {
    maxAge: "30s",
    sharedMaxAge: "1m",
  },
})
```

Durations accept milliseconds or a value ending in `ms`, `s`, `m`, `h` or
`d`. Invalid durations and `.cache()` on mutation routes are boot errors.

The default key contains the HTTP method, resolved route, path parameters and
sorted query parameters. Use `vary` for representation-changing request
headers:

```ts
.cache({
  ttl: "10m",
  vary: ["accept-language", "accept-encoding"],
})
```

Those headers are included in the engine key and emitted through the HTTP
`Vary` header.

Use `key` only for identity that the default key cannot see:

```ts
.cache({
  ttl: "30s",
  key: ({ ctx }) => `account:${ctx.currentUser.id}`,
})
```

The default scope is `private`. Requests carrying `Authorization` or `Cookie`
bypass the engine cache unless a custom identity key is present. Set
`scope: "public"` only when the handler result is deliberately identical for
every caller; this allows the engine cache to ignore credentials while the
authentication middleware still runs. Credentialed and `Set-Cookie` responses
always receive `Cache-Control: private, no-store`, regardless of the declared
client policy.

## Invalidate after mutations

Mutation routes declare the tags they invalidate:

```ts
import { patch } from "clovejs"

export default patch(async (req, _res, ctx) => {
  return ctx.notes.update(Number(req.params.id), req.body)
}).invalidates(({ req }) => [
  "notes",
  `note:${req.params.id}`,
])
```

Invalidation happens only when middleware reached the handler, the complete
interceptor chain succeeded, and the resulting status is `2xx`. A middleware
short-circuit does not invalidate anything.

Code outside a route may invalidate imperatively:

```ts
await ctx.cache.invalidate(["notes", `note:${note.id}`])
```

## Browser and CDN caching

`client` controls HTTP caching independently of the engine-side `ttl`.
Clove generates an `ETag` from the final response after all interceptors and
answers a matching `If-None-Match` with `304 Not Modified`.

Without `client`, cached routes use `Cache-Control: private, no-cache`, allowing
conditional revalidation without advertising shared freshness. Pass `false`
for `no-store`.

```ts
.cache({
  ttl: "5m",
  client: {
    maxAge: "30s",
    sharedMaxAge: "5m",
    staleWhileRevalidate: "1m",
    immutable: false,
  },
})
```

## Store adapters

The default `MemoryCacheStore` is suitable for development and a single
process. For multiple application instances, define `services/cacheStore.ts`
and return a distributed adapter:

```ts
import { service, type CacheStore } from "clovejs"

export default service(async (_ctx, { onDestroy }) => {
  const store = createRedisCacheStore()
  onDestroy(() => store.close())
  return store satisfies CacheStore
})
```

The adapter implements:

```ts
interface CacheStore {
  get(key: string): Promise<CacheEntry | undefined>
  set(
    key: string,
    entry: CacheEntry,
    options: { ttl: number; tags: readonly string[] },
  ): Promise<void>
  delete(key: string): Promise<void>
  invalidateTags(tags: readonly string[]): Promise<void>
}
```

Store failures are logged and requests continue through the handler. Entries
whose result cannot be serialized are served normally and not cached. Raw and
streaming responses also bypass the route cache.
