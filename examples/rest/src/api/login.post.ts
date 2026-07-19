import { post, error } from "clovejs"

export default post(async (req, _res, ctx) => {
  const { username, password } = (req.body ?? {}) as {
    username?: string
    password?: string
  }
  if (!username || !password) {
    throw error(400, { message: "username and password are required" })
  }

  // Assigning to a session-scoped di value is what persists it: every later
  // request carrying the same `clove.sid` cookie sees this same object.
  ctx.currentUser = ctx.auth.login(username, password)
  return ctx.currentUser
})
