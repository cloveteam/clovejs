import { randomUUID } from "node:crypto"
import { di } from "clovejs"

// A request-scoped factory: a fresh id every time, read by the trace
// middleware for log correlation.
export default di({
  lifetime: "request",
  value: () => randomUUID(),
})
