import { pathToFileURL } from "node:url"
import { CloveBootError } from "../errors.js"

export interface ModuleLoader {
  load(absolutePath: string): Promise<unknown>
  /** Drops a module from the cache so the next load re-evaluates it. */
  invalidate(absolutePath: string): void
}

/**
 * Loads compiled JavaScript through native dynamic import.
 *
 * A cache-busting query is appended on reload, since the ESM module cache has
 * no eviction API.
 */
export function createNativeLoader(): ModuleLoader {
  const versions = new Map<string, number>()
  return {
    async load(absolutePath) {
      const version = versions.get(absolutePath)
      const url = pathToFileURL(absolutePath).href + (version ? `?v=${version}` : "")
      return await import(url)
    },
    invalidate(absolutePath) {
      versions.set(absolutePath, (versions.get(absolutePath) ?? 0) + 1)
    },
  }
}

/**
 * Loads TypeScript sources through jiti, so `clove dev` can run `src/`
 * directly with no build step.
 *
 * `moduleCache` must be false for the dev server: jiti's module cache is
 * process-global, so a new jiti instance still hands back the previously
 * evaluated module and edits would never take effect.
 */
export async function createJitiLoader(
  rootDir: string,
  moduleCache = true,
): Promise<ModuleLoader> {
  const { createJiti } = await import("jiti")
  let jiti = createJiti(rootDir, {
    moduleCache,
    // The on-disk transform cache is keyed by path, so it can hand back stale
    // output when a file is rewritten quickly. Off whenever caching is off.
    fsCache: moduleCache,
    interopDefault: false,
  })
  return {
    async load(absolutePath) {
      return await jiti.import(absolutePath)
    },
    invalidate() {
      jiti = createJiti(rootDir, {
    moduleCache,
    // The on-disk transform cache is keyed by path, so it can hand back stale
    // output when a file is rewritten quickly. Off whenever caching is off.
    fsCache: moduleCache,
    interopDefault: false,
  })
    },
  }
}

const TS_EXTENSIONS = /\.[cm]?tsx?$/

/**
 * Routes each file to the loader that can handle it: jiti for TypeScript,
 * native import for JavaScript.
 *
 * Deciding per file rather than per project means a mixed `.ts`/`.js` tree
 * works, and there is no guessing from the presence of a tsconfig.
 */
export async function createLoader(
  rootDir: string,
  options: { moduleCache?: boolean } = {},
): Promise<ModuleLoader> {
  const moduleCache = options.moduleCache ?? true
  const native = createNativeLoader()
  let jiti: ModuleLoader | undefined

  // Without a module cache, every load must also bust the ESM cache for plain
  // JavaScript, or the native loader would return the stale module too.
  if (!moduleCache) native.invalidate("")

  const forFile = async (path: string): Promise<ModuleLoader> => {
    if (!TS_EXTENSIONS.test(path)) {
      if (!moduleCache) native.invalidate(path)
      return native
    }
    jiti ??= await createJitiLoader(rootDir, moduleCache)
    return jiti
  }

  return {
    async load(absolutePath) {
      return (await forFile(absolutePath)).load(absolutePath)
    },
    invalidate(absolutePath) {
      native.invalidate(absolutePath)
      jiti?.invalidate(absolutePath)
    },
  }
}

/**
 * Imports a file and returns its default export, which is where every
 * convention directory expects to find a definition.
 */
export async function loadDefault(
  loader: ModuleLoader,
  absolutePath: string,
): Promise<unknown> {
  let mod: any
  try {
    mod = await loader.load(absolutePath)
  } catch (err) {
    throw new CloveBootError(
      `Failed to load module: ${(err as Error).message}`,
      [absolutePath],
    )
  }
  const value = mod?.default ?? mod?.module?.default
  if (value === undefined) {
    throw new CloveBootError(
      "File has no default export. Every file in a convention directory must " +
        "default-export a definition (get/post/service/di/middleware/ws).",
      [absolutePath],
    )
  }
  return value
}
