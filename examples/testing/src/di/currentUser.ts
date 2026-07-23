import { di } from "clovejs"

export interface SessionUser {
  id: number
  username: string
  isAdmin: boolean
}

// A session-scoped value, `null` until `login.post.ts` assigns it. Declaring it
// is what turns sessions on: the first write issues a signed `clove.sid`
// cookie, and the test client's cookie jar carries it across requests.
export default di({
  lifetime: "session",
  value: null as SessionUser | null,
})
