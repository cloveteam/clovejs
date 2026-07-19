import { error } from "../errors.js"
import type { CloveResponse } from "../http/response.js"
import type { Route } from "../types.js"

/**
 * Decides whether the built-in JSON middleware should handle this response.
 *
 * It steps aside when the route opts out via `meta.json === false`, or when the
 * handler picked a non-JSON content type itself (`res.type("html")`).
 */
export function jsonEnabled(route: Route, res: CloveResponse): boolean {
  if (route.meta.json === false) return false
  if (res.typeIsExplicit) {
    const type = res.contentType ?? ""
    return type.includes("json")
  }
  return true
}

/**
 * Turns a handler's return value into a response.
 *
 * - an object, array or primitive is serialized as JSON
 * - `undefined` means "nothing to say" and becomes 204
 * - `null` from a GET means "not found" and becomes 404, per the concept
 */
export function applyJsonResult(
  result: unknown,
  route: Route,
  res: CloveResponse,
  method: string,
): void {
  if (res.sent) return

  if (result === undefined) {
    res.status(res.statusCode === 200 ? 204 : res.statusCode).end()
    return
  }

  if (result === null) {
    if (method === "GET") {
      throw error(404, { message: "Not Found" })
    }
    res.status(res.statusCode === 200 ? 204 : res.statusCode).end()
    return
  }

  res.json(result)
}
