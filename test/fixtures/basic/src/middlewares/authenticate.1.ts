import { middleware } from "clovejs"

/** Priority 1 — establishes `ctx.currentUser` for everything downstream. */
export default middleware(async ({ handler, req, ctx }) => {
  const token = req.cookie.token
  if (token) {
    ctx.currentUser = await ctx.auth.verify(token)
  }
  return handler.execute()
})
