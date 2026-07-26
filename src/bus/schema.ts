import { CloveBootError } from "../errors.js"
import type {
  MessageSchema,
  SchemaLike,
  StandardIssue,
  StandardResult,
  StandardSchemaLike,
} from "./types.js"

/** Parses and returns the payload, or throws {@link MessageValidationError}. */
export type Validator = (payload: unknown) => unknown | Promise<unknown>

/**
 * A payload that did not match the consumer's `input`.
 *
 * Always terminal: the runtime turns it into `reject`, never `retry`, because a
 * payload that does not parse on attempt one will not parse on attempt two.
 */
export class MessageValidationError extends Error {
  readonly issues: readonly string[]

  constructor(issues: readonly string[]) {
    super(`Payload failed validation: ${issues.join("; ")}`)
    this.name = "MessageValidationError"
    this.issues = issues
  }
}

/**
 * Turns a declared `input` into a payload validator, or null when the consumer
 * declared none.
 *
 * Duck-typed exactly like `toRawShape` in `src/mcp/schema.ts`, so no schema
 * library is imported and zod stays an optional peer dependency. Note that this
 * cannot reuse `toRawShape`: that produces the raw *shape* the MCP SDK then
 * validates against, whereas a bus has no SDK behind it and must do the parsing
 * itself.
 *
 * Three forms are accepted, and anything else is a boot error naming the file:
 * a schema with `.parse`, a Standard Schema with `~standard`, and a plain
 * object whose every value is a schema.
 */
export function compileValidator(
  input: MessageSchema | null,
  file: string,
): Validator | null {
  if (input === null || input === undefined) return null

  if (typeof input !== "object" && typeof input !== "function") {
    throw new CloveBootError(
      "`input` must be a schema or an object of schemas, but it is " +
        `${typeof input}.`,
      [file],
    )
  }

  const standard = (input as StandardSchemaLike)["~standard"]
  if (standard && typeof standard.validate === "function") {
    return async (payload) => {
      const result = await standard.validate(payload)
      return unwrapStandard(result)
    }
  }

  if (typeof (input as SchemaLike).parse === "function") {
    return (payload) => (input as SchemaLike).parse(payload)
  }

  const entries = Object.entries(input as Record<string, unknown>)
  if (entries.length === 0) return null

  for (const [key, value] of entries) {
    if (!value || typeof (value as SchemaLike).parse !== "function") {
      throw new CloveBootError(
        `\`input.${key}\` is not a schema. Every field of a bare input object ` +
          `must be one, for example \`{ ${key}: z.string() }\`. Pass a whole ` +
          `schema (\`z.object({...})\`) if you meant to validate the payload as ` +
          `a unit.`,
        [file],
      )
    }
  }

  const shape = entries as Array<[string, SchemaLike]>
  return (payload) => {
    if (typeof payload !== "object" || payload === null) {
      throw new MessageValidationError([
        `expected an object payload, received ${payload === null ? "null" : typeof payload}`,
      ])
    }
    const source = payload as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [key, schema] of shape) {
      try {
        out[key] = schema.parse(source[key])
      } catch (err) {
        throw new MessageValidationError([`${key}: ${messageOf(err)}`])
      }
    }
    return out
  }
}

function unwrapStandard<T>(result: StandardResult<T>): T {
  if (result.issues === undefined) return result.value
  throw new MessageValidationError(
    result.issues.map((issue) => describeIssue(issue)),
  )
}

function describeIssue(issue: StandardIssue): string {
  const path = (issue.path ?? [])
    .map((segment) =>
      typeof segment === "object" && segment !== null && "key" in segment
        ? String(segment.key)
        : String(segment),
    )
    .join(".")
  return path ? `${path}: ${issue.message}` : issue.message
}

/**
 * Normalises whatever a schema library threw into a validation error, so the
 * runtime can tell "malformed payload" (reject) from "handler failed" (retry).
 */
export function asValidationError(err: unknown): MessageValidationError {
  if (err instanceof MessageValidationError) return err
  return new MessageValidationError([messageOf(err)])
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
