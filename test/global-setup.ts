import { execFileSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

/**
 * Fixture projects import "clovejs" the way a real project would, so they
 * resolve through node_modules to the built package. That means the build has
 * to exist and be current before the e2e suites run.
 */
export default function setup(): void {
  ensureSelfLink()
  execFileSync("npx", ["tsup"], { cwd: root, stdio: "inherit" })
}

/**
 * Points `node_modules/clovejs` at this checkout.
 *
 * The link is recreated when it is missing *or* wrong, because `npm install`
 * sees `"clovejs": "*"` in the example workspace and replaces it with a copy
 * fetched from the registry. Left alone, that stale copy is what the fixtures
 * would import, so the suite would quietly test a published version instead of
 * the working tree.
 */
function ensureSelfLink(): void {
  const link = join(root, "node_modules", "clovejs")

  if (existsSync(link)) {
    const stats = lstatSync(link)
    if (stats.isSymbolicLink() && realpathSync(link) === realpathSync(root)) return
    rmSync(link, { recursive: true, force: true })
  }

  mkdirSync(join(root, "node_modules"), { recursive: true })
  symlinkSync(root, link, "dir")
}
