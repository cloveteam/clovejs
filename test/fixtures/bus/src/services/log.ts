import { service } from "clovejs"

export interface Seen {
  channel: string
  subscription: string
  attempt: number
  failures: number
  payload: unknown
}

export default service(async () => {
  const seen: Seen[] = []
  const failures = new Map<string, number>()
  const scopes = { opened: 0, closed: 0 }
  const deliveries = { opened: 0, closed: 0, triggers: [] as string[] }

  return {
    scopeOpened(): void {
      scopes.opened += 1
    },
    scopeClosed(): void {
      scopes.closed += 1
    },
    scopes(): { opened: number; closed: number } {
      return { ...scopes }
    },

    deliveryOpened(trigger: string): void {
      deliveries.opened += 1
      deliveries.triggers.push(trigger)
    },
    deliveryClosed(): void {
      deliveries.closed += 1
    },
    deliveryScopes(): { opened: number; closed: number; triggers: string[] } {
      return { ...deliveries, triggers: [...deliveries.triggers] }
    },

    record(entry: Seen): void {
      seen.push(entry)
    },
    all(): Seen[] {
      return seen
    },
    forSubscription(subscription: string): Seen[] {
      return seen.filter((s) => s.subscription === subscription)
    },
    /** True until the given key has been asked `times` times. */
    shouldFail(key: string, times: number): boolean {
      const count = failures.get(key) ?? 0
      failures.set(key, count + 1)
      return count < times
    },
    reset(): void {
      seen.length = 0
      failures.clear()
      scopes.opened = 0
      scopes.closed = 0
      deliveries.opened = 0
      deliveries.closed = 0
      deliveries.triggers.length = 0
    },
  }
})
