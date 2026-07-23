import { get } from "clovejs"

export default get(async (req, res, ctx) => {
  const result = await ctx.probe.read(req.header("accept-language"))
  res.header("x-handler", String(result.execution))
  return result
}).cache({
  ttl: "1h",
  staleWhileRevalidate: "5m",
  vary: ["accept-language"],
  tags: ["value"],
  client: {
    maxAge: "30s",
    sharedMaxAge: "1m",
    staleWhileRevalidate: "5m",
  },
})
