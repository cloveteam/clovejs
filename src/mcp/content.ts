import { isHttpError } from "../errors.js"
import type { McpContent, McpPromptMessage } from "./types.js"

/**
 * Normalises whatever a tool handler returned into MCP content blocks.
 *
 * The rules mirror the JSON middleware for HTTP routes: return a value and it
 * is serialised for you, or return content blocks when you need control.
 */
export function toToolContent(result: unknown): McpContent[] {
  if (result === undefined || result === null) return []
  if (typeof result === "string") return [{ type: "text", text: result }]

  if (isContentBlock(result)) return [result]
  if (Array.isArray(result) && result.length > 0 && result.every(isContentBlock)) {
    return result
  }

  return [{ type: "text", text: stringify(result) }]
}

/**
 * Normalises a resource handler's return value into resource contents.
 *
 * Binary payloads (`Buffer`, `Uint8Array`, `ArrayBuffer`) become base64 blobs;
 * everything else becomes text, with objects serialised as JSON.
 */
export function toResourceContents(
  result: unknown,
  uri: string,
  declaredMimeType: string | null,
): Array<{ uri: string; mimeType?: string; text?: string; blob?: string }> {
  if (result === undefined || result === null) return []

  const binary = asBinary(result)
  if (binary) {
    return [
      {
        uri,
        mimeType: declaredMimeType ?? "application/octet-stream",
        blob: binary.toString("base64"),
      },
    ]
  }

  if (typeof result === "string") {
    return [{ uri, ...(declaredMimeType ? { mimeType: declaredMimeType } : {}), text: result }]
  }

  // An explicit `{ contents: [...] }` passes through untouched.
  if (
    typeof result === "object" &&
    Array.isArray((result as { contents?: unknown }).contents)
  ) {
    return (result as { contents: Array<Record<string, unknown>> }).contents.map(
      (entry) => ({ uri, ...entry }) as { uri: string },
    )
  }

  return [
    {
      uri,
      mimeType: declaredMimeType ?? "application/json",
      text: stringify(result),
    },
  ]
}

/** Normalises a prompt handler's return value into MCP prompt messages. */
export function toPromptMessages(
  result: unknown,
): Array<{ role: "user" | "assistant"; content: McpContent }> {
  if (result === undefined || result === null) return []

  if (typeof result === "string") {
    return [{ role: "user", content: { type: "text", text: result } }]
  }

  const list: unknown[] = Array.isArray(result) ? result : [result]
  const messages: Array<{ role: "user" | "assistant"; content: McpContent }> = []

  for (const entry of list) {
    if (typeof entry === "string") {
      messages.push({ role: "user", content: { type: "text", text: entry } })
      continue
    }
    if (!isPromptMessage(entry)) {
      messages.push({ role: "user", content: { type: "text", text: stringify(entry) } })
      continue
    }
    // A message may carry several content blocks; MCP transports one block per
    // message, so a multi-block message fans out into several.
    for (const content of toToolContent(entry.content)) {
      messages.push({ role: entry.role, content })
    }
  }
  return messages
}

/**
 * Splits a thrown value into a result the model can read and recover from,
 * versus a protocol-level failure the client should surface as an error.
 *
 * Client errors (4xx) are the model's problem — bad arguments, a missing
 * record — so they come back as a normal tool result flagged `isError`, which
 * lets the model correct itself. Server errors are ours, and become JSON-RPC
 * errors instead.
 */
export function isRecoverable(err: unknown): boolean {
  return isHttpError(err) && err.status >= 400 && err.status < 500
}

/** The message shown to the model for a recoverable error. */
export function errorText(err: unknown): string {
  if (isHttpError(err)) {
    const body = err.body
    if (typeof body === "string") return body
    if (body && typeof body === "object" && "message" in body) {
      return String((body as { message: unknown }).message)
    }
    return err.message
  }
  return err instanceof Error ? err.message : String(err)
}

function isContentBlock(value: unknown): value is McpContent {
  if (typeof value !== "object" || value === null) return false
  const type = (value as { type?: unknown }).type
  return (
    (type === "text" && typeof (value as { text?: unknown }).text === "string") ||
    (type === "image" && typeof (value as { data?: unknown }).data === "string")
  )
}

function isPromptMessage(value: unknown): value is McpPromptMessage {
  if (typeof value !== "object" || value === null) return false
  const role = (value as { role?: unknown }).role
  return (role === "user" || role === "assistant") && "content" in value
}

function asBinary(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  return null
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}
