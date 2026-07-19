---
layout: home

hero:
  name: CloveJS
  text: Files in, routes out.
  tagline: A convention-driven Node.js HTTP framework. Routes, services, middlewares and injectables are discovered from the filesystem — there is nothing to register.
  image:
    src: /logo.svg
    alt: CloveJS
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: What is CloveJS?
      link: /guide/what-is-clovejs
    - theme: alt
      text: View on GitHub
      link: https://github.com/lexkrstn/clovejs

features:
  - icon: 🗂️
    title: Nothing to wire up
    details: Drop a file into api/, ws/, services/, di/ or middlewares/ and it is live. No decorators, no module graph, no registration calls.
    link: /guide/project-structure
    linkText: Project structure
  - icon: 🧩
    title: DI in the box
    details: Singleton, session and request lifetime scopes, resolved for you. Singletons are ready before the first request lands.
    link: /guide/dependency-injection
    linkText: Lifetimes
  - icon: 🔤
    title: TypeScript from the box
    details: ctx is fully typed from generated declarations — one entry per file in services/ and di/, written by a path-level scan that never executes your code.
    link: /guide/typed-context
    linkText: Typed context
  - icon: 🔌
    title: WebSockets included
    details: Files in ws/ map to socket endpoints exactly like routes do, [param] segments and per-connection containers included.
    link: /guide/websockets
    linkText: WebSockets
  - icon: 🤝
    title: Drops into Express
    details: Mount Clove alongside an app you already have. Unmatched requests fall straight through to the host's own stack.
    link: /guide/express-interop
    linkText: Express interop
  - icon: ⚡
    title: Fast feedback loop
    details: clove dev watches files, regenerates types and reloads. Boot-time convention violations name the exact file to fix.
    link: /reference/cli
    linkText: CLI reference
---

## Sixty seconds to a running API

```bash
npm i clovejs
npx clove scaffold      # create the default project structure
npm run dev
```

Create `src/api/v1/users/[id].get.ts`:

```ts
import { get } from "clovejs"

export default get(async (req, res, ctx) => {
  return ctx.users.findById(Number(req.params.id))
})
```

`GET /api/v1/users/1` now returns JSON. No router file was edited, and `ctx.users`
is typed because a file exists at `src/services/users.ts`.

Ready for the details? Start with [Getting started](/guide/getting-started).
