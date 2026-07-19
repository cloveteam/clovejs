# CloveResponse

The response object handed to route handlers and middlewares. Handlers usually
just return a value and let the [JSON middleware](/guide/json-middleware) do
the writing; this class is for the cases that need explicit control.

Every mutator returns `this`, so calls chain.

## Properties

| Member | Type | Description |
| --- | --- | --- |
| `raw` | `ServerResponse` | The untouched Node response |
| `sent` | `boolean` | True once a body has been written — through this wrapper *or* the raw stream |
| `statusCode` | `number` | The status currently set |
| `contentType` | `string \| undefined` | The `Content-Type` currently set |
| `typeIsExplicit` | `boolean` | Whether the handler chose the content type rather than inheriting it |

`sent` is what lets the pipeline stand down when a handler wrote the response
itself. `typeIsExplicit` is what lets the JSON middleware
[step aside](/guide/json-middleware#opting-out).

## Status and headers

```ts
res.status(201)
res.header("x-request-id", id)
res.set("x-request-id", id)      // alias, for readers coming from Express
```

## `type(value)`

Sets the `Content-Type`. Accepts a full MIME type or a shorthand:

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

Setting a **non-JSON** type disables the built-in JSON middleware for that
response.

## Cookies

```ts
cookie(name: string, value: string, opts?: CookieOptions): this
clearCookie(name: string, opts?: CookieOptions): this
```

Multiple `cookie()` calls accumulate into the `Set-Cookie` header list rather
than overwriting each other. `clearCookie()` writes an empty value with an
expired date.

### `CookieOptions`

| Field | Type |
| --- | --- |
| `domain` | `string` |
| `path` | `string` |
| `expires` | `Date` |
| `maxAge` | `number` |
| `httpOnly` | `boolean` |
| `secure` | `boolean` |
| `sameSite` | `"strict" \| "lax" \| "none"` |
| `partitioned` | `boolean` |

## Sending a body

### `send(body?)`

Writes a body and ends the response, picking a sensible default content type
when none was set:

| Argument | Behaviour |
| --- | --- |
| `Buffer` | Written as-is; defaults to `application/octet-stream` |
| `string` | Written as-is; defaults to `text/html` |
| object / array | Serialised as JSON |
| `undefined` / `null` | Ends with no body |

### `json(body)`

Always serialises as JSON, defaulting the content type to
`application/json` if none was set.

### `redirect(location, status?)`

Sets the status (default `302`) and `Location`, then ends the response.

### `end()`

Ends the response with no body.

::: tip Safe to call twice
All of these are no-ops once `sent` is true, so a middleware can call `end()`
on a response a handler already finished without corrupting it.
:::

## Streaming

Drop to `res.raw` and opt the route out of JSON handling:

```ts
export default get(async (req, res) => {
  res.raw.writeHead(200, { "content-type": "text/event-stream" })
  res.raw.write("data: hello\n\n")
}).meta({ json: false })
```

`sent` reports `true` once anything reaches the raw stream, so the pipeline
will not try to write over you.
