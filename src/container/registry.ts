import { CloveBootError } from "../errors.js"
import type { Lifetime, LifecycleHooks, RuntimeCtx } from "../types.js"

export type ProviderKind = "service" | "di" | "builtin"

export interface Provider {
  key: string
  kind: ProviderKind
  lifetime: Lifetime
  /** Absolute file the provider came from, or a builtin marker. */
  file: string
  /** Present when the provider computes its value. */
  factory?: (ctx: RuntimeCtx, hooks: LifecycleHooks) => unknown
  /** Present when the provider is a plain literal value. */
  value?: unknown
  isFactory: boolean
}

/**
 * The set of everything injectable, keyed by the name it takes on `ctx`.
 *
 * Built once at boot from `services/` and `di/`, then treated as immutable by
 * the containers that read it.
 */
export class Registry {
  #providers = new Map<string, Provider>()

  add(provider: Provider): void {
    const existing = this.#providers.get(provider.key)
    if (existing && existing.kind !== "builtin") {
      throw new CloveBootError(
        `Duplicate context key "${provider.key}": two files both provide ` +
          `\`ctx.${provider.key}\`. Rename one of them.`,
        [existing.file, provider.file],
      )
    }
    this.#providers.set(provider.key, provider)
  }

  get(key: string): Provider | undefined {
    return this.#providers.get(key)
  }

  has(key: string): boolean {
    return this.#providers.has(key)
  }

  keys(): string[] {
    return [...this.#providers.keys()]
  }

  all(): Provider[] {
    return [...this.#providers.values()]
  }

  byLifetime(lifetime: Lifetime): Provider[] {
    return this.all().filter((p) => p.lifetime === lifetime)
  }
}
