# Configuration

There is no config file. Options are passed to `bootstrap()`, `engine()` or
`createApp()`, and a few have environment fallbacks.

## `AppOptions`

Accepted by `createApp()` and `engine()`, and inherited by `bootstrap()`.

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `rootDir` | `string` | `process.cwd()` | Project root |
| `sourceDir` | `string` | auto-detected | Overrides the `src/` vs project-root detection |
| `logLevel` | `LogLevel` | `debug` in dev, `info` otherwise | Console log threshold |
| `bodyLimit` | `number` | — | Maximum request body size, in bytes |
| `sessionSecret` | `string` | `CLOVE_SECRET` env | Key used to sign the session cookie |
| `sessionTtl` | `number` | 24 hours | Session idle lifetime, in milliseconds |
| `exposeErrors` | `boolean` | dev only | Include error messages and stacks in `500` responses |
| `moduleCache` | `boolean` | `true` | Cache evaluated modules. `clove dev` sets it `false` so reloads re-read files |

## `BootstrapOptions`

Everything in `AppOptions`, plus:

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `port` | `number` | `PORT` env, else `3000` | Port to listen on. `0` picks a free one |
| `host` | `string` | `HOST` env, else `localhost` | Interface to bind |
| `handleSignals` | `boolean` | `true` | Register `SIGINT`/`SIGTERM` handlers for graceful shutdown |

```ts
import { bootstrap } from "clovejs"

await bootstrap({
  port: 8080,
  host: "0.0.0.0",
  logLevel: "info",
  sessionTtl: 60 * 60 * 1000,
})
```

## Environment variables

| Variable | Used for |
| --- | --- |
| `PORT` | Default port for `bootstrap()` |
| `HOST` | Default bind address for `bootstrap()` |
| `CLOVE_SECRET` | Session cookie signing key |
| `NODE_ENV` | Selects dev vs production defaults for `logLevel` and `exposeErrors` |

Explicit options always win over the environment.

## Log levels

`LogLevel` is one of:

```
"debug" | "info" | "warn" | "error" | "silent"
```

`"silent"` suppresses everything, which is what `clove routes` and most test
setups use.

To replace the logger entirely rather than tune its level, define
`services/logger.ts`; it takes over `ctx.logger` and the framework's own
messages.

## Source directory detection

Clove looks for `src/` and falls back to the project root. Set `sourceDir`
only when your layout is unusual:

```ts
await bootstrap({ sourceDir: "./app" })
```

## Session configuration

Sessions activate on their own as soon as any `di/` file declares
`lifetime: "session"`. The only knobs are `sessionSecret` and `sessionTtl`
above, plus the store — which is a
[service file](/guide/sessions#custom-stores), not an option.
