import { get } from "clovejs"

/** `api/v1/users.get.ts` -> GET /api/v1/users */
export default get(async (_req, _res, ctx) => {
  const a = await ctx.users.findById(1)
  const b = await ctx.users.findById(2)
  return [a, b]
})
