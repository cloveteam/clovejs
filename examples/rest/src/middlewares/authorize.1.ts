import { middleware, error } from "clovejs"

// Guards routes tagged with `.meta({ adminOnly: true })`. Runs after `trace`
// (`.0` < `.1`), so every request is logged even when this rejects it.
export default middleware(async ({ route, handler, ctx }) => {
  if (route.meta.adminOnly && !ctx.currentUser?.isAdmin) {
    throw error(403, { message: "Forbidden" })
  }
  return handler.execute()
})
