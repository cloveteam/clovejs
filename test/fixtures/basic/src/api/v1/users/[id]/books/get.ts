import { get } from "clovejs"

/** `api/v1/users/[id]/books/get.ts` -> GET /api/v1/users/1/books */
export default get(async (req, _res, ctx) => {
  return ctx.users.booksOf(parseInt(req.params.id, 10))
})
