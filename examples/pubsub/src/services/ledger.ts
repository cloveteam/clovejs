import { service } from "clovejs"

/** Counts what the wildcard consumers saw, so the demo has something to show. */
export default service(async () => {
  const orders = new Map<string, string[]>()
  const presence: string[] = []

  return {
    record(channel: string, orderId: string): void {
      orders.set(channel, [...(orders.get(channel) ?? []), orderId])
    },

    presence(channel: string, userId: string): void {
      presence.push(`${channel}: ${userId}`)
    },

    snapshot(): { orders: Record<string, string[]>; presence: string[] } {
      return { orders: Object.fromEntries(orders), presence }
    },
  }
})
