import { get } from "clovejs"

/** Explicitly opting out of the JSON middleware via metadata. */
export default get(async (_req, res) => {
  res.raw.setHeader("content-type", "application/json")
  res.raw.end(JSON.stringify({ handWritten: true }))
}).meta({
  json: false,
})
