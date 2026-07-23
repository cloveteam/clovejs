# HTML templates

Clove renders HTML the same way it renders JSON: a handler **returns a value**,
and the pipeline writes the response. The value is `view(name, data)`, and it is
rendered by a template engine you register — Clove ships none of its own, so you
bring Eta, EJS, Handlebars, Nunjucks, or a handful of lines of your own.

```ts
// web/notes/[id].get.ts  ->  GET /notes/:id
import { get, view } from "clovejs"

export default get(async (req, _res, ctx) => {
  const note = ctx.notes.findById(Number(req.params.id))
  if (note === null) return null            // still a 404, via the JSON rule
  return view("notes/detail", { note })     // rendered as HTML
})
```

Pages usually live in [`web/`](/guide/routes#web-pages-at-the-root), which
mounts at the root `/` rather than under `/api` — but `view()` works from any
route, `api/` included.

Because the handler returns a plain, inspectable value and never touches `res`,
it stays a pure function of its inputs — a unit test asserts on the returned
`view(...)` without a live server or a rendered string.

## Registering an engine

Add `views.ts` at your source root — one per project, like `mcp/auth.ts`. Its
default export wraps your engine in a single `render` seam:

```ts
// src/views.ts
import { views } from "clovejs"
import { Eta } from "eta"                    // your dependency, not Clove's

const eta = new Eta({ views: "src/views", cache: process.env.NODE_ENV === "production" })

export default views({
  render(template, data, ctx) {
    // `ctx` is the request context — fold in globals here.
    return eta.render(template, { ...(data as object), user: ctx.currentUser })
  },
})
```

`render` receives the template name a handler passed to `view()`, its data, and
`ctx`. It owns everything engine-specific — template resolution, partials,
layouts, helpers, and caching — and may return a `string` or a `Buffer`, sync or
async. That is the entire contract:

```ts
interface ViewEngine {
  /** Default Content-Type. A `res.type()` shorthand or full MIME. Defaults to "html". */
  contentType?: string
  render(template: string, data: unknown, ctx: Ctx): string | Buffer | Promise<string | Buffer>
}
```

No template library at all? Any function that turns a name and data into a
string qualifies:

```ts
import { views } from "clovejs"

const templates = {
  greeting: (d: { name: string }) => `<h1>Hello, ${d.name}!</h1>`,
}

export default views({
  render: (name, data) => templates[name as keyof typeof templates](data as never),
})
```

## What the pipeline does

A returned `view(...)` is recognised **before** JSON handling. The engine
renders it, the result is written with `Content-Type: text/html` (unless the
engine's `contentType` or the handler set another), and the response ends. A
render that throws — a missing template, a bad partial — surfaces through the
normal [error path](/guide/errors) as a `500`, with the message shown in dev
when [`exposeErrors`](/reference/configuration) is on.

Returning `view(...)` when no `views.ts` is registered is a `500` with a message
telling you to add one.

## Setting a status or headers

Reach for `res` as you would around the JSON middleware — the returned view is
still what gets rendered:

```ts
export default post(async (req, res, ctx) => {
  const note = await ctx.notes.create(req.body)
  res.status(201).header("x-note-id", String(note.id))
  return view("notes/detail", { note })
})
```

## Layouts, partials, and globals

These are the engine's job, which is what keeps Clove dependency-free. Wire
layouts and partials through your engine's own configuration in `views.ts`, and
inject per-request globals — the current user, a CSRF token, the app name — by
reading them off `ctx` inside `render`.
