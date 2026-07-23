import { middleware } from "clovejs"

export default middleware(async ({ handler, req, res }) => {
  if (req.header("x-short-circuit") === "yes") {
    return { shortCircuited: true }
  }

  res.header("x-before", "yes")
  const result = await handler.execute()
  res.header(
    "x-after",
    String((result as { execution?: number } | undefined)?.execution ?? "none"),
  )

  return typeof result === "object" && result !== null
    ? { ...result, intercepted: true }
    : result
})
