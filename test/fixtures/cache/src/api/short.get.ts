import { get } from "clovejs"

export default get(async (_req, _res, ctx) => {
  return ctx.probe.read("short-route")
}).cache({
  ttl: "1h",
  tags: ["short"],
})
