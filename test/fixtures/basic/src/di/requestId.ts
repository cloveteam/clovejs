import { di } from "clovejs"

let counter = 0

/** A request-scoped factory: a fresh value for every request. */
export default di({
  lifetime: "request",
  value() {
    return `req-${++counter}`
  },
})
