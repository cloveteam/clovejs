import { di } from "clovejs"

/**
 * Session-scoped, so it counts calls within one MCP session and resets for the
 * next. Declaring it is also what turns sessions on for this fixture.
 */
export default di({
  lifetime: "session",
  value: 0 as number,
})
