import { get } from "clovejs"

// `null` from a GET becomes `404` automatically — no explicit error() needed.
export default get(async (req, _res, ctx) => {
  return ctx.notes.findById(Number(req.params.id))
})
