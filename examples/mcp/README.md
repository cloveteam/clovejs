# CloveJS — MCP example

A Model Context Protocol server built the same way as an HTTP app: files under
`src/mcp/` become tools, resources and prompts, and they share `ctx` with the
rest of the project.

The notes service and the `currentUser` DI value here are the same ones the
[`../rest`](../rest) example uses over HTTP — that's the point of this example.
[`../websocket`](../websocket) covers real-time connections.

## Run it

From the repository root (this example is an npm workspace, so one install
covers it):

```bash
npm install
npm run dev -w clovejs-example-mcp
```

Or from this directory once the root install has run:

```bash
cd examples/mcp
npm run dev
```

The server is served at `http://localhost:3000/mcp`. List what it exposes:

```bash
npm run mcp -w clovejs-example-mcp
```

```
Endpoint  /mcp

tool      createNote               Create a note
tool      login                    Sign in for the rest of this MCP session (try ada / secret)
tool      searchNotes              Full-text search across the notes, by title or body
tool      whoami                   Report who is signed in on this MCP session
resource  config://app             What this server is and how much is in it
resource  notes://{id}             A single note, as markdown
prompt    summarize                Summarize a note in three bullets
```

Point an MCP client at it:

```json
{
  "mcpServers": {
    "clove-example": { "url": "http://localhost:3000/mcp" }
  }
}
```

## What to look at

| File | Demonstrates |
| --- | --- |
| [`src/mcp/tools/searchNotes.ts`](./src/mcp/tools/searchNotes.ts) | A tool: zod input, typed handler, `.meta()` annotations |
| [`src/mcp/tools/createNote.ts`](./src/mcp/tools/createNote.ts) | A writing tool, sharing the singleton behind `GET /api/notes` |
| [`src/mcp/tools/login.ts`](./src/mcp/tools/login.ts), [`src/mcp/tools/whoami.ts`](./src/mcp/tools/whoami.ts) | Session-scoped DI across MCP calls; a `4xx` as a readable tool failure |
| [`src/mcp/resources/notes/[id].ts`](./src/mcp/resources/notes/%5Bid%5D.ts) | A resource template, `notes://{id}` |
| [`src/mcp/resources/config/app.ts`](./src/mcp/resources/config/app.ts) | A static resource URI, `config://app` |
| [`src/mcp/prompts/summarize.ts`](./src/mcp/prompts/summarize.ts) | A prompt — a template the user picks, not one the model calls |
| [`src/api/notes.get.ts`](./src/api/notes.get.ts) | A plain HTTP route reading the same service |

## MCP and HTTP share everything underneath

`ctx.notes` is one singleton, so a note created with the `createNote` tool
shows up immediately at `GET /api/notes`:

```bash
# With an MCP client connected, call createNote — then:
curl localhost:3000/api/notes
```

And `ctx.currentUser` is session-scoped, so calling `login` gives that MCP
connection an identity that `whoami` still sees on the next call — the same
`di/currentUser.ts` that backs the `clove.sid` cookie for browsers. Over HTTP a
session is one browser; over MCP it's one client connection, identified by its
`Mcp-Session-Id`.

Full explanations live in the [guide](https://cloveteam.github.io/clovejs/).
