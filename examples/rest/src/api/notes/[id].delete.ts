import { del, error } from "clovejs"

// Returning nothing responds `204`.
export default del(async (req, _res, ctx) => {
  const removed = ctx.notes.remove(Number(req.params.id))
  if (!removed) {
    throw error(404, { message: "No such note" })
  }
})
