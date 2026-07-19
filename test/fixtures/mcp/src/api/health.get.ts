import { get } from "clovejs"

/** Proves HTTP routes still serve normally alongside the MCP endpoint. */
export default get(async (_req, _res, ctx) => {
  return { ok: true, notes: ctx.notes.size }
})
