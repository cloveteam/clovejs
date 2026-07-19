import { post, error } from "clovejs"

export default post(async (req, res, ctx) => {
  const { title, body } = (req.body ?? {}) as { title?: string; body?: string }
  if (!title) {
    throw error(400, { message: "title is required" })
  }
  const note = ctx.notes.create({ title, body: body ?? "" })
  res.status(201)
  return note
})
