import { service } from "clovejs"
import type { DbUser } from "../di/db.js"

export default service(async (ctx) => {
  const strip = (user: DbUser) => {
    const { password: _password, ...rest } = user
    return rest
  }

  return {
    hash(password: string) {
      return `hashed:${password}`
    },

    strip,

    async findById(id: number) {
      const user = await ctx.db.user.findById(id)
      return user ? strip(user) : null
    },

    async booksOf(userId: number) {
      return ctx.db.book.findByUser(userId)
    },
  }
})
