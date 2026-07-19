# Deployment

## Build

```bash
npm run build      # clove build
```

`clove build` regenerates `.clove/types.d.ts` and then compiles with `tsc`. If
the project has no `tsconfig.json`, it stops after generating types — a
JavaScript project has nothing to compile.

Compiler errors are reported by `tsc` and the command exits non-zero, so a
broken build fails CI rather than shipping.

## Run

```bash
node dist/main.js
```

The scaffolded `package.json` wires this up as `npm start`.

## Environment

| Variable | Effect |
| --- | --- |
| `NODE_ENV=production` | Turns off stack traces in `500` bodies; raises the default log level |
| `PORT` | Default listening port |
| `HOST` | Default bind address — set `0.0.0.0` in a container |
| `CLOVE_SECRET` | Session cookie signing key. **Required in production** if you use sessions |

```bash
CLOVE_SECRET="$(openssl rand -hex 32)"
```

Without it, the key is ephemeral and every restart invalidates every session.
The framework warns about this at boot; see [Sessions](/guide/sessions#the-signing-secret).

## Docker

```dockerfile
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/main.js"]
```

`.clove/` is not copied into the runtime image — it is a type-checking artefact
with no runtime role.

## Graceful shutdown

`bootstrap()` registers `SIGINT` and `SIGTERM` handlers by default: the server
stops accepting connections, sockets close, and every `onDestroy` hook runs
before the process exits. That is what orchestrators send on a rolling deploy,
so no extra work is needed.

If the surrounding process manager owns the lifecycle, turn the handlers off
and call `close()` yourself — see [Bootstrap](/guide/bootstrap#graceful-shutdown).

## Health checks

There is no built-in health endpoint. One file is enough:

```ts
// src/api/health.get.ts
import { get } from "clovejs"

export default get(async () => ({ status: "ok" }))
```

Because all singletons resolve before the server listens, a successful bind
already implies the database client and every other singleton initialised —
a liveness probe on this route is meaningful without extra checks.

## Scaling out

The default session store is in-process. Before running more than one instance,
provide a shared store as `services/sessionStore.ts` — see
[custom stores](/guide/sessions#custom-stores).

WebSocket connections are pinned to the instance that accepted them. Behind a
load balancer, enable sticky sessions or fan out through an external broker.

## Logging

`ctx.logger` writes to the console at a level derived from the environment.
Override the level explicitly:

```ts
bootstrap({ logLevel: "warn" })
```

To ship structured logs, define your own `services/logger.ts` — it replaces the
built-in logger everywhere, including the framework's own boot and error
messages.
