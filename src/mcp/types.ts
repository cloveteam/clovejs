import type { IncomingMessage } from "node:http"
import { META, type Definition, type RuntimeCtx } from "../types.js"

/**
 * The subset of zod this module relies on.
 *
 * Typed structurally rather than imported, so projects that never write an MCP
 * tool do not need zod installed. The real types come back through the generic
 * parameters on `tool()` and friends.
 */
export interface SchemaLike<Output = unknown> {
  readonly _output?: Output
  parse(value: unknown): Output
}

/** A zod object schema, as produced by `z.object({...})`. */
export interface ObjectSchemaLike<Output = unknown> extends SchemaLike<Output> {
  readonly shape: Record<string, unknown>
}

/** Either `z.object({...})` or the bare `{ a: z.string() }` shape it wraps. */
export type InputSchema<Output = unknown> =
  | ObjectSchemaLike<Output>
  | Record<string, SchemaLike>

/** Infers the parsed argument type a handler receives from its input schema. */
export type InferInput<S> =
  S extends ObjectSchemaLike<infer O>
    ? O
    : S extends Record<string, SchemaLike>
      ? { [K in keyof S]: S[K] extends SchemaLike<infer O> ? O : never }
      : Record<string, never>

/**
 * Hints an MCP client may show to a user or model before running a tool.
 *
 * These are advisory: the protocol does not enforce them, and a client is free
 * to ignore them entirely. Enforce anything that matters in the handler.
 */
export interface McpToolAnnotations {
  /** The tool does not modify anything. */
  readOnly?: boolean
  /** The tool may perform irreversible updates. */
  destructive?: boolean
  /** Calling the tool twice with the same input has no extra effect. */
  idempotent?: boolean
  /** The tool touches systems outside this server. */
  openWorld?: boolean
}

export interface McpToolMeta extends McpToolAnnotations {
  [key: string]: unknown
}

/** Content a tool, resource or prompt handler may return. */
export interface McpTextContent {
  type: "text"
  text: string
}

export interface McpImageContent {
  type: "image"
  /** Base64-encoded image bytes. */
  data: string
  mimeType: string
}

export type McpContent = McpTextContent | McpImageContent

export interface McpToolArgs {
  ctx: RuntimeCtx
  /** The MCP session id, or null when the transport is stateless (stdio). */
  sessionId: string | null
  /**
   * The authenticated principal for this call, or null when the project
   * defines no `mcp/auth.ts`. When auth is configured the runtime rejects
   * unauthenticated requests before a handler runs, so inside a handler this
   * is non-null whenever auth is on.
   */
  auth: McpAuthInfo | null
  /** Aborts when the client cancels the call or disconnects. */
  signal: AbortSignal
  /** Emits a log message to the client, if it supports logging. */
  log(level: "debug" | "info" | "warning" | "error", message: string): void
}

export type McpToolHandler<Input, Result> = (
  input: Input,
  ctx: RuntimeCtx,
  args: McpToolArgs,
) => Result | Promise<Result>

export interface McpToolSpec<S extends InputSchema | undefined, Result> {
  /** Overrides the name derived from the filename. */
  name?: string
  /** Shown to the model. This is the main thing that decides when it is used. */
  description: string
  /** Human-facing label, when it should differ from the tool name. */
  title?: string
  input?: S
  handler: McpToolHandler<S extends InputSchema ? InferInput<S> : Record<string, never>, Result>
}

export interface McpToolDefinition extends Definition<"mcpTool"> {
  name: string | null
  description: string
  title: string | null
  input: InputSchema | null
  handler: StoredToolHandler
  /** Collected metadata. Read by the runtime, written by `.meta()`. */
  [META]: McpToolMeta
  /** Attach tool metadata and annotations. Chainable; merges with previous calls. */
  meta(meta: McpToolMeta): McpToolDefinition
}

export interface McpResourceArgs extends McpToolArgs {
  /** The fully resolved URI the client asked for. */
  uri: string
}

export type McpResourceHandler<Result> = (
  params: Record<string, string>,
  ctx: RuntimeCtx,
  args: McpResourceArgs,
) => Result | Promise<Result>

export interface McpResourceSpec<Result> {
  /** Overrides the URI derived from the file path. */
  uri?: string
  name?: string
  description: string
  title?: string
  mimeType?: string
  handler: McpResourceHandler<Result>
}

export interface McpResourceDefinition extends Definition<"mcpResource"> {
  uri: string | null
  name: string | null
  description: string
  title: string | null
  mimeType: string | null
  handler: McpResourceHandler<unknown>
}

export type McpPromptHandler<Input, Result> = (
  input: Input,
  ctx: RuntimeCtx,
  args: McpToolArgs,
) => Result | Promise<Result>

/**
 * The storage form of a handler once its concrete input schema has been erased.
 * The input is `any` rather than `unknown` on purpose: parameter contravariance
 * means a handler written against a specific schema is only assignable here when
 * the stored input type is `any`.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export type StoredToolHandler = McpToolHandler<any, unknown>
export type StoredPromptHandler = McpPromptHandler<any, unknown>
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface McpPromptSpec<S extends InputSchema | undefined, Result> {
  name?: string
  description: string
  title?: string
  input?: S
  handler: McpPromptHandler<
    S extends InputSchema ? InferInput<S> : Record<string, never>,
    Result
  >
}

export interface McpPromptDefinition extends Definition<"mcpPrompt"> {
  name: string | null
  description: string
  title: string | null
  input: InputSchema | null
  handler: StoredPromptHandler
}

/** A message in a prompt result. Plain strings are treated as user messages. */
export interface McpPromptMessage {
  role: "user" | "assistant"
  content: string | McpContent | McpContent[]
}

