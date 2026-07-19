import { createHmac, timingSafeEqual } from "node:crypto"

export interface CookieOptions {
  domain?: string
  path?: string
  expires?: Date
  maxAge?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: "strict" | "lax" | "none"
  partitioned?: boolean
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(";")) {
    const eq = part.indexOf("=")
    if (eq < 0) continue
    const name = part.slice(0, eq).trim()
    if (!name || name in out) continue
    let value = part.slice(eq + 1).trim()
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    try {
      out[name] = decodeURIComponent(value)
    } catch {
      out[name] = value
    }
  }
  return out
}

export function serializeCookie(
  name: string,
  value: string,
  opts: CookieOptions = {},
): string {
  let str = `${name}=${encodeURIComponent(value)}`
  if (opts.domain) str += `; Domain=${opts.domain}`
  str += `; Path=${opts.path ?? "/"}`
  if (opts.expires) str += `; Expires=${opts.expires.toUTCString()}`
  if (opts.maxAge !== undefined) str += `; Max-Age=${Math.floor(opts.maxAge)}`
  if (opts.httpOnly) str += "; HttpOnly"
  if (opts.secure) str += "; Secure"
  if (opts.partitioned) str += "; Partitioned"
  if (opts.sameSite) {
    const v = opts.sameSite
    str += `; SameSite=${v.charAt(0).toUpperCase()}${v.slice(1)}`
  }
  return str
}

/** Appends an HMAC so the value can be verified as server-issued. */
export function sign(value: string, secret: string): string {
  const mac = createHmac("sha256", secret).update(value).digest("base64url")
  return `${value}.${mac}`
}

/** Returns the original value, or null when the signature does not verify. */
export function unsign(signed: string, secret: string): string | null {
  const idx = signed.lastIndexOf(".")
  if (idx < 0) return null
  const value = signed.slice(0, idx)
  const mac = signed.slice(idx + 1)
  const expected = createHmac("sha256", secret).update(value).digest("base64url")
  const a = Buffer.from(mac)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return null
  return timingSafeEqual(a, b) ? value : null
}
