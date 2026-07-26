import { CloveBootError } from "../errors.js"
import type { RetryPolicy } from "./types.js"

export const DEFAULT_FACTOR = 2
export const DEFAULT_MAX_DELAY = 30_000

/**
 * The delay before the next delivery, in milliseconds.
 *
 * `attempt` is the delivery that just failed, counting from 1 — so the first
 * failure produces `base`, the second `base * factor`, and so on. Pure: the
 * schedule is core's, while executing the wait is the adapter's.
 */
export function computeDelay(attempt: number, policy: RetryPolicy | null): number {
  const backoff = policy?.backoff
  if (!backoff || backoff.base <= 0) return 0

  const factor = backoff.factor ?? DEFAULT_FACTOR
  const max = backoff.max ?? DEFAULT_MAX_DELAY
  const raw = backoff.base * Math.pow(factor, Math.max(0, attempt - 1))
  const capped = Math.min(raw, max)

  // Equal jitter: half the delay is fixed, half is spread, so a burst of
  // simultaneous failures does not come back as a synchronised burst.
  if (backoff.jitter === false) return Math.round(capped)
  return Math.round(capped / 2 + Math.random() * (capped / 2))
}

/** Validates a `.retry(...)` policy at boot, naming the consumer file. */
export function validateRetryPolicy(
  policy: RetryPolicy | null,
  file: string,
): RetryPolicy | null {
  if (policy === null) return null

  const fail = (message: string): never => {
    throw new CloveBootError(message, [file])
  }

  if (!Number.isInteger(policy.attempts) || policy.attempts < 1) {
    fail(
      `\`retry({ attempts })\` must be an integer of at least 1, but it is ` +
        `${String(policy.attempts)}. Use 1 to disable retrying.`,
    )
  }

  const backoff = policy.backoff
  if (backoff) {
    if (!Number.isFinite(backoff.base) || backoff.base < 0) {
      fail("`retry({ backoff: { base } })` must be a non-negative number of milliseconds.")
    }
    if (backoff.factor !== undefined && (!Number.isFinite(backoff.factor) || backoff.factor < 1)) {
      fail("`retry({ backoff: { factor } })` must be at least 1.")
    }
    if (backoff.max !== undefined && (!Number.isFinite(backoff.max) || backoff.max < 0)) {
      fail("`retry({ backoff: { max } })` must be a non-negative number of milliseconds.")
    }
  }

  return policy
}
