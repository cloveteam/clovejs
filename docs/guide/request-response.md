# Request and response

Handlers receive `req` and `res` — thin wrappers around Node's
`IncomingMessage` and `ServerResponse`. They wrap rather than extend, so the
surface stays small and the untouched Node objects are always reachable as
`req.raw` and `res.raw`.

Most handlers only need to *return* a value and let the
[JSON middleware](/guide/json-middleware) do the writing. Reach for `res`
when you need explicit control.

## Reading the request

```ts
import { post } from "clovejs"

export default post(async (req, res, ctx) => {
  req.method                 // "POST"
  req.path                   // "/api/v1/login"
  req.url                    // URL instance
  req.query.redirect         // ?redirect=... (first value)
  req.params.id              // [id] route segment
  req.header("user-agent")   // case-insensitive, first value
  req.cookie.token           // parsed cookies (req.cookies is an alias)
  req.ip                     // x-forwarded-for, else socket address
  req.body                   // parsed body, ready synchronously
})
```

### The body

`req.body` is parsed by the pipeline before your handler runs, so it is safe to
read synchronously. JSON, form-encoded and text bodies are handled; the limit
is configurable via the [`bodyLimit`](/reference/configuration) option.

You can also assign to `req.body` — a middleware that validates and coerces
input can replace it, and the handler sees the coerced value.

For binary payloads, read the untouched bytes:

```ts
const buf = await req.rawBody()
```

::: warning
`rawBody()` is only valid if the body was not already parsed — the stream can
be consumed once. Use `.meta({ json: false })` or a middleware that skips
parsing when you need raw bytes.
:::

## Writing the response

Every mutator returns `this`, so calls chain:

```ts
import { get } from "clovejs"

export default get(async (req, res, ctx) => {
  res
    .status(201)
    .header("x-request-id", ctx.requestId)
    .cookie("seen", "1", { httpOnly: true, sameSite: "lax" })
    .type("html")

  return "<h1>Created</h1>"
})
```

### Content types

`res.type()` accepts a full MIME type or a shorthand:

| Shorthand | Content-Type |
| --- | --- |
| `json` | `application/json; charset=utf-8` |
| `html` | `text/html; charset=utf-8` |
| `text` / `txt` | `text/plain; charset=utf-8` |
| `xml` | `application/xml; charset=utf-8` |
| `css` | `text/css; charset=utf-8` |
| `js` | `text/javascript; charset=utf-8` |
| `csv` | `text/csv; charset=utf-8` |
| `bin` / `octet` | `application/octet-stream` |

Setting a **non-JSON** type disables the JSON middleware for that response —
the framework assumes you meant it.

### Cookies

```ts
res.cookie("token", token, {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  maxAge: 60 * 60 * 24,
})

res.clearCookie("token")
```

Multiple `cookie()` calls accumulate into a single `Set-Cookie` header list
rather than overwriting each other.

### Sending explicitly

```ts
res.send({ ok: true })        // object -> JSON
res.send("<h1>Hi</h1>")       // string -> text/html unless a type was set
res.send(buffer)              // Buffer -> application/octet-stream
res.json({ ok: true })        // always JSON
res.redirect("/login")        // 302; pass a status for 301
res.end()                     // no body
```

All of these are no-ops once the response has been sent, so a middleware can
safely finish a response a handler already ended.

## Dropping to raw Node

```ts
export default get(async (req, res, ctx) => {
  res.raw.writeHead(200, { "content-type": "text/event-stream" })
  res.raw.write("data: hello\n\n")
  // stream on...
}).meta({ json: false })
```

`res.sent` reports whether anything has been written — through the wrapper *or*
the raw stream — which is what lets the pipeline know to stand down.

::: tip Streaming events?
For Server-Sent Events, reach for [`sse()`](/guide/sse) instead of writing the
`text/event-stream` framing by hand.
:::

Full member lists: [CloveRequest](/reference/clove-request),
[CloveResponse](/reference/clove-response).
