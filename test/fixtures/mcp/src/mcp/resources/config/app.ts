import { resource } from "clovejs/mcp"

/** Serves the static URI `config://app`. */
export default resource({
  description: "Server configuration",
  async handler(_params, ctx) {
    return { name: "clove-mcp-fixture", notes: ctx.notes.size }
  },
})
