import { get } from "clovejs"

/** An unexpected throw should become a 500, not crash the process. */
export default get(async () => {
  throw new Error("kaboom")
})
