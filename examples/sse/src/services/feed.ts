import { service } from "clovejs"

export interface FeedEvent {
  /** A process-wide monotonic id, used as the SSE `id:` for reconnect resume. */
  seq: number
  channel: string
  type: string
  data: unknown
  at: string
}

type Listener = (event: FeedEvent) => void

// A singleton, so every stream and every HTTP request talks to the same feed.
// Each `sse()` handler gets its own request-scoped container per connection, but
// singletons are shared across all of them — that is what lets an HTTP POST fan
// out to every connected EventSource without any global state of your own.
export default service(async (ctx, { onDestroy }) => {
  const listeners = new Map<string, Set<Listener>>()
  const log = new Map<string, FeedEvent[]>()
  let seq = 0

  onDestroy(async () => {
    ctx.logger.info("feed shutting down")
    listeners.clear()
  })

  return {
    /** Registers a listener on a channel and returns the function to remove it. */
    subscribe(channel: string, fn: Listener): () => void {
      const subs = listeners.get(channel) ?? new Set<Listener>()
      listeners.set(channel, subs)
      subs.add(fn)
      return () => {
        subs.delete(fn)
        if (subs.size === 0) listeners.delete(channel)
      }
    },

    /** Appends an event and fans it out to everyone listening to `channel`. */
    publish(channel: string, type: string, data: unknown): FeedEvent {
      const event: FeedEvent = {
        seq: ++seq,
        channel,
        type,
        data,
        at: new Date().toISOString(),
      }
      const past = log.get(channel) ?? []
      past.push(event)
      log.set(channel, past.slice(-100))

      for (const fn of listeners.get(channel) ?? []) fn(event)
      return event
    },

    /** Events on `channel` newer than `afterSeq` — the reconnect replay. */
    since(channel: string, afterSeq: number): FeedEvent[] {
      return (log.get(channel) ?? []).filter((event) => event.seq > afterSeq)
    },

    /** How many streams are currently open on `channel`. */
    live(channel: string): number {
      return listeners.get(channel)?.size ?? 0
    },
  }
})
