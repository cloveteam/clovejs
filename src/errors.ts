/**
 * Brands HTTP errors so they are recognised across module copies.
 *
 * `instanceof` is not enough: a project can end up with more than one copy of
 * the framework loaded (ESM alongside CJS, or a hoisting miss), and an error
 * thrown by one copy must still be rendered by the other.
 */
export const HTTP_ERROR = Symbol.for("clovejs.HttpError")

/**
 * An HTTP error that the pipeline renders into a response instead of a 500.
 * Anything else thrown from a handler is treated as an unexpected failure.
 */
export class HttpError extends Error {
  readonly status: number
  readonly body: unknown
  readonly expose = true;
  readonly [HTTP_ERROR] = true

  constructor(status: number, body?: unknown) {
    const message =
      typeof body === "object" && body !== null && "message" in body
        ? String((body as { message: unknown }).message)
        : typeof body === "string"
          ? body
          : `HTTP ${status}`
    super(message)
    this.name = "HttpError"
    this.status = status
    this.body = body === undefined ? { message } : body
  }
}

/**
 * Creates an HTTP error to throw from a handler, middleware or service.
 *
 * ```ts
 * throw error(400, { message: "username and password are required" })
 * ```
 */
export function error(status: number, body?: unknown): HttpError {
  return new HttpError(status, body)
}

export function isHttpError(value: unknown): value is HttpError {
  return (
    value instanceof HttpError ||
    (typeof value === "object" &&
      value !== null &&
      (value as Record<PropertyKey, unknown>)[HTTP_ERROR] === true)
  )
}

/**
 * A failure detected while scanning and validating the project, before the
 * server starts. These always name the offending file so the user can act.
 */
export class CloveBootError extends Error {
  readonly files: string[]

  constructor(message: string, files: string[] = []) {
    super(files.length ? `${message}\n${files.map((f) => `  - ${f}`).join("\n")}` : message)
    this.name = "CloveBootError"
    this.files = files
  }
}
