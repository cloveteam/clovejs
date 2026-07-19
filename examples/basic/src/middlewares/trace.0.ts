import { middleware } from "clovejs"

// The `.0` suffix pins this to run first. Code before `handler.execute()`
// runs on the way in, code after it on the way out.
export default middleware(async ({ req, ctx, handler }) => {
  const start = Date.now()
  ctx.logger.info(`[${ctx.requestId}] -> ${req.method} ${req.path}`)

  const result = await handler.execute()

  ctx.logger.info(`[${ctx.requestId}] <- ${req.method} ${req.path} (${Date.now() - start}ms)`)
  return result
})
