import { resource } from "clovejs/mcp"

// No `[param]` segment, so this is a plain URI rather than a template:
// `config://app`. Returning an object sends it as JSON.
export default resource({
  description: "What this server is and how much is in it",
  async handler(_params, ctx) {
    return {
      name: "clovejs-example-basic",
      url: ctx.config.url,
      notes: ctx.notes.list().length,
    }
  },
})
