# Changelog

## Unreleased

- **Route caching.** `GET` and `HEAD` definitions support `.cache(...)` with
  deterministic keys, `Vary`, stale follower serving, concurrent-miss
  coalescing, ETags and conditional `304` responses. Mutation routes can
  declare `.invalidates(...)`, and `ctx.cache.invalidate(...)` provides the
  imperative escape hatch. Middleware remains a complete interceptor chain on
  hits because Clove caches only the terminal handler outcome.
- `MemoryCacheStore` is the single-process default;
  `services/cacheStore.ts` can provide a distributed adapter.
- **MCP servers.** Files in `mcp/tools/`, `mcp/resources/` and `mcp/prompts/`
  expose the project over the Model Context Protocol, served at `/mcp`
  alongside routes. Definitions come from `clovejs/mcp`; resource URIs derive
  from the file path with `[param]` segments becoming `{param}` template
  variables. `session`-scoped `di` values are scoped to one MCP session, and
  `request`-scoped ones to a single call.
- `@modelcontextprotocol/sdk` and `zod` are **optional** peer dependencies —
  a project with no `mcp/` directory never loads them.
- `clove mcp` prints the resolved tools, resources and prompts; `clove mcp
  --stdio` serves the project over stdio for clients that launch a server as a
  subprocess.
- `clove routes` and the dev-server banner now list the MCP endpoint.
- `bootstrap()` accepts `mcpPath` and `mcpServerInfo`.

### Fixed

- **`clove dev` no longer misses a file saved just after startup.** A recursive
  filesystem watch can report itself ready before the OS is actually delivering
  events, so a save in that window reached no listener at all — no error, no
  retry, and no reload until something else changed. The dev server now
  snapshots the source tree before it reads it and re-checks a few times over
  the first couple of seconds, reloading if the two have drifted apart.
- A burst of saves — a branch switch, a formatter run — now triggers one
  rebuild rather than one per file.
- `close()` waits for a rebuild already in flight, instead of leaving behind an
  application whose singletons are never disposed.
- Watcher errors are reported rather than swallowed.

## 0.1.0

Initial release.

- Filesystem-driven routing from `api/`, with `[param]` segments in both file
  and directory form, and boot-time validation that filenames match their
  handler wrappers.
- WebSocket endpoints from `ws/`, with per-connection request scopes.
- Dependency injection from `services/` and `di/`, with `singleton`, `session`
  and `request` lifetimes and `onDestroy` teardown hooks.
- Middleware pipeline from `middlewares/`, with numeric-suffix ordering.
- Built-in JSON middleware, `error()` responses and `CloveBootError` startup
  diagnostics.
- Sessions with a signed `clove.sid` cookie and a pluggable store.
- Express interop via `engine()`, and `createApp()` for embedding.
- `clove` CLI: `dev`, `build`, `types`, `scaffold`, `routes`.
- Generated `.clove/types.d.ts` from a path-level scan, typing `ctx` with no
  manual declarations.
