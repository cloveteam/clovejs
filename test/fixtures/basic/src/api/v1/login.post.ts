import { post, error } from "clovejs"

export default post(async (req, res, ctx) => {
  if (!req.body?.username || !req.body?.password) {
    throw error(400, { message: "username and password are required" })
  }
  const { user, token } = await ctx.auth.login({
    username: req.body.username,
    password: req.body.password,
  })
  res.cookie("token", token, { httpOnly: true })
  ctx.currentUser = user
  return { user }
})
