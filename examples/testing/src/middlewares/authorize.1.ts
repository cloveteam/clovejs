import { middleware, error } from "clovejs"

// Guards routes tagged with `.meta({ adminOnly: true })`. The middleware tests
// exercise both branches — a 403 for anonymous callers and a pass-through once
// an admin session is established.
export default middleware(async ({ route, handler, ctx }) => {
  if (route.meta.adminOnly && !ctx.currentUser?.isAdmin) {
    throw error(403, { message: "Forbidden" })
  }
  return handler.execute()
})
