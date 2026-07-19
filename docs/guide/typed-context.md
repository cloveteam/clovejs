# Typed context

`clove dev` and `clove build` write `.clove/types.d.ts`, which augments the
`Ctx` interface with one entry per file in `services/` and `di/`. The
scaffolded `tsconfig.json` already includes it, so `ctx.auth.login()` is typed
with no manual declaration.

```ts
// src/services/auth.ts — you write this
export default service(async (ctx) => ({
  async login(params: LoginParams) { /* … */ },
}))
```

```ts
// .clove/types.d.ts — generated
declare module "clovejs" {
  interface Ctx {
    auth: CloveService<typeof import("../src/services/auth.js").default>
  }
}
```

```ts
// src/api/v1/login.post.ts — this is typed, and so is the return value
const { user, token } = await ctx.auth.login({ username, password })
```

## How generation works

Generation is a **path-level scan** — files are never executed — so it stays
fast and cannot be broken by a module that throws at import time. The generator
reads filenames, emits a `typeof import(...)` reference for each, and lets
TypeScript do the actual inference.

The consequence worth knowing: types come from your source, not from a runtime
value, so they are exactly as good as the annotations in your service and `di/`
files. A service returning an inferred object literal is fully typed; one
returning `any` is not.

## When to regenerate

| Situation | What to run |
| --- | --- |
| Working locally | Nothing — `clove dev` regenerates on every change |
| CI or a fresh clone | `clove build`, or `clove types` alone |
| Editor shows a stale `ctx` | `npx clove types`, then restart the TS server |

`.clove/` is a build artefact. Commit nothing from it — the scaffolded
`.gitignore` already excludes it, and `clove types` re-adds the entry if it
goes missing.

## Wiring it into an existing tsconfig

If you did not scaffold, include the generated files:

```json
{
  "include": ["src", ".clove/**/*"]
}
```

The glob matters: TypeScript's include wildcards never descend into
directories whose name starts with a dot, so a bare `".clove"` entry (and the
default `**/*`) silently matches nothing — the augmentation is dropped and
every `ctx` property falls back to `any`. `clove dev`, `clove build` and
`clove types` warn when they detect a tsconfig with this problem.

## The helper types

The generated file uses two exported helpers, which you can also use directly:

| Type | Extracts |
| --- | --- |
| `CloveService<T>` | The awaited value a `service(...)` definition resolves to |
| `CloveDi<T>` | The value a `di(...)` definition resolves to, whether plain or from a factory |

## Augmenting `Ctx` by hand

Generation is additive to a normal module augmentation, so anything you attach
to `ctx` outside the conventions can be declared yourself:

```ts
// src/types/clove.d.ts
declare module "clovejs" {
  interface Ctx {
    requestId: string
  }
}

export {}
```

The same trick types your own [route metadata](/guide/route-metadata#typing-your-own-metadata).

## JavaScript projects

Type generation still runs and still produces `.clove/types.d.ts`. With
`checkJs` enabled, or with an editor that reads declaration files for JS, you
get the same `ctx` completions without adopting TypeScript.
