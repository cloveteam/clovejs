import { service, error } from "clovejs"
import type { SessionUser } from "../di/currentUser.js"

// A toy user table. Real apps look this up in a database and hash the
// password — kept plain here so the example stays focused on CloveJS itself.
const USERS: Array<SessionUser & { password: string }> = [
  { id: 1, username: "ada", password: "secret", isAdmin: true },
  { id: 2, username: "grace", password: "secret", isAdmin: false },
]

export default service(async () => ({
  login(username: string, password: string): SessionUser {
    const user = USERS.find((u) => u.username === username && u.password === password)
    if (!user) {
      throw error(401, { message: "Username / password pair mismatch" })
    }
    const { password: _password, ...sessionUser } = user
    return sessionUser
  },
}))
