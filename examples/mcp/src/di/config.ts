import { di } from "clovejs"

// A plain singleton value — resolved once at boot, read synchronously
// afterwards as `ctx.config`.
export default di({
  lifetime: "singleton",
  value: {
    appName: "CloveJS MCP example",
  },
})
