import { get } from "clovejs"

export default get(async (_req, _res, ctx) => ({ ...ctx.stats }))
