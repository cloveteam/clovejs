import { di } from "clovejs"

/**
 * A per-delivery hook, which is what CloveJS offers instead of consumer
 * middleware.
 *
 * Every delivery opens its own request scope, so a `request`-lifetime factory
 * is already a per-delivery seam: start the span, the transaction or the timer
 * here and close it in `onDestroy`. The factory fires on every unit of work —
 * HTTP requests included — and the `trigger` guard is what narrows it to
 * deliveries: anywhere else it returns a no-op recorder and registers no
 * teardown.
 *
 * The shared history it writes into lives in `services/deliveries.ts`, which a
 * route can read.
 *
 * `eager: true` is what makes it a hook rather than a lazy value. Resolution is
 * lazy by default — a factory nothing reads never runs at all — so without it
 * the timer would only start for handlers that happened to touch
 * `ctx.deliveryLog`.
 */
export default di({
  lifetime: "request",
  eager: true,
  value(ctx, { onDestroy, trigger }) {
    if (trigger?.kind !== "delivery") {
      return { note: (_text: string) => {} }
    }

    const started = Date.now()
    const notes: string[] = []
    const where = trigger.consumer

    onDestroy(() => {
      const line =
        `${where}: ${notes.join(" | ") || "(no notes)"} — ${Date.now() - started}ms`
      ctx.deliveries.record(line)
      ctx.logger.debug(`[delivery] ${line}`)
    })

    return {
      note: (text: string) => void notes.push(text),
    }
  },
})
