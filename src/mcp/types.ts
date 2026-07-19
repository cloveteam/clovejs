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
  handler: McpToolHandler<any, unknown>
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
  handler: McpPromptHandler<any, unknown>
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
  handler: McpToolHandler<any, unknown>
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
  handler: McpPromptHandler<any, unknown>
  file: string
}

/** Everything the scanner found under `mcp/`. */
export interface McpScan {
  tools: McpTool[]
  resources: McpResource[]
  prompts: McpPrompt[]
}
