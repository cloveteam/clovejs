import { di } from "clovejs"

export interface SessionUser {
  id: number
  username: string
  isAdmin: boolean
}

/** A session-scoped value, assigned by the authenticate middleware. */
export default di({
  lifetime: "session",
  value: null as SessionUser | null,
})
