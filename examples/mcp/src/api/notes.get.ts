import { get } from "clovejs"

// An array return becomes `200` with a JSON body.
export default get(async (_req, _res, ctx) => {
  return ctx.notes.list()
})
