# CLI

```
clove — CloveJS project commands

  clove dev [--port <n>] [--host <h>]   Run the dev server with file watching
  clove build                           Generate types and compile with tsc
  clove types                           Generate .clove/types.d.ts only
  clove scaffold [--js] [--force]       Create the default project structure
  clove routes                          Print the resolved route table

Options:
  --dir <path>   Project root (defaults to the current directory)
  --help         Show this message
```

Run it via `npx clove <command>`, or through the `dev` / `build` / `start`
scripts that `clove scaffold` adds to `package.json`.

## `clove dev`

Runs the app with file watching and type generation. Changes under the source
directory regenerate `.clove/types.d.ts` and reload the server.

```bash
npx clove dev --port 8080 --host 0.0.0.0
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--port <n>` | `3000` | Port to listen on |
| `--host <h>` | `localhost` | Interface to bind |
| `--dir <path>` | cwd | Project root |

Module caching is disabled in dev so a reload actually re-reads changed files.
`SIGINT`/`SIGTERM` shut the server down cleanly.

## `clove build`

1. Regenerates `.clove/types.d.ts`.
2. Runs `npx tsc` in the project root.

If there is no `tsconfig.json`, step 2 is skipped and the command reports that
there was nothing to compile — the correct behaviour for a JavaScript project.

When `tsc` reports errors, they are printed as-is and the process exits
non-zero. No stack trace is added on top, so CI logs stay readable.

## `clove types`

Regenerates `.clove/types.d.ts` only, and makes sure `.clove/` is in the
project's `.gitignore`. Prints the path it wrote.

Use it in CI before type-checking, or after a fresh clone where `.clove/` does
not exist yet:

```bash
npx clove types && npx tsc --noEmit
```

Generation is a path-level scan — files are never executed — so it is fast and
cannot be broken by a module that throws at import time.

## `clove scaffold`

Creates the default project structure.

| Flag | Meaning |
| --- | --- |
| `--js` | JavaScript layout: directories at the project root, no `tsconfig.json` |
| `--force` | Overwrite files that already exist |

Without `--force`, existing files are left alone and reported as `skipped`, so
the command is safe to run inside a project that is already partly set up.

It creates `api/`, `ws/`, `di/`, `services/` and `middlewares/`, a starter
route, service and config file, `main.ts`, a `.gitignore`, a `tsconfig.json`
(TypeScript only), and adds `type: "module"` plus `dev`/`build`/`start` scripts
to `package.json` without clobbering scripts you already have.

::: info Why not an install prompt?
Scaffolding is an explicit command rather than an install-time prompt: package
managers suppress or sandbox `postinstall`, and prompts break CI.
:::

## `clove routes`

Prints the resolved route table — method and path, one per line:

```
GET     /api/v1/users
GET     /api/v1/users/:id
POST    /api/v1/login
```

The fastest way to confirm that a filename produced the URL you expected. It
boots the app with logging silenced, so convention violations still surface as
[boot errors](/guide/errors#boot-errors).

## `--dir`

Every command accepts `--dir <path>` to operate on a project other than the
current directory:

```bash
npx clove routes --dir ./services/api
```
