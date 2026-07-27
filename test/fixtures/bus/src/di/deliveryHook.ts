import { di } from "clovejs"

/**
 * A bus-only eager hook: a `request`-lifetime factory fires on every unit of
 * work, and the trigger guard narrows it to deliveries — on an HTTP request it
 * returns without doing anything.
 */
export default di({
  lifetime: "request",
  eager: true,
  value(ctx, { onDestroy, trigger }) {
    if (trigger?.kind !== "delivery") return null
    ctx.log.deliveryOpened(trigger.kind)
    onDestroy(() => ctx.log.deliveryClosed())
    return true
  },
})
