import { get } from "clovejs"

export default get(async (_req, _res, ctx) => {
  return { message: `Hello from ${ctx.config.appName}` }
})
