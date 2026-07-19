import { middleware } from "clovejs"

/** No priority — runs after every numbered middleware. */
export default middleware(async ({ handler, res }) => {
  res.header("x-stamped", "last")
  return handler.execute()
})
