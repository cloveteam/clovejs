import { get, error } from "clovejs"

export default get(async (_req, _res, ctx) => {
  if (!ctx.currentUser) {
    throw error(401, { message: "Not logged in" })
  }
  return ctx.currentUser
})
