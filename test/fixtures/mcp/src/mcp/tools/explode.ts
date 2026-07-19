import { tool } from "clovejs/mcp"

/** Anything that is not a 4xx becomes a protocol error, not a tool result. */
export default tool({
  description: "Always throws an unexpected error",
  async handler() {
    throw new Error("kaboom")
  },
})
