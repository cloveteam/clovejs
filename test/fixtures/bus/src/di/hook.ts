import { di } from "clovejs"

/**
 * An eager per-scope hook: its factory runs even though no handler reads it,
 * which is what makes it a per-delivery (and per-request) seam.
 */
export default di({
  lifetime: "request",
  eager: true,
  value(ctx, { onDestroy }) {
    ctx.log.scopeOpened()
    onDestroy(() => ctx.log.scopeClosed())
    return true
  },
})
