import { di } from "clovejs"

/** What opened the current scope, as a factory sees it through `trigger`. */
export default di({
  lifetime: "request",
  value: (_ctx, { trigger }) => trigger?.kind ?? "none",
})
