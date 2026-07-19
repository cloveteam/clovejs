import { get } from "clovejs"

/** Guarded by the authorize middleware through route metadata. */
export default get(async (_req, _res, ctx) => {
  return { secret: "only admins see this", as: ctx.currentUser?.username }
}).meta({
  adminOnly: true,
})
