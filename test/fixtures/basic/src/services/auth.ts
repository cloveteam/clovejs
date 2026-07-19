import { service, error } from "clovejs"

export interface LoginParams {
  username: string
  password: string
}

const tokens = new Map<string, number>()

export default service(async (ctx, { onDestroy }) => {
  ctx.logger.debug("auth service initialized")

  let logins = 0

  onDestroy(async () => {
    ctx.logger.debug("auth service destroyed")
    tokens.clear()
  })

  // Helpers live in the closure rather than on the returned object, so methods
  // can call them without TypeScript hitting a circular inference on `this`.
  const sign = (userId: number): string => {
    const token = `token-${userId}-${Math.random().toString(36).slice(2)}`
    tokens.set(token, userId)
    return token
  }

  return {
    get logins() {
      return logins
    },

    sign,

    async login({ username, password }: LoginParams) {
      const user = await ctx.db.user.find({
        username,
        password: ctx.users.hash(password),
      })
      if (!user) {
        throw error(401, { message: "Username / password pair mismatch" })
      }
      const token = sign(user.id)
      logins++
      return { user: ctx.users.strip(user), token }
    },

    async verify(token: string) {
      const userId = tokens.get(token)
      if (userId === undefined) return null
      const user = await ctx.db.user.findById(userId)
      return user ? ctx.users.strip(user) : null
    },
  }
})
