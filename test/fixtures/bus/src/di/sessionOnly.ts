import { di } from "clovejs"

/** Session-lifetime, so a delivery must refuse it rather than pin it to root. */
export default di({
  lifetime: "session",
  value: () => ({ visits: 0 }),
})
