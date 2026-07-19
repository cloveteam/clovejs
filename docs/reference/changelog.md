# Changelog

## Unreleased

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
