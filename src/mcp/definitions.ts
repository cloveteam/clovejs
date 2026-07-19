import { KIND, META } from "../types.js"
import type {
  InputSchema,
  McpPromptDefinition,
  McpPromptSpec,
  McpResourceDefinition,
  McpResourceSpec,
  McpToolDefinition,
  McpToolMeta,
  McpToolSpec,
} from "./types.js"

/**
 * Declares an MCP tool — an action a model can invoke.
 *
 * The tool name comes from the filename (`mcp/tools/searchNotes.ts` becomes
 * `searchNotes`) unless `name` overrides it.
 *
 * ```ts
 * export default tool({
 *   description: "Full-text search across the user's notes",
 *   input: z.object({ query: z.string() }),
 *   async handler({ query }, ctx) {
 *     return ctx.notes.search(query)
 *   },
 * })
 * ```
 */
export function tool<S extends InputSchema | undefined = undefined, Result = unknown>(
  spec: McpToolSpec<S, Result>,
): McpToolDefinition {
  const def: McpToolDefinition = {
    [KIND]: "mcpTool",
    [META]: {},
    name: spec.name ?? null,
    description: spec.description,
    title: spec.title ?? null,
    input: (spec.input ?? null) as InputSchema | null,
    handler: spec.handler as McpToolDefinition["handler"],
    meta(meta: McpToolMeta) {
      Object.assign(def[META], meta)
      return def
    },
  }
  return def
}

/**
 * Declares an MCP resource — data a client can read by URI.
 *
 * The URI comes from the file path: the first directory segment becomes the
 * scheme and the rest becomes the path, with `[param]` segments turning into
 * `{param}` template variables. `mcp/resources/notes/[id].ts` serves
 * `notes://{id}`. Pass `uri` to set it explicitly.
 */
export function resource<Result = unknown>(
  spec: McpResourceSpec<Result>,
): McpResourceDefinition {
  return {
    [KIND]: "mcpResource",
    uri: spec.uri ?? null,
    name: spec.name ?? null,
    description: spec.description,
    title: spec.title ?? null,
    mimeType: spec.mimeType ?? null,
    handler: spec.handler as McpResourceDefinition["handler"],
  }
}

/**
 * Declares an MCP prompt — a reusable, parameterised message template that a
 * user picks explicitly (unlike tools, which the model chooses).
 *
 * The name comes from the filename unless `name` overrides it. A handler may
 * return a string, a message object, or an array of messages.
 */
export function prompt<S extends InputSchema | undefined = undefined, Result = unknown>(
  spec: McpPromptSpec<S, Result>,
): McpPromptDefinition {
  return {
    [KIND]: "mcpPrompt",
    name: spec.name ?? null,
    description: spec.description,
    title: spec.title ?? null,
    input: (spec.input ?? null) as InputSchema | null,
    handler: spec.handler as McpPromptDefinition["handler"],
  }
}
