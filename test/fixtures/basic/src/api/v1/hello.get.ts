import { get, view } from "clovejs"

/** Returns a view() result: rendered as HTML through the registered engine. */
export default get(async (req) => {
  return view("greeting", { name: req.query.name ?? "world" })
})
