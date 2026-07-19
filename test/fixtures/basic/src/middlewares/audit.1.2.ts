import { middleware } from "clovejs"

/**
 * Priority 1.2 — slots between `.1` and `.2` without renaming either, which is
 * the sub-priority case from the concept document.
 */
export const order: string[] = []

export default middleware(async ({ handler, res }) => {
  res.header("x-audited", "yes")
  return handler.execute()
})
