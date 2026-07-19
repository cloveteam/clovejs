import { error, tool } from "clovejs/mcp"

/** A 4xx becomes a readable tool result, so the model can correct itself. */
export default tool({
  description: "Always refuses with a client error",
  async handler() {
    throw error(404, { message: "No such note" })
  },
})
