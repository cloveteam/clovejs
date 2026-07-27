/**
 * The default wire format, and the reason decoding is core's business at all.
 *
 * Serialization is broker-agnostic and has one obvious default, so leaving every
 * adapter to write `JSON.parse(raw.content.toString())` bought nothing except a
 * hole in the lifecycle: a `JSON.parse` inside the adapter's own consume
 * callback throws where no outcome exists, nothing acks, and an at-least-once
 * broker hands the same unparseable bytes back forever.
 *
 * An adapter that passes `body` instead of `payload` gets decoding inside the
 * delivery path, where a failure becomes a `reject` — the same verdict, and for
 * the same reason, as a payload that fails `input` validation.
 */

/** Raised when a message's bytes are not what the codec expects. */
export class MessageDecodeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "MessageDecodeError"
  }
}

const decoder = new TextDecoder("utf-8", { fatal: false })
const encoder = new TextEncoder()

/** UTF-8 JSON, the format an adapter gets when its bus defines no `decode`. */
export function decodeJson(body: Uint8Array): unknown {
  const text = decoder.decode(body)
  if (text.trim() === "") {
    throw new MessageDecodeError("the message body is empty")
  }
  try {
    return JSON.parse(text) as unknown
  } catch (err) {
    throw new MessageDecodeError(
      `the message body is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }
}

/**
 * The publish-side counterpart, for an adapter to call on its own payloads.
 *
 * Not a hook core invokes: `publish()` belongs to the adapter, which already has
 * the value in hand. Exported so the common case is one call rather than a
 * hand-rolled `Buffer.from(JSON.stringify(...))` in every `bus/` file.
 */
export function encodeJson(payload: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(payload ?? null))
}
