import { execFileSync } from "node:child_process"
import { existsSync, symlinkSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

/**
 * Fixture projects import "clovejs" the way a real project would, so they
 * resolve through node_modules to the built package. That means the build has
 * to exist and be current before the e2e suites run.
 */
export default function setup(): void {
  const link = join(root, "node_modules", "clovejs")
  if (!existsSync(link)) {
    mkdirSync(join(root, "node_modules"), { recursive: true })
    symlinkSync(root, link, "dir")
  }
  execFileSync("npx", ["tsup"], { cwd: root, stdio: "inherit" })
}
