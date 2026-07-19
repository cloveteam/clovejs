import { di } from "clovejs"

/** Session-scoped counter, incremented by the counter route. */
export default di({
  lifetime: "session",
  value: 0,
})
