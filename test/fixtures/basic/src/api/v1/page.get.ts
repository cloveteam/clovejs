import { get } from "clovejs"

/** Setting a non-JSON type steps the JSON middleware aside. */
export default get(async (_req, res) => {
  res.type("html")
  return "<h1>Hello</h1>"
})
