import { post } from "clovejs"

export default post(async (_req, _res, ctx) => {
  ctx.currentUser = null
})
