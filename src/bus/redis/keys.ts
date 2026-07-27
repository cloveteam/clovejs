/**
 * Where each of a subscription's keys lives, and why they all land on one
 * cluster slot.
 *
 * A subscription needs three keys: the stream the producer writes to, a private
 * retry stream, and a delay set. `XREADGROUP` reads the first two in a single
 * call, and a single call cannot span slots — so on Redis Cluster the derived
 * keys have to hash to wherever the channel already hashed.
 *
 * That is what the braces do. Redis hashes a key on the substring between its
 * first `{` and the following `}`, if there is one, and on the whole key
 * otherwise. So `{orders.created}:billing:retry` hashes on `orders.created`,
 * which is exactly what the untagged stream key `orders.created` hashes on.
 * The channel itself is never rewritten: it stays the key a non-CloveJS
 * producer would `XADD` to.
 */

/** The substring Redis hashes a key on, following its own rule. */
export function hashTag(key: string): string {
  const open = key.indexOf("{")
  if (open === -1) return key
  const close = key.indexOf("}", open + 1)
  // An empty or unterminated tag is not a tag: the whole key is hashed.
  if (close === -1 || close === open + 1) return key
  return key.slice(open + 1, close)
}

export interface KeyLayout {
  /** The stream a producer publishes to. The channel, verbatim under `prefix`. */
  stream(channel: string): string
  /** This subscription's private redelivery stream. */
  retry(channel: string, subscription: string): string
  /** This subscription's set of messages waiting out a backoff. */
  delayed(channel: string, subscription: string): string
}

export function keyLayout(prefix = ""): KeyLayout {
  const stream = (channel: string): string => prefix + channel
  const derived = (channel: string, subscription: string, suffix: string): string =>
    `{${hashTag(stream(channel))}}:${subscription}:${suffix}`

  return {
    stream,
    retry: (channel, subscription) => derived(channel, subscription, "retry"),
    delayed: (channel, subscription) => derived(channel, subscription, "delayed"),
  }
}
