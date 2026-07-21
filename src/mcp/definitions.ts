import { KIND, META } from "../types.js"
import type {
  InputSchema,
  McpAuthDefinition,
  McpAuthSpec,
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
 * Declares how this MCP server authenticates callers, turning it into an
 * OAuth 2.1 protected resource. Lives in `mcp/auth.ts`, one per project.
 *
 * The runtime enforces it on every request to the MCP endpoint: an
 * unauthenticated request is answered with `401` and a `WWW-Authenticate`
 * header, and the `metadata` is published at
 * `/.well-known/oauth-protected-resource` so a client can discover the
 * authorization server. The principal `authenticate` returns is handed to
 * every tool, resource and prompt as `args.auth`.
 *
 * `metadata` may be a plain object or a factory `({ ctx }) => metadata` — use
 * the factory when the document depends on DI-resolved values (e.g.
 * `ctx.config`), since a plain object is captured at module load, before any
 * container exists. The factory runs once, lazily, when the document is first
 * served.
 *
 * ```ts
 * export default mcpAuth({
 *   metadata: { authorizationServers: ["https://auth.example.com"] },
 *   async authenticate({ token, resource }) {
 *     if (!token) throw error(401, { message: "Missing bearer token" })
 *     const claims = await verify(token, { audience: resource })
 *     return { subject: claims.sub, tenant: claims.org, scopes: [], claims, token }
 *   },
 * })
 * ```
 */
export function mcpAuth(spec: McpAuthSpec): McpAuthDefinition {
  return {
    [KIND]: "mcpAuth",
    metadata: spec.metadata,
    authenticate: spec.authenticate,
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
