import { prompt } from "clovejs/mcp"
import { z } from "zod"

// A prompt is a template the user picks, not one the model calls. It rounds
// out the three MCP primitives (tool, resource, prompt) under the same auth.
export default prompt({
  description: "Summarize one of your notes in three bullet points",
  input: z.object({
    id: z.string().describe("The note id to summarize"),
  }),
  async handler({ id }) {
    return [
      {
        role: "user" as const,
        content:
          `Read the resource notes://${id} and summarize it in exactly three ` +
          `concise bullet points.`,
      },
    ]
  },
})
