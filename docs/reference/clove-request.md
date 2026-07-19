# CloveRequest

The request object handed to route handlers, middlewares and WebSocket
handlers. It **wraps** `IncomingMessage` rather than extending it, so the
surface stays small and predictable; the raw Node request is always available
as `req.raw`.

## Properties

| Member | Type | Description |
| --- | --- | --- |
| `raw` | `IncomingMessage` | The untouched Node request |
| `method` | `string` | Upper-cased HTTP method |
| `path` | `string` | Pathname only, no query string |
| `url` | `URL` | Full parsed URL, honouring `x-forwarded-proto` |
| `query` | `Record<string, string>` | Query parameters; first value per key |
| `params` | `Record<string, string>` | Route parameters, e.g. `{ id: "1" }` for `api/users/[id].get.ts` |
| `headers` | `Dict<string \| string[]>` | Raw header object |
| `cookie` | `Record<string, string>` | Parsed cookies, lazily |
| `cookies` | `Record<string, string>` | Alias of `cookie` |
| `body` | `any` | The parsed body. Writable |
| `ip` | `string \| undefined` | First `x-forwarded-for` entry, else the socket address |

## Methods

### `header(name)`

```ts
header(name: string): string | undefined
```

Case-insensitive lookup. Returns the first value when a header repeats.

```ts
const ua = req.header("User-Agent")
```

### `readBody()`

```ts
readBody(): Promise<unknown>
```

Reads and parses the body if it has not been consumed yet. The pipeline already
calls this before handlers run, so `req.body` is normally ready synchronously —
you need `readBody()` only in code that may run before the pipeline has.

Repeated calls return the same value.

### `rawBody()`

```ts
rawBody(): Promise<Buffer>
```

Reads the untouched body bytes.

::: warning
Only valid if the body was not already parsed — a request stream can be
consumed once. Use `.meta({ json: false })` on routes that need raw bytes.
:::

## Notes on `query` vs `url`

`query` collapses repeated keys to their first value. For the full set, use the
`URL` instance:

```ts
req.query.tag                    // "a"
req.url.searchParams.getAll("tag")   // ["a", "b"]
```

## Body size

Bodies larger than the configured limit are rejected. Set it with the
[`bodyLimit`](/reference/configuration) option.

## Assigning a parsed body

`body` has a setter, which marks the body as read. This is how a validation
middleware hands a coerced value to the handler:

```ts
export default middleware(async ({ req, handler }) => {
  req.body = schema.parse(req.body)
  return handler.execute()
})
```
