# Errors

`error(status, body)` produces a response instead of a crash:

```ts
import { get, error } from "clovejs"

export default get(async (req, res, ctx) => {
  const user = await ctx.users.findById(Number(req.params.id))
  if (!user) throw error(404, { message: "No such user" })
  return user
})
```

Anything else that escapes a handler becomes a `500`, with the details logged.

## Two kinds of failure

| | Rendered as | Logged | Body |
| --- | --- | --- | --- |
| `throw error(...)` | The status you chose | No — it is an expected outcome | The body you passed |
| Any other throw | `500` | Yes, with the stack | Generic, unless `exposeErrors` |

The split is deliberate. A `401` from a login route is not an incident and
should not page anyone; a `TypeError` from a service is.

## Throwing from anywhere

`error()` works in handlers, middlewares, services and `di/` factories alike —
the pipeline catches it wherever it originates:

```ts
// src/services/auth.ts
export default service(async (ctx) => ({
  async login({ username, password }) {
    const user = await ctx.db.user.find({ username })
    if (!user) throw error(401, { message: "Username / password pair mismatch" })
    return user
  },
}))
```

The route stays free of translation code.

## The body

`error()` accepts anything serialisable:

```ts
throw error(400, {
  message: "Validation failed",
  fields: { email: "must be an email address" },
})
```

Passing a string uses it as the message, and omitting the body entirely
produces `{ message: "HTTP 404" }`. When the body is an object with a
`message` property, that value also becomes the JS `Error.message`, so logs and
responses agree.

## Stack traces

Stacks are included in `500` response bodies only outside production. Force
either way with the [`exposeErrors`](/reference/configuration) option:

```ts
bootstrap({ exposeErrors: false })
```

Leave it unset unless you have a reason — the default already does the right
thing per environment.

## Catching errors in a middleware

Because errors propagate through the chain, one middleware can render them all:

```ts
// src/middlewares/errors.0.ts
import { middleware, isHttpError } from "clovejs"

export default middleware(async ({ handler, ctx }) => {
  try {
    return await handler.execute()
  } catch (err) {
    if (isHttpError(err)) throw err        // let the pipeline render it
    ctx.logger.error("unhandled", err)
    throw err
  }
})
```

Use `isHttpError()` rather than `instanceof HttpError`: a project can end up
with more than one copy of the framework loaded (ESM alongside CJS, or a
hoisting miss), and an error thrown by one copy must still be recognised by the
other. `isHttpError` checks a shared symbol brand, so it works across copies.

## Boot errors

Convention violations found while scanning the project throw `CloveBootError`
**before** the server starts, and always name the offending files:

```
CloveBootError: Route file method does not match its handler
  - src/api/v1/login.post.ts
```

There is no partial start: a project either satisfies its conventions or does
not run.
