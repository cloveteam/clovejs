import { get } from "clovejs"

// Guarded by middlewares/authorize.1.ts, which reads this metadata.
export default get(async (_req, _res, ctx) => {
  return { notes: ctx.notes.list().length, as: ctx.currentUser?.username }
}).meta({
  adminOnly: true,
})
