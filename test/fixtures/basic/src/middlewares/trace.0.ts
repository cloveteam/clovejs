import { middleware } from "clovejs"

/** Priority 0 — runs first, so it can time everything below it. */
export default middleware(async ({ handler, res, ctx }) => {
  res.header("x-request-id", String(ctx.requestId))
  const started = Date.now()
  try {
    return await handler.execute()
  } finally {
    res.header("x-duration-ms", String(Date.now() - started))
  }
})
