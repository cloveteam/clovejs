# Getting started

## Prerequisites

Node.js **20 or newer**. Check with `node -v`.

## Install

::: code-group

```bash [npm]
npm i clovejs
```

```bash [pnpm]
pnpm add clovejs
```

```bash [yarn]
yarn add clovejs
```

:::

## Scaffold the project

```bash
npx clove scaffold          # TypeScript layout
npx clove scaffold --js     # JavaScript layout
```

Scaffolding is an explicit command rather than an install-time prompt: package
managers suppress or sandbox `postinstall`, and prompts break CI.

It never overwrites an existing file — anything already present is reported as
`skipped`. Pass `--force` to overwrite deliberately.

The command creates the directory structure, a few starter files, a
`tsconfig.json` (TypeScript only), a `.gitignore`, and adds `dev`, `build` and
`start` scripts to your `package.json`:

```
src/
  api/
    hello.get.ts
  ws/
  di/
    config.ts
  services/
    greeter.ts
  middlewares/
  main.ts
tsconfig.json
.gitignore
```

## Run it

```bash
npm run dev
```

`clove dev` watches the source directory, regenerates `.clove/types.d.ts` and
reloads on change. Visit `http://localhost:3000/api/hello`:

```json
{ "message": "Hello from CloveJS" }
```

## Add a route

Create `src/api/v1/greet/[name].get.ts`:

```ts
import { get } from "clovejs"

export default get(async (req, res, ctx) => {
  return { message: ctx.greeter.greet(req.params.name) }
})
```

`GET /api/v1/greet/ada` responds with `{"message":"Hello, ada!"}`. Nothing was
registered — the file's path became the route, and `ctx.greeter` came from
`src/services/greeter.ts`.

## Add a service

Services are singletons created once at boot. Create `src/services/users.ts`:

```ts
import { service } from "clovejs"

export default service(async (ctx) => {
  const users = new Map<number, { id: number; name: string }>([
    [1, { id: 1, name: "Ada" }],
  ])

  return {
    findById(id: number) {
      return users.get(id) ?? null
    },
  }
})
```

`ctx.users` is now available — and typed — in every handler, middleware and
other service. Returning `null` from a `GET` handler produces a `404`; see
[the JSON middleware](/guide/json-middleware).

## Build for production

```bash
npm run build      # clove build: generate types, then tsc
npm start          # node dist/main.js
```

## Where to go next

| If you want to… | Read |
| --- | --- |
| Understand the directory conventions | [Project structure](/guide/project-structure) |
| Map URLs onto files | [Routes](/guide/routes) and [Route parameters](/guide/route-parameters) |
| Share database clients and config | [Values and lifetimes](/guide/dependency-injection) |
| Run code around every request | [Middlewares](/guide/middlewares) |
| Add realtime endpoints | [WebSockets](/guide/websockets) |
| Deploy the app | [Deployment](/guide/deployment) |
