/**
 * The header an adapter uses to carry the delivery counter across a retry hop.
 *
 * Core requires `envelope.attempt` to be accurate, because a retry cap that
 * depends on an optional counter is not a cap. Brokers that count natively —
 * SQS's `ApproximateReceiveCount`, NATS JetStream's `num_delivered` — report
 * theirs and ignore this. Brokers that do not, RabbitMQ and Kafka among them,
 * carry the number themselves; these two helpers are that mechanism, so every
 * adapter does it identically and none of them has to invent it.
 */
export const ATTEMPT_HEADER = "x-clove-attempt"

/**
 * Reads the delivery counter out of a message's headers.
 *
 * Returns 1 for a first delivery, where the header is absent, and for any value
 * that is not a positive integer — a corrupt counter must not disable the cap.
 */
export function readAttempt(
  headers: Readonly<Record<string, string | undefined>> | undefined,
): number {
  const raw = headers?.[ATTEMPT_HEADER]
  if (raw === undefined) return 1
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1) return 1
  return parsed
}

/**
 * Returns a copy of `headers` carrying `attempt`, for the adapter to attach to
 * the message it republishes on a `retry` outcome.
 */
export function stampAttempt(
  headers: Readonly<Record<string, string>> | undefined,
  attempt: number,
): Record<string, string> {
  return { ...headers, [ATTEMPT_HEADER]: String(attempt) }
}
