# The JSON middleware

One middleware ships with the framework and is enabled for every route. It
turns a handler's **return value** into a response, which is why most handlers
never touch `res` at all.

| Handler returns | Response |
| --- | --- |
| an object or array | `200` with a JSON body |
| a primitive (string, number, boolean) | `200` with that value as JSON |
| `undefined` | `204 No Content` |
| `null` from a `GET` | `404 Not Found` |
| `null` from another method | `204 No Content` |

```ts
export default get(async (req, res, ctx) => {
  return ctx.users.findById(Number(req.params.id))   // null -> 404
})
```

The `null` rule is the one worth internalising: a `GET` that finds nothing
*is* a 404, so a repository returning `null` produces the right status without
a line of error handling.

## Setting a status yourself

Set it on `res` and still return a value:

```ts
export default post(async (req, res, ctx) => {
  const user = await ctx.users.create(req.body)
  res.status(201)
  return user
})
```

An explicit non-200 status survives an `undefined` return too — `res.status(202)`
with nothing returned responds `202` with an empty body, not `204`.

## Opting out

It steps aside automatically when the handler picks a non-JSON content type:

```ts
export default get(async (req, res, ctx) => {
  res.type("html")           // disables it
  return "<h1>Hello</h1>"
})
```

Or explicitly, via [route metadata](/guide/route-metadata):

```ts
export default get(async (req, res, ctx) => {
  res.raw.end("anything")
}).meta({ json: false })
```

Setting a content type that *does* contain `json` — `application/problem+json`,
say — keeps the middleware active, so you can customise the type without losing
serialisation.

## Already-sent responses

If the handler wrote the response itself (`res.send()`, `res.json()`,
`res.redirect()`, or anything through `res.raw`), the middleware detects it and
does nothing. Returning a value from such a handler is harmless but pointless.

## Errors

Throwing does not go through this middleware — see [Errors](/guide/errors).
`error(404, { message: "No such user" })` is the explicit form of the `null`
rule above, and is what you want when the 404 needs a body of its own.
