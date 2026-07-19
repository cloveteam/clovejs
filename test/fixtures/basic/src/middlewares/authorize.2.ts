import { middleware, error } from "clovejs"

/** Priority 2 — relies on `ctx.currentUser` set by the authenticate middleware. */
export default middleware(async ({ route, handler, ctx }) => {
  if (route.meta.adminOnly && !ctx.currentUser?.isAdmin) {
    throw error(403, { message: "Forbidden for non-admins" })
  }
  return handler.execute()
})
