# Route metadata

Every route definition carries a metadata bag. Attach to it with `.meta()`:

```ts
import { get } from "clovejs"

export default get(async (req, res, ctx) => {
  return ctx.stats.all()
}).meta({
  adminOnly: true,
})
```

[Middlewares](/guide/middlewares) read it as `route.meta.adminOnly`:

```ts
import { middleware, error } from "clovejs"

export default middleware(async ({ route, handler, ctx }) => {
  if (route.meta.adminOnly && !ctx.currentUser?.isAdmin) {
    throw error(403, { message: "Forbidden for non-admins" })
  }
  return handler.execute()
})
```

This is how cross-cutting policy stays declarative: the route states *what it
is*, and one middleware decides *what that means*.

## Chaining and merging

`.meta()` returns the definition, so calls chain and merge:

```ts
export default get(handler)
  .meta({ adminOnly: true })
  .meta({ rateLimit: 10 })   // both keys are present
```

Later calls overwrite earlier keys of the same name.

## Reserved keys

One key is interpreted by the framework itself:

| Key | Type | Meaning |
| --- | --- | --- |
| `json` | `boolean` | Set `false` to disable the built-in [JSON middleware](/guide/json-middleware) for this route |

```ts
export default get(async (req, res, ctx) => {
  res.raw.end("anything")
}).meta({ json: false })
```

Every other key is yours. `RouteMeta` is an open interface
(`[key: string]: unknown`), so any serialisable value is allowed.

## Typing your own metadata

Augment `RouteMeta` once, in a `.d.ts` file inside your project, and every
`.meta()` call and `route.meta` read is checked:

```ts
// src/types/clove.d.ts
declare module "clovejs" {
  interface RouteMeta {
    adminOnly?: boolean
    rateLimit?: number
  }
}

export {}
```

## Reading metadata elsewhere

The full route record — method, path, meta and the source file it came from —
is available on `route` inside middlewares, and from `app.routes.list()` if you
are working with a [`CloveApp`](/guide/bootstrap) directly. The `file` field is
what makes boot-time error messages actionable.
