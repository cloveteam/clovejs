import { readFileSync } from "node:fs"
import { join } from "node:path"

/** Files are read in this order; the first one to define a key wins. */
function candidates(mode: string): string[] {
  const files = [".env.local", ".env"]
  if (mode) files.unshift(`.env.${mode}.local`, `.env.${mode}`)
  // `.env.local` is for developer-specific overrides and has no place in tests,
  // where every run must see the same environment.
  return mode === "test" ? files.filter((f) => !f.endsWith(".local")) : files
}

export interface LoadEnvOptions {
  /** Directory the `.env` files are resolved against. */
  rootDir: string
  /** Selects the `.env.<mode>` variants. Defaults to `NODE_ENV`. */
  mode?: string
  /** Explicit file list, relative to `rootDir` or absolute. Skips the cascade. */
  files?: string[]
}

/**
 * Loads `.env` files into `process.env`.
 *
 * Variables already present in the real environment always win, so an exported
 * shell variable or a value injected by the deployment platform is never
 * clobbered by a file checked into the repo.
 *
 * Returns the keys that were actually applied.
 */
export function loadEnv(options: LoadEnvOptions): string[] {
  const mode = options.mode ?? process.env.NODE_ENV ?? ""
  const files = options.files ?? candidates(mode)
  const applied: string[] = []

  for (const file of files) {
    const contents = read(join(options.rootDir, file))
    if (contents === null) continue
    for (const [key, value] of Object.entries(parseEnv(contents))) {
      if (key in process.env) continue
      process.env[key] = value
      applied.push(key)
    }
  }

  return applied
}

function read(path: string): string | null {
  try {
    return readFileSync(path, "utf8")
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // A missing .env is the normal case; a directory named .env is not, but it
    // is still not worth failing a boot over.
    if (code === "ENOENT" || code === "EISDIR") return null
    throw err
  }
}

const LINE =
  /^\s*(?:export\s+)?([\w.-]+)\s*(?::=|[:=])\s*(?:"((?:\\.|[^"])*)"|'([^']*)'|`([^`]*)`|([^#\r\n]*?))\s*(?:#.*)?$/

/**
 * Parses dotenv syntax: `KEY=value`, optional `export` prefix, `#` comments,
 * and single, double or backtick quoting. Double-quoted values expand `\n`,
 * `\r`, `\t` and escaped quotes, and may span multiple lines.
 */
export function parseEnv(contents: string): Record<string, string> {
  const out: Record<string, string> = {}
  // Normalise newlines so a CRLF file does not leave `\r` on every value.
  const lines = contents.replace(/\r\n?/g, "\n").split("\n")

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!
    if (!line.trim() || line.trim().startsWith("#")) continue

    // A double-quoted value may run past the end of the line.
    const open = /^\s*(?:export\s+)?[\w.-]+\s*(?::=|[:=])\s*"(?:\\.|[^"\\])*$/
    while (open.test(line) && i + 1 < lines.length) line += "\n" + lines[++i]!

    const match = LINE.exec(line)
    if (!match) continue

    const [, key, double, single, backtick, bare] = match
    if (double !== undefined) out[key!] = unescape(double)
    else out[key!] = single ?? backtick ?? bare ?? ""
  }

  return out
}

function unescape(value: string): string {
  return value.replace(/\\([\\nrtbf"'`$])/g, (_, ch: string) => {
    switch (ch) {
      case "n":
        return "\n"
      case "r":
        return "\r"
      case "t":
        return "\t"
      case "b":
        return "\b"
      case "f":
        return "\f"
      default:
        return ch
    }
  })
}
