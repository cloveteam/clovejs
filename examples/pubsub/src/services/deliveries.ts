import { service } from "clovejs"

/**
 * The history of what consumers have done, kept for the `/api/state` route.
 *
 * Singleton, because it outlives any one delivery. Splitting it from the
 * per-delivery timer in `di/deliveryLog.ts` is the point: the timer is scoped to
 * one message and cannot be read from an HTTP request, while this list is shared
 * and can be read from anywhere.
 */
export default service(async () => {
  const entries: string[] = []

  return {
    record(line: string): void {
      entries.push(line)
      if (entries.length > 50) entries.shift()
    },
    recent(): string[] {
      return [...entries]
    },
  }
})
