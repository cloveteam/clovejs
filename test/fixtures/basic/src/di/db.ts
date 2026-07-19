import { di } from "clovejs"

export interface DbUser {
  id: number
  username: string
  password: string
  isAdmin: boolean
}

/**
 * Stands in for a real database client. Demonstrates an async singleton
 * factory that reads another dependency and registers a teardown hook.
 */
export default di({
  lifetime: "singleton",
  async value(ctx, { onDestroy }) {
    const config = ctx.config.db
    const users: DbUser[] = [
      { id: 1, username: "ada", password: hash("lovelace"), isAdmin: true },
      { id: 2, username: "grace", password: hash("hopper"), isAdmin: false },
    ]
    let connected = true

    onDestroy(async () => {
      connected = false
    })

    return {
      connectedAs: config.user,
      get connected() {
        return connected
      },
      user: {
        async find(query: { username: string; password: string }) {
          return (
            users.find(
              (u) => u.username === query.username && u.password === query.password,
            ) ?? null
          )
        },
        async findById(id: number) {
          return users.find((u) => u.id === id) ?? null
        },
      },
      book: {
        async findByUser(userId: number) {
          return userId === 1 ? [{ id: 2, title: "Notes on the Analytical Engine" }] : []
        },
      },
    }
  },
})

function hash(password: string): string {
  return `hashed:${password}`
}
