# Route parameters

A path segment wrapped in square brackets is a parameter. `GET /api/v1/users/1`
resolves to `api/v1/users/[id].get.ts`:

```ts
import { get } from "clovejs"

export default get(async (req, res, ctx) => {
  return ctx.users.findById(parseInt(req.params.id, 10))
})
```

`req.params` is a `Record<string, string>` — values arrive as strings, so
convert them yourself. That is deliberate: the framework does not guess whether
`0123` is a number or an identifier.

## File and directory forms

Both work, and are interchangeable:

| Request | File |
| --- | --- |
| `GET /api/v1/users` | `api/v1/users.get.ts` or `api/v1/users/get.ts` |
| `GET /api/v1/users/1` | `api/v1/users/[id].get.ts` or `api/v1/users/[id]/get.ts` |
| `GET /api/v1/users/1/books` | `api/v1/users/[id]/books.get.ts` or `api/v1/users/[id]/books/get.ts` |
| `GET /api/v1/users/1/books/2` | `api/v1/users/[userId]/books/[bookId].get.ts` |

Nested parameters each get their own name, so `req.params.userId` and
`req.params.bookId` are both available in the last example.

## Precedence

A literal segment always beats a parameter. Given both of these files:

```
api/v1/users/me.get.ts
api/v1/users/[id].get.ts
```

`/api/v1/users/me` matches `me.get.ts`, and `/api/v1/users/42` matches
`[id].get.ts`. Ordering is a property of the router, not of file order or
alphabetisation, so you never have to think about which file "wins".

## Parameters in WebSocket paths

`ws/` uses the same bracket syntax. `ws/rooms/[room].ts` serves
`/ws/rooms/general`, and the handler receives the values on `params`:

```ts
import { ws } from "clovejs"

export default ws(async ({ params, send }) => {
  send(`joined ${params.room}`)
})
```

See [WebSockets](/guide/websockets).

## Query strings

Query parameters are not route parameters. They live on `req.query`, already
parsed:

```ts
export default get(async (req) => {
  const page = Number(req.query.page ?? 1)
  return { page }
})
```

`req.query` keeps only the first value for a repeated key. For the full picture
— repeated keys, or anything else about the URL — use `req.url`, a standard
`URL` instance:

```ts
const tags = req.url.searchParams.getAll("tag")
```
