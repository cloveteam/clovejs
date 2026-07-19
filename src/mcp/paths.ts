import { stripExtension } from "../scanner/walk.js"

/**
 * Derives an MCP tool or prompt name from a file path relative to its
 * directory.
 *
 * Nested files flatten with camelCase, matching how `services/` and `di/`
 * derive their `ctx` keys — one rule for the whole framework:
 *
 * ```
 * searchNotes.ts        -> searchNotes
 * notes/search.ts       -> notesSearch
 * notes/index.ts        -> notes
 * ```
 */
export function deriveMcpName(relativePath: string): string {
  const segments = stripExtension(relativePath).split("/").filter(Boolean)
  if (segments[segments.length - 1] === "index" && segments.length > 1) segments.pop()
  return segments
    .map((s, i) => (i === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1)))
    .join("")
}

/**
 * Derives a resource URI from a file path relative to `mcp/resources/`.
 *
 * The first segment becomes the URI scheme and the rest becomes the path;
 * `[param]` segments become `{param}` template variables:
 *
 * ```
 * notes/[id].ts         -> notes://{id}
 * config/app.ts         -> config://app
 * files/[...path].ts    -> files://{path}
 * db/users/[id]/tags.ts -> db://users/{id}/tags
 * config.ts             -> config://
 * ```
 */
export function deriveResourceUri(relativePath: string): string {
  const segments = stripExtension(relativePath).split("/").filter(Boolean)
  if (segments[segments.length - 1] === "index" && segments.length > 1) segments.pop()

  const [scheme, ...rest] = segments
  if (!scheme) return ""
  return `${templateSegment(scheme)}://${rest.map(templateSegment).join("/")}`
}

/** Turns `[id]` into `{id}` and leaves literal segments alone. */
function templateSegment(segment: string): string {
  const match = /^\[\.{0,3}(.+)\]$/.exec(segment)
  return match ? `{${match[1]}}` : segment
}

/** The `{param}` variable names a URI template declares, in order. */
export function uriTemplateVariables(uri: string): string[] {
  return [...uri.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!)
}

/** True when the URI carries at least one `{param}` variable. */
export function isUriTemplate(uri: string): boolean {
  return uri.includes("{")
}
