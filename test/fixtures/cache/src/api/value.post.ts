import { post } from "clovejs"

export default post(async (req, _res, ctx) => {
  return ctx.probe.write(String(req.body.value))
}).invalidates(["value"])
