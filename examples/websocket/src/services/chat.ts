import { service } from "clovejs"

export interface ChatMessage {
  room: string
  from: string
  text: string
  at: string
}

type Subscriber = (msg: ChatMessage) => void

// A singleton, so every socket and every HTTP request talks to the same
// registry. `ws()` handlers get their own request-scoped container per
// connection, but singletons are shared across all of them — that's what makes
// broadcasting possible without any global state of your own.
export default service(async (ctx, { onDestroy }) => {
  const rooms = new Map<string, Set<Subscriber>>()
  const history = new Map<string, ChatMessage[]>()

  onDestroy(async () => {
    ctx.logger.info("chat service shutting down")
    rooms.clear()
  })

  return {
    /** Registers a listener and returns the function that removes it. */
    subscribe(room: string, fn: Subscriber): () => void {
      const subs = rooms.get(room) ?? new Set<Subscriber>()
      rooms.set(room, subs)
      subs.add(fn)
      return () => {
        subs.delete(fn)
        if (subs.size === 0) rooms.delete(room)
      }
    },

    /** Fans a message out to everyone currently listening to `room`. */
    publish(room: string, from: string, text: string): ChatMessage {
      const msg: ChatMessage = { room, from, text, at: new Date().toISOString() }

      const past = history.get(room) ?? []
      past.push(msg)
      history.set(room, past.slice(-50))

      for (const fn of rooms.get(room) ?? []) fn(msg)
      return msg
    },

    recent(room: string): ChatMessage[] {
      return history.get(room) ?? []
    },

    occupants(room: string): number {
      return rooms.get(room)?.size ?? 0
    },
  }
})
