import { middleware } from "clovejs"

// Unlike WebSocket upgrades, an `sse()` endpoint is an ordinary GET route, so
// everything in `middlewares/` runs for it. This one just logs, but the same
// place is where you would authenticate or rate-limit a stream — and a
// middleware that throws (say a 401) short-circuits before the stream opens, so
// the client gets a normal error response rather than an empty event stream.
export default middleware(async ({ req, ctx, handler }) => {
  ctx.logger.info(`${req.method} ${req.path}`)
  return handler.execute()
})
