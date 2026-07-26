import { di } from "clovejs"

const entries: string[] = []

/**
 * A per-delivery hook, which is what CloveJS offers instead of consumer
 * middleware.
 *
 * Every delivery gets its own request-scoped container, so a `request`-lifetime
 * factory is already a per-delivery seam: start the span, the transaction or
 * the timer in the factory, and close it in `onDestroy`. This also runs
 * per-HTTP-request, since a delivery and a request are the same shape of work.
 *
 * `eager: true` is what makes it a hook rather than a lazy value. Resolution is
 * lazy by default — a factory nothing reads never runs at all — so without it
 * the span below would only start for handlers that happened to touch
 * `ctx.deliveryLog`.
 */
export default di({
  lifetime: "request",
  eager: true,
  value(ctx, { onDestroy }) {
    const started = Date.now()
    const notes: string[] = []

    onDestroy(() => {
      const line = `${notes.join(" | ") || "(no notes)"} — ${Date.now() - started}ms`
      entries.push(line)
      if (entries.length > 50) entries.shift()
      ctx.logger.debug(`[delivery] ${line}`)
    })

    return {
      note: (text: string) => void notes.push(text),
      recent: () => [...entries],
    }
  },
})
