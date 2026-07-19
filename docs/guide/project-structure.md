# Project structure

TypeScript projects keep sources under `src/`; JavaScript projects put the same
directories at the project root. Both layouts are detected automatically — you
never configure which one you are using.

```
src/
  api/          route handlers      -> HTTP endpoints
  ws/           socket handlers     -> WebSocket endpoints
  di/           injectable values
  services/     injectable services
  middlewares/  request middlewares
  main.ts       bootstrap()
.clove/         generated types (gitignored)
```

## The directories

| Directory | Contains | Becomes |
| --- | --- | --- |
| `api/` | Modules whose default export is `get()`, `post()`, … | HTTP routes, path mirroring the file path |
| `ws/` | Modules whose default export is `ws()` | WebSocket endpoints under `/ws/…` |
| `services/` | Modules whose default export is `service()` | `ctx.<filename>`, a singleton created at boot |
| `di/` | Modules whose default export is `di()` | `ctx.<filename>`, scoped per its declared lifetime |
| `middlewares/` | Modules whose default export is `middleware()` | Wrappers around every route, run in [order](/guide/middlewares#ordering) |

Files anywhere else are ignored by the scanner — put helpers, types and
constants wherever you like.

## Naming is the API

A file's **name** determines its key on `ctx`, and a route file's **path**
determines its URL. `services/auth.ts` becomes `ctx.auth`; `api/v1/login.post.ts`
becomes `POST /api/v1/login`.

This means renaming a file is a breaking change to your own code — which is the
point. There is exactly one place a name is declared.

## `.clove/`

`clove dev`, `clove build` and `clove types` write `.clove/types.d.ts`, which
augments the `Ctx` interface with one entry per file in `services/` and `di/`.
The scaffolded `tsconfig.json` includes it, and the scaffolded `.gitignore`
excludes it — it is a build artefact, regenerated from the filesystem. See
[Typed context](/guide/typed-context).

## `main.ts`

The entry point. In the default layout it does one thing:

```ts
import { bootstrap } from "clovejs"

bootstrap()
```

Everything else is discovered. See [Bootstrap](/guide/bootstrap) for the
options it accepts, and [Express interop](/guide/express-interop) if Clove is
not going to own the process.

## JavaScript layout

Identical, minus `src/` and `tsconfig.json`:

```
api/
ws/
di/
services/
middlewares/
main.js
```

Run `clove scaffold --js` to create it.
