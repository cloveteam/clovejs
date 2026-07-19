import { di } from "clovejs"

export interface SessionUser {
  id: number
  username: string
  isAdmin: boolean
}

// A session-scoped value, `null` until `login.post.ts` assigns it. Declaring
// it is what turns sessions on: the first write here issues a signed
// `clove.sid` cookie, and every later request from the same browser gets the
// same value back automatically.
export default di({
  lifetime: "session",
  value: null as SessionUser | null,
})
