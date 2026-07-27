/**
 * The header carrying the failure counter across a retry hop.
 *
 * Core requires the counter to be accurate, because a retry cap that depends on
 * an optional counter is not a cap. Brokers that cannot carry one cannot cap
 * retries, and say so with `retries: "none"`.
 *
 * The value on the wire is the 1-based attempt number, so `2` means "one failure
 * so far". Core stamps it on the headers it returns with a `retry` outcome, so an
 * adapter writes `outcome.headers` verbatim and never has to remember to
 * increment anything.
 */
export const ATTEMPT_HEADER = "x-clove-attempt"

/**
 * The namespace Clove reserves in a message's headers.
 *
 * Control metadata and user headers travel in the same map on every broker, so
 * the boundary has to be drawn by name. Core strips this prefix from what a
 * handler sees and refuses to publish it, which is what stops a producer — by
 * accident, forwarding headers, or otherwise — from setting a consumer's failure
 * count and burning its whole retry budget on the first delivery.
 */
export const RESERVED_HEADER_PREFIX = "x-clove-"

function isReservedHeader(name: string): boolean {
  return name.toLowerCase().startsWith(RESERVED_HEADER_PREFIX)
}

/**
 * Reads how many times a handler has already run and failed on this message.
 *
 * What an adapter passes as `failures` when it hands a message over:
 *
 * ```ts
 * await deliver({ …, failures: readFailures(headers) })
 * ```
 *
 * Returns 0 for a first delivery, where the header is absent, and for any value
 * that is not a positive integer — a corrupt counter must not disable the cap.
 * Reading a garbled number as "huge" would reject a healthy message on its first
 * try, whereas reading it as 0 costs at most a few extra attempts.
 */
export function readFailures(
  headers: Readonly<Record<string, string | undefined>> | undefined,
): number {
  const raw = headers?.[ATTEMPT_HEADER]
  if (raw === undefined) return 0
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1) return 0
  return parsed - 1
}

/**
 * Returns a copy of `headers` carrying `failures`.
 *
 * Core calls this itself for the headers on a `retry` outcome, so an adapter
 * normally has no reason to — writing `outcome.headers` is enough. It stays
 * exported for transports that cannot carry headers as-is and have to rebuild
 * them. Mutates nothing.
 */
export function stampFailures(
  headers: Readonly<Record<string, string>> | undefined,
  failures: number,
): Record<string, string> {
  return { ...headers, [ATTEMPT_HEADER]: String(failures + 1) }
}

/**
 * Drops every reserved key, leaving the headers the producer actually set.
 *
 * Applied to each inbound message, so a handler reading `message.headers` sees
 * its own vocabulary and never Clove's bookkeeping.
 */
export function stripReserved(
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  if (!headers) return {}
  const clean: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (!isReservedHeader(name)) clean[name] = value
  }
  return clean
}

/** The reserved keys present in a header map, if any. */
export function reservedHeadersIn(
  headers: Readonly<Record<string, string>> | undefined,
): string[] {
  if (!headers) return []
  return Object.keys(headers).filter(isReservedHeader)
}
