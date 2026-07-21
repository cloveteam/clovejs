import { di } from "clovejs"

// Exposed as `ctx.config`. The auth metadata factory reads from here, proving a
// factory sees DI-resolved values that a plain metadata object could not.
export default di({
  lifetime: "singleton",
  value: {
    authorizationServers: ["https://auth.test"],
    scopes: ["notes:read", "notes:write"],
    resourceName: "Test resource",
  },
})
