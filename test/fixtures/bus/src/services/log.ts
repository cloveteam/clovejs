import { service } from "clovejs"

export interface Seen {
  channel: string
  subscription: string
  attempt: number
  payload: unknown
}

export default service(async () => {
  const seen: Seen[] = []
  const failures = new Map<string, number>()
  const scopes = { opened: 0, closed: 0 }

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
    },
  }
})
