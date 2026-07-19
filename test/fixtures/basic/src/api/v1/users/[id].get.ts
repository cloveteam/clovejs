import { get } from "clovejs"

/**
 * `api/v1/users/[id].get.ts` -> GET /api/v1/users/1
 *
 * Returning null makes the JSON middleware answer 404 on a GET.
 */
export default get(async (req, _res, ctx) => {
  const userId = parseInt(req.params.id, 10)
  return ctx.users.findById(userId)
})
