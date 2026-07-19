# Changelog

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
