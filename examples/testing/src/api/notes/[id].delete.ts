import { del, error } from "clovejs"

// Admin-only, so the tests can show the authorize middleware both rejecting an
// anonymous caller (403) and letting an admin session through. Returning
// nothing responds `204`.
export default del(async (req, _res, ctx) => {
  const removed = ctx.notes.remove(Number(req.params.id))
  if (!removed) {
    throw error(404, { message: "No such note" })
  }
}).meta({ adminOnly: true })
