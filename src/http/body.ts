import type { IncomingMessage } from "node:http"
import { error } from "../errors.js"

export const DEFAULT_BODY_LIMIT = 1024 * 1024 // 1 MiB

export async function readRawBody(
  req: IncomingMessage,
  limit = DEFAULT_BODY_LIMIT,
): Promise<Buffer> {
  const declared = req.headers["content-length"]
  if (declared && Number(declared) > limit) {
    throw error(413, { message: "Payload too large" })
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size > limit) throw error(413, { message: "Payload too large" })
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

/**
 * Parses the request body according to its content type. Unknown types are
 * left as a Buffer so handlers can deal with them however they like.
 */
export async function parseBody(
  req: IncomingMessage,
  limit = DEFAULT_BODY_LIMIT,
): Promise<unknown> {
  const method = req.method?.toUpperCase()
  if (method === "GET" || method === "HEAD") return undefined

  const raw = await readRawBody(req, limit)
  if (raw.length === 0) return undefined

  const type = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase()

  if (!type || type === "application/json" || type.endsWith("+json")) {
    try {
      return JSON.parse(raw.toString("utf8"))
    } catch {
      throw error(400, { message: "Invalid JSON body" })
    }
  }
  if (type === "application/x-www-form-urlencoded") {
    return Object.fromEntries(new URLSearchParams(raw.toString("utf8")))
  }
  if (type.startsWith("text/")) {
    return raw.toString("utf8")
  }
  return raw
}
