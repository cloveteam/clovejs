# Routes

The default export of a module under `api/` becomes an HTTP endpoint. The
file's path becomes the URL, and the wrapper function determines the method.

`api/v1/login.post.ts` serves `POST /api/v1/login`:

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

## Handler signature

```ts
(req: CloveRequest, res: CloveResponse, ctx: RuntimeCtx) => unknown | Promise<unknown>
```

- `req` — the parsed request. See [CloveRequest](/reference/clove-request).
- `res` — the response builder. See [CloveResponse](/reference/clove-response).
- `ctx` — the DI context, typed from your `services/` and `di/` files.

What you **return** matters: the [JSON middleware](/guide/json-middleware)
turns objects into `200` responses, `undefined` into `204`, and `null` from a
`GET` into `404`.

## Method wrappers

| Wrapper | Method | Conventional filename |
| --- | --- | --- |
| `get` | `GET` | `users.get.ts` |
| `post` | `POST` | `login.post.ts` |
| `put` | `PUT` | `profile.put.ts` |
| `patch` | `PATCH` | `profile.patch.ts` |
| `del` | `DELETE` | `session.del.ts` |
| `head` | `HEAD` | `asset.head.ts` |
| `options` | `OPTIONS` | `cors.options.ts` |
| `all` | *every method* | `proxy.all.ts` |

`del` is named that way because `delete` is a reserved word in JavaScript.

## The filename suffix is optional

The `.{method}.ts` suffix is conventional and can be omitted, as long as the
handler is wrapped in the matching function. These are equivalent:

```
api/v1/login.post.ts     export default post(...)
api/v1/login.ts          export default post(...)
```

::: warning Disagreement is a boot error
If a filename and its wrapper disagree — `login.post.ts` exporting `get(...)` —
the project refuses to boot and tells you which file to fix. A route that
silently fails to register is far more expensive than a startup crash.
:::

## Directory form

A route can be a file or a directory with the method inside it. Both forms are
interchangeable and can be mixed freely in one project:

```
api/v1/users.get.ts        ->  GET /api/v1/users
api/v1/users/get.ts        ->  GET /api/v1/users
```

Use the directory form when a resource has enough files that grouping helps.

## Web pages at the root

`web/` is a second route directory, identical to `api/` in every way except
where it mounts: its files hang off the root `/` rather than `/api`. It exists
for the things that are not an API — HTML pages served straight off the domain.

```
web/get.ts               ->  GET /
web/about.get.ts         ->  GET /about
web/blog/[slug].get.ts   ->  GET /blog/:slug
```

Everything else is the same: the method wrappers, the filename suffix rules,
route parameters, middlewares, and the return-value pipeline. Pairing `web/`
with an [HTML template engine](/guide/templates) is the common case:

```ts
// web/get.ts  ->  GET /
import { get, view } from "clovejs"

export default get(async (req) => view("home", { name: req.query.name }))
```

A `web/` file and an `api/` file may not resolve to the same URL — but since
one mounts at `/` and the other under `/api`, that only happens if a `web/`
file is literally named to sit under `/api`. Clashes are a boot error, as they
are within a single directory.

## Inspecting the route table

```bash
npx clove routes
```

Prints every resolved route with its method and path — the fastest way to
confirm a convention did what you expected.

## Next

- [Route parameters](/guide/route-parameters) — `[id]` segments
- [Route metadata](/guide/route-metadata) — attaching data middlewares can read
