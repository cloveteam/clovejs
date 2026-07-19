# MCP servers

Files in `mcp/` turn your project into a [Model Context
Protocol](https://modelcontextprotocol.io) server, so an AI assistant can call
into it. The conventions are the ones you already know: drop a file in a
directory and it is live, `[param]` segments work, and `ctx` carries the same
services your HTTP routes use.

```
src/
  mcp/
    tools/        actions a model can invoke
    resources/    data a client can read by URI
    prompts/      reusable message templates
```

## Setup

The MCP SDK and zod are optional peer dependencies — projects without an `mcp/`
directory never load them. Install them when you add your first tool:

```bash
npm install @modelcontextprotocol/sdk zod
```

That is the whole setup. `bootstrap()` detects `mcp/` and serves the endpoint at
`/mcp` alongside your routes.

## Tools

A tool is an action the **model** decides to call. The default export of
`mcp/tools/searchNotes.ts` becomes the tool `searchNotes`:

```ts
import { tool } from "clovejs/mcp"
import { z } from "zod"

export default tool({
  description: "Full-text search across the user's notes",
  input: z.object({
    query: z.string().describe("Search query"),
    limit: z.number().int().max(50).default(10),
  }),
  async handler({ query, limit }, ctx) {
    return ctx.notes.search(query, { limit })
  },
})
```

The `input` schema does three jobs at once: it is published to the client as
JSON Schema, it validates and applies defaults before your handler runs, and it
types the handler's first argument — `query` is a `string` and `limit` is a
`number` with no annotation from you.

`description` is the single most important field. It is what the model reads
when deciding whether this tool is the right one, so write it for the model.

### Return values

Whatever you return is serialised for you, exactly like the [JSON
middleware](./json-middleware) does for routes:

| Handler returns | The client receives |
| --- | --- |
| a string | one text block |
| an object or array | one text block of JSON |
| `undefined` or `null` | no content |
| a content block, or an array of them | those blocks, untouched |

To control the blocks yourself, return them directly:

```ts
return [
  { type: "text", text: "Here is the chart:" },
  { type: "image", data: png.toString("base64"), mimeType: "image/png" },
]
```

### Annotations

`.meta()` works as it does on routes. The four known keys become MCP
annotations, which clients use to decide what needs confirmation:

```ts
export default tool({
  description: "Delete a note",
  input: z.object({ id: z.string() }),
  async handler({ id }, ctx) {
    await ctx.notes.remove(id)
  },
}).meta({
  destructive: true,
  idempotent: true,
})
```

| Key | Meaning |
| --- | --- |
| `readOnly` | The tool does not modify anything |
| `destructive` | The tool may perform irreversible updates |
| `idempotent` | Calling it twice with the same input has no extra effect |
| `openWorld` | The tool touches systems outside this server |

These are **advisory**. A client is free to ignore them, so enforce anything
that matters inside the handler.

## Resources

A resource is data the **client** reads by URI. The URI comes from the file
path: the first directory segment becomes the scheme, the rest becomes the
path, and `[param]` segments become `{param}` template variables.

`mcp/resources/notes/[id].ts` serves `notes://{id}`:

```ts
import { resource, error } from "clovejs/mcp"

export default resource({
  description: "A single note by id",
  mimeType: "text/markdown",
  async handler({ id }, ctx) {
    const note = await ctx.notes.findById(id)
    if (!note) throw error(404, { message: "No such note" })
    return note.markdown
  },
})
```

| File | URI |
| --- | --- |
| `mcp/resources/config/app.ts` | `config://app` |
| `mcp/resources/notes/[id].ts` | `notes://{id}` |
| `mcp/resources/db/users/[id]/tags.ts` | `db://users/{id}/tags` |
| `mcp/resources/config.ts` | `config://` |

Pass `uri` in the definition when you want something the file path cannot
express. Returning a `Buffer` or `Uint8Array` sends a base64 blob instead of
text.

## Prompts

A prompt is a template the **user** picks explicitly, rather than something the
model chooses. `mcp/prompts/summarize.ts` becomes the prompt `summarize`:

```ts
import { prompt } from "clovejs/mcp"
import { z } from "zod"

export default prompt({
  description: "Summarize a note",
  input: z.object({ noteId: z.string() }),
  async handler({ noteId }, ctx) {
    const note = await ctx.notes.findById(noteId)
    return `Summarize the following note in 3 bullets:\n\n${note.markdown}`
  },
})
```

Return a string for a single user message, or an array of
`{ role, content }` objects for a conversation. Prompt arguments must be
`z.string()` — the protocol transports them as strings, and the project refuses
to boot if you declare anything else.

## Naming

Tool and prompt names come from the filename, with nested files flattening in
camelCase — the same rule `services/` and `di/` use for `ctx` keys:

| File | Name |
| --- | --- |
| `mcp/tools/searchNotes.ts` | `searchNotes` |
| `mcp/tools/notes/search.ts` | `notesSearch` |
| `mcp/tools/notes/index.ts` | `notes` |

Set `name` in the definition to override it. Two files claiming the same name,
or the same resource URI, is a boot error naming both files.

## Dependency injection

Handlers receive `ctx` as their second argument, fully typed by the generated
`.clove/types.d.ts` — the same context your routes and WebSocket handlers get.
Services are shared, so a tool and a route calling `ctx.notes` talk to one
instance.

The three [lifetimes](./dependency-injection) map onto MCP like this:

| Lifetime | Scope in an MCP server |
| --- | --- |
| `singleton` | The whole process, as always |
| `session` | One MCP session — a client's connection, identified by `Mcp-Session-Id` |
| `request` | One tool call, resource read or prompt render |

Session scope is what makes stateful tools work. Declare a session value and it
persists across calls from the same client, and starts fresh for the next one:

```ts
// di/currentUser.ts
export default di({ lifetime: "session", value: null as User | null })
```

```ts
// mcp/tools/login.ts
export default tool({
  description: "Authenticate for this session",
  input: z.object({ token: z.string() }),
  async handler({ token }, ctx) {
    ctx.currentUser = await ctx.auth.verify(token)
    return `Signed in as ${ctx.currentUser.name}`
  },
})
```

Sessions are backed by the same store as HTTP sessions, so a custom
`services/sessionStore.ts` covers both. See [Sessions](./sessions).

## The third handler argument

After `input` and `ctx` comes a bag of per-call extras:

```ts
async handler(input, ctx, { sessionId, signal, log }) {
  log("info", "starting the slow part")
  const rows = await ctx.db.query(sql, { signal })
  return rows
}
```

| Field | What it is |
| --- | --- |
| `sessionId` | The MCP session id, or `null` over stdio |
| `signal` | Aborts when the client cancels the call or disconnects |
| `log(level, message)` | Sends a log message to the client |
| `uri` | Resources only: the fully resolved URI that was requested |

## Errors

`error(status, body)` behaves the way it does in a route, with the status
deciding who is told what:

```ts
throw error(404, { message: "No such note" })
```

A **4xx is the model's problem** — bad arguments, a missing record — so the
message is passed through verbatim as a failed tool result. The model reads it
and can correct itself, which is usually what you want.

Anything else is **your** problem. It is logged in full on the server, and the
client is told only that an internal error occurred, so stack traces and
internal detail do not leak into a model's context. Outside production the
message is included, matching `exposeErrors` for HTTP.

Resources and prompts have no way to carry a failure in their result, so for
those every error becomes a protocol error — with the same split over which
message the client sees.

## Middlewares do not run

HTTP middlewares wrap routes, not MCP calls: there is no `req`/`res` pair to
give them, exactly as with [WebSocket](./websockets) upgrades. Authenticate and
authorize inside the handler using `ctx`, or put shared logic in a service both
call.

## Inspecting the surface

`clove mcp` prints everything the server exposes, the analogue of `clove
routes`:

```bash
$ npx clove mcp
Endpoint  /mcp

tool      searchNotes              Full-text search across the user's notes
tool      createNote               Create a new note
resource  notes://{id}             A single note by id
resource  config://app             Server configuration
prompt    summarize                Summarize a note
```

## Connecting a client

### Over HTTP

The endpoint is Streamable HTTP at `/mcp`. In an editor's MCP configuration:

```json
{
  "mcpServers": {
    "my-app": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

Change the path with `bootstrap({ mcpPath: "/agent" })`.

### Over stdio

Clients that launch a server as a subprocess want stdio instead. `clove mcp
--stdio` serves the same project that way:

```json
{
  "mcpServers": {
    "my-app": {
      "command": "npx",
      "args": ["clove", "mcp", "--stdio"],
      "cwd": "/path/to/project"
    }
  }
}
```

Over stdio there is one client and no session ids, so `sessionId` is `null` and
session-scoped values live as long as the process.

::: tip
In stdio mode stdout **is** the protocol stream, and `console.log`, `.info` and
`.debug` all write to it. `clove mcp --stdio` redirects those to stderr before
your project boots, so ordinary logging — yours or `ctx.logger`'s — cannot
corrupt the transport. Writing to `process.stdout` directly still will.
:::
