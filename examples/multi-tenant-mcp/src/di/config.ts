import { di } from "clovejs"
import { settings } from "../lib/settings.js"

// The resolved settings, exposed as `ctx.config` for tools and services that
// prefer DI over importing the module directly. Resolved once at boot.
export default di({
  lifetime: "singleton",
  value: settings,
})
