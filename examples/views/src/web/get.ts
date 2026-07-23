import { get, view } from "clovejs"

// GET / — files in web/ mount at the root, not under /api. Returns a view()
// result; the pipeline renders it to HTML through the engine in src/views.ts.
export default get(async (req) => {
  return view("hello", { name: req.query.name ?? "world" })
})
