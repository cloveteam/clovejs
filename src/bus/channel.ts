import { CloveBootError } from "../errors.js"
import { PATTERN, isChannelPattern, type ChannelSelector } from "./types.js"

/** The characters that mean "wildcard" to AMQP (`*`, `#`) and NATS (`*`, `>`). */
const WILDCARD = /[*#>]/

export function looksLikePattern(channel: string): boolean {
  return WILDCARD.test(channel)
}

/** A consumer's channel, resolved into what `subscribe()` receives. */
export interface ResolvedChannel {
  channel: string
  /** True when the broker is expected to expand `channel` as a selector. */
  pattern: boolean
}

/**
 * Turns a declared `channel` into a literal-or-selector pair.
 *
 * A bare string containing wildcard punctuation is a boot error rather than a
 * guess. Inferring "pattern" from the presence of `#` promotes a literal channel
 * that happens to contain one — `user.#1` — into a subscription to far more than
 * was meant, and there is no way to say "literal, and yes it has a `#` in it" at
 * all. Both readings are available by name, and neither is silent.
 */
export function resolveChannel(
  selector: ChannelSelector,
  file: string,
): ResolvedChannel {
  if (isChannelPattern(selector)) {
    const { selector: channel } = selector
    if (typeof channel !== "string" || channel.length === 0) {
      throw new CloveBootError(
        "`pattern()` and `literal()` need a non-empty channel string.",
        [file],
      )
    }
    return { channel, pattern: selector[PATTERN] === "pattern" }
  }

  if (typeof selector !== "string" || selector.length === 0) {
    throw new CloveBootError(
      "consume({ channel }) is required and must be a non-empty string, or " +
        'pattern("...") for a selector the broker expands.',
      [file],
    )
  }

  if (looksLikePattern(selector)) {
    throw new CloveBootError(
      `channel "${selector}" contains wildcard punctuation (\`*\`, \`#\` or ` +
        `\`>\`) but is written as a plain string, which subscribes to it ` +
        `literally. Say which you meant: \`pattern("${selector}")\` for a ` +
        `selector the broker expands, or \`literal("${selector}")\` for a ` +
        `channel whose name really does contain those characters.`,
      [file],
    )
  }

  return { channel: selector, pattern: false }
}

/**
 * AMQP/NATS-style topic matching: `*` stands for exactly one dot-separated
 * segment, `#` and `>` for zero or more. A selector with none is compared
 * literally.
 *
 * Used by `memoryBus()` to route, and by `app.bus.dispatch()` to find the
 * consumer a channel belongs to. A real adapter never calls it — expansion is
 * the broker's, in the broker's own syntax.
 */
export function matchChannel(selector: string, channel: string): boolean {
  if (selector === channel) return true
  if (!looksLikePattern(selector)) return false
  return matchSegments(selector.split("."), channel.split("."))
}

function matchSegments(pattern: string[], value: string[]): boolean {
  if (pattern.length === 0) return value.length === 0

  const [head, ...rest] = pattern
  if (head === "#" || head === ">") {
    // Greedy but backtracking: try consuming 0, 1, ... remaining segments.
    for (let i = 0; i <= value.length; i++) {
      if (matchSegments(rest, value.slice(i))) return true
    }
    return false
  }

  if (value.length === 0) return false
  if (head !== "*" && head !== value[0]) return false
  return matchSegments(rest, value.slice(1))
}
