import { di } from "clovejs"

// A plain singleton value — resolved once at boot, read synchronously
// afterwards as `ctx.config`. The tests override it to prove a fake takes hold.
export default di({
  lifetime: "singleton",
  value: {
    appName: "CloveJS testing example",
    greeting: "hello",
  },
})
