# What is CloveJS?

CloveJS is a Node.js HTTP framework built on one idea: **the filesystem is the
configuration**. Routes, WebSocket endpoints, services, injectable values and
middlewares are discovered by scanning directories. There is no registration
step, no module graph to declare, and no decorators.

```ts
// src/api/v1/users/[id].get.ts
import { get } from "clovejs"

export default get(async (req, res, ctx) => {
  return ctx.users.findById(Number(req.params.id))
})
```

That file *is* the route `GET /api/v1/users/:id`. The `ctx.users` service exists
because `src/services/users.ts` exists, and it is typed because `clove dev`
regenerates a declaration file whenever the directory changes.

## Design principles

**Convention over configuration, enforced at boot.** Conventions only help if
they are reliable. If a filename and its handler wrapper disagree — say
`login.post.ts` exporting `get(...)` — the project refuses to start and names
the file to fix. You never debug a route that silently did not register.

**DI without ceremony.** Dependencies are plain files that export a value or a
factory. Each declares a [lifetime](/guide/dependency-injection) —
`singleton`, `session` or `request` — and the container handles the rest.
Singletons are fully resolved before the server accepts traffic, so reading
`ctx.db` inside a handler is synchronous and safe.

**Types you did not write.** `clove types` performs a *path-level* scan: it
reads filenames, never executes modules. That keeps generation fast and means a
module that throws at import time cannot break your editor.

**Escape hatches everywhere.** The JSON middleware steps aside the moment you
set a non-JSON content type. `res.raw` is the untouched Node
`ServerResponse`. And the whole framework can be mounted
[inside an existing Express app](/guide/express-interop) rather than owning the
process.

## What it is not

CloveJS does not ship an ORM, a validation library, a template engine, or an
auth system. It gives you routing, a DI container, a middleware pipeline,
sessions and WebSockets — and gets out of the way for everything else.

## Requirements

- **Node.js 20 or newer**
- TypeScript is optional. A JavaScript project uses the same conventions with
  the directories at the project root instead of under `src/`.

## Next

- [Getting started](/guide/getting-started) — install and run
- [Project structure](/guide/project-structure) — what each directory means
