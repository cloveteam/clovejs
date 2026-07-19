import { readdir } from "node:fs/promises"
import { join, relative, sep } from "node:path"

export const SOURCE_EXTENSIONS = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]

const IGNORED_DIRS = new Set(["node_modules", ".git", ".clove", "dist", "build"])

/** A source file found under one of the convention directories. */
export interface WalkedFile {
  /** Absolute path on disk. */
  absolute: string
  /** Path relative to the scanned root, with forward slashes. */
  relative: string
}

/**
 * Recursively collects source files under `root`. Returns an empty array when
 * the directory does not exist, since every convention directory is optional.
 */
export async function walkDir(root: string): Promise<WalkedFile[]> {
  const out: WalkedFile[] = []

  async function visit(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return
      throw err
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue
        await visit(full)
      } else if (entry.isFile() && isSourceFile(entry.name)) {
        out.push({ absolute: full, relative: relative(root, full).split(sep).join("/") })
      }
    }
  }

  await visit(root)
  return out.sort((a, b) => a.relative.localeCompare(b.relative))
}

export function isSourceFile(name: string): boolean {
  if (name.endsWith(".d.ts")) return false
  if (/\.(test|spec)\.[cm]?[jt]s$/.test(name)) return false
  return SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext))
}

/** Strips a recognised source extension from a path. */
export function stripExtension(path: string): string {
  for (const ext of SOURCE_EXTENSIONS) {
    if (path.endsWith(ext)) return path.slice(0, -ext.length)
  }
  return path
}
