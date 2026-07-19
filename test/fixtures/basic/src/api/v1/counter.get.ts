import { get } from "clovejs"

/** Reads a session-scoped value so the session tests have something to observe. */
export default get(async (_req, _res, ctx) => {
  const visits = ((ctx.visits as number | undefined) ?? 0) + 1
  ctx.visits = visits
  return { visits, requestId: ctx.requestId }
})
