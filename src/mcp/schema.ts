import { CloveBootError } from "../errors.js"
import type { InputSchema } from "./types.js"

/**
 * Normalises a declared input schema to the raw shape the MCP SDK expects.
 *
 * `z.object({ a: z.string() })` and the bare `{ a: z.string() }` it wraps are
 * both accepted, because both read naturally in a definition and the
 * distinction is invisible to anyone who is not thinking about zod internals.
 */
export function toRawShape(
  input: InputSchema | null,
  file: string,
): Record<string, unknown> | undefined {
  if (input === null) return undefined

  if (typeof input !== "object") {
    throw new CloveBootError(
      `\`input\` must be a zod schema or an object of zod schemas, but it is ` +
        `${typeof input}.`,
      [file],
    )
  }

  // A z.object(...) carries its member schemas on `.shape`.
  const shape = (input as { shape?: unknown }).shape
  if (shape && typeof shape === "object") {
    return shape as Record<string, unknown>
  }

  if (typeof (input as { parse?: unknown }).parse === "function") {
    throw new CloveBootError(
      `\`input\` must be an object schema. Wrap the fields in z.object({...}) ` +
        `— a bare z.string() or z.array() cannot describe named tool arguments.`,
      [file],
    )
  }

  const entries = Object.entries(input as Record<string, unknown>)
  if (entries.length === 0) return undefined

  for (const [key, value] of entries) {
    if (!value || typeof (value as { parse?: unknown }).parse !== "function") {
      throw new CloveBootError(
        `\`input.${key}\` is not a zod schema. Every field of a bare input ` +
          `object must be one, for example \`{ ${key}: z.string() }\`.`,
        [file],
      )
    }
  }
  return input as Record<string, unknown>
}

/**
 * Coerces a raw shape to string-valued schemas, which is all MCP prompt
 * arguments can be: the protocol transports them as strings.
 */
export function assertPromptShape(
  shape: Record<string, unknown> | undefined,
  file: string,
): Record<string, unknown> | undefined {
  if (!shape) return undefined
  for (const [key, value] of Object.entries(shape)) {
    const typeName = zodTypeName(value)
    if (typeName && typeName !== "ZodString" && typeName !== "ZodOptional") {
      throw new CloveBootError(
        `Prompt argument "${key}" is a ${typeName}, but MCP transports prompt ` +
          `arguments as strings. Use z.string() and parse inside the handler.`,
        [file],
      )
    }
  }
  return shape
}

function zodTypeName(schema: unknown): string | null {
  const def = (schema as { _def?: { typeName?: unknown } } | null)?._def
  return typeof def?.typeName === "string" ? def.typeName : null
}