export type AnyMcpDefinition =
  | McpToolDefinition
  | McpResourceDefinition
  | McpPromptDefinition

/** A tool as registered by the scanner, with its resolved name and origin. */
export interface McpTool {
  name: string
  description: string
  title: string | null
  input: InputSchema | null
  /** The input schema normalised at boot, ready to hand to the MCP SDK. */
  shape: Record<string, unknown> | undefined
  handler: StoredToolHandler
  meta: Readonly<McpToolMeta>
  /** Absolute path of the file this tool came from. Used in error messages. */
  file: string
}

export interface McpResource {
  uri: string
  name: string
  description: string
  title: string | null
  mimeType: string | null
  handler: McpResourceHandler<unknown>
  file: string
}

export interface McpPrompt {
  name: string
  description: string
  title: string | null
  input: InputSchema | null
  /** The argument schema normalised and validated at boot. */
  shape: Record<string, unknown> | undefined
  handler: StoredPromptHandler
  file: string
}

/**
 * The authenticated principal a request carries, as returned by an
 * `mcp/auth.ts` handler and handed to every tool, resource and prompt.
 */
export interface McpAuthInfo {
  /** Stable identifier of the caller — typically the token's `sub` claim. */
  subject: string
  /**
   * The tenant this principal belongs to. The runtime binds an MCP session to
   * the tenant that opened it and rejects a later request whose token names a
   * different tenant, so one connection can never cross tenants.
   */
  tenant: string
  /** OAuth scopes granted to the token. Enforce per-tool as needed. */
  scopes: string[]
  /** The validated token claims, for anything the fields above do not cover. */
  claims: Record<string, unknown>
  /** The raw bearer token, in case a downstream call must forward it. */
  token: string
}

/** What an `authenticate` handler receives for one request. */
export interface McpAuthContext {
  /**
   * The root DI context, so the handler can reach singletons — a token
   * verifier, a JWKS client, configuration. Session- and request-scoped
   * values do not exist yet: authentication runs before either is created.
   */
  ctx: RuntimeCtx
  /** The raw HTTP request, for reading headers beyond the bearer token. */
  req: IncomingMessage
  /** The bearer token from the `Authorization` header, or null if absent. */
  token: string | null
  /**
   * The absolute URL this MCP server is reached at (e.g.
   * `https://api.example.com/mcp`). Use it as the expected token `aud`.
   */
  resource: string
}

/**
 * RFC 9728 protected-resource metadata. The runtime serves it at
 * `/.well-known/oauth-protected-resource` so a client can discover which
 * authorization server to obtain a token from.
 */
export interface McpProtectedResourceMetadata {
  /** Issuer URL(s) of the authorization server(s) that mint valid tokens. */
  authorizationServers: string[]
  /** Scopes this resource understands. Advertised to clients. */
  scopesSupported?: string[]
  /** Human-readable name of the protected resource. */
  resourceName?: string
  /** Any further RFC 9728 fields, emitted verbatim (snake_case). */
  [key: string]: unknown
}

export type McpAuthenticate = (ctx: McpAuthContext) => McpAuthInfo | Promise<McpAuthInfo>

/** What a `metadata` factory receives. An object so it can grow without breaking callers. */
export interface McpMetadataContext {
  /**
   * The root DI context. Unlike a plain `metadata` object — captured at module
   * load, before any container exists — a factory runs at boot with singletons
   * resolved, so it can read `ctx.config` and other providers.
   */
  ctx: RuntimeCtx
}

/**
 * The protected-resource metadata, or a factory that builds it from the root DI
 * context. The factory is invoked once, lazily, the first time the well-known
 * document is served, and its result is cached.
 */
export type McpMetadata =
  | McpProtectedResourceMetadata
  | ((ctx: McpMetadataContext) => McpProtectedResourceMetadata | Promise<McpProtectedResourceMetadata>)

export interface McpAuthSpec {
  metadata: McpMetadata
  /**
   * Validates the request and returns the authenticated principal. Throw
   * `error(401, ...)` for a missing or invalid token and `error(403, ...)`
   * for a valid token that lacks access; the runtime turns the former into a
   * `WWW-Authenticate` challenge and the latter into a plain rejection.
   */
  authenticate: McpAuthenticate
}

export interface McpAuthDefinition extends Definition<"mcpAuth"> {
  metadata: McpMetadata
  authenticate: McpAuthenticate
}

/** The auth handler as registered by the scanner, with its origin. */
export interface McpAuth {
  metadata: McpMetadata
  authenticate: McpAuthenticate
  file: string
}

/** Everything the scanner found under `mcp/`. */
export interface McpScan {
  tools: McpTool[]
  resources: McpResource[]
  prompts: McpPrompt[]
  /** The `mcp/auth.ts` handler, when the project defines one. */
  auth: McpAuth | null
}
