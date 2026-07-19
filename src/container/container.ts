import type { Lifetime, LifecycleHooks, RuntimeCtx } from "../types.js"
import type { Provider, Registry } from "./registry.js"

const SCOPE_DEPTH: Record<Lifetime, number> = {
  singleton: 0,
  session: 1,
  request: 2,
}

export class CircularDependencyError extends Error {
  constructor(chain: string[]) {
    super(`Circular dependency detected: ${chain.join(" -> ")}`)
    this.name = "CircularDependencyError"
  }
}

/**
 * One lifetime scope's worth of resolved dependencies.
 *
 * Containers form a chain — request -> session -> singleton — and a provider is
 * always resolved and cached in the container matching its declared lifetime,
 * no matter which container the lookup started from.
 */
export class Container {
  readonly scope: Lifetime
  readonly parent?: Container
  readonly registry: Registry

  #values = new Map<string, unknown>()
  #pending = new Map<string, Promise<unknown>>()
  #destroyHooks: Array<() => void | Promise<void>> = []
  #resolving: string[] = []
  #ctx?: RuntimeCtx
  #disposed = false

  constructor(registry: Registry, scope: Lifetime, parent?: Container) {
    this.registry = registry
    this.scope = scope
    this.parent = parent
  }

  /** The proxy handed to handlers, middlewares and factories as `ctx`. */
  get ctx(): RuntimeCtx {
    this.#ctx ??= createCtxProxy(this)
    return this.#ctx
  }

  createChild(scope: Lifetime): Container {
    return new Container(this.registry, scope, this)
  }

  /** Walks up to the container that owns the given lifetime. */
  containerFor(lifetime: Lifetime): Container {
    let node: Container = this
    while (SCOPE_DEPTH[node.scope] > SCOPE_DEPTH[lifetime] && node.parent) {
      node = node.parent
    }
    return node
  }

  /**
   * Looks up a key across the scope chain.
   *
   * Returns the cached value when it is already resolved, a promise when a
   * factory has to run, or `undefined` when nothing provides the key.
   */
  get(key: string): unknown {
    // Imperatively-set values and already-resolved providers, nearest scope first.
    for (let node: Container | undefined = this; node; node = node.parent) {
      if (node.#values.has(key)) return node.#values.get(key)
    }

    const provider = this.registry.get(key)
    if (!provider) return undefined

    const owner = this.containerFor(provider.lifetime)
    return owner.#resolve(provider)
  }

  /**
   * Assigns a value, e.g. `ctx.user = ...` from a middleware.
   *
   * The target scope comes from the provider declaration when one exists;
   * undeclared keys land in the current scope.
   */
  set(key: string, value: unknown): void {
    const provider = this.registry.get(key)
    const owner = provider ? this.containerFor(provider.lifetime) : this
    owner.#values.set(key, value)
    owner.#pending.delete(key)
  }

  has(key: string): boolean {
    for (let node: Container | undefined = this; node; node = node.parent) {
      if (node.#values.has(key)) return true
    }
    return this.registry.has(key)
  }

  /** True when the key already has a value and access will not return a promise. */
  isResolved(key: string): boolean {
    for (let node: Container | undefined = this; node; node = node.parent) {
      if (node.#values.has(key)) return true
    }
    return false
  }

  /** Resolves a provider inside this container, memoizing the result. */
  #resolve(provider: Provider): unknown {
    if (this.#values.has(provider.key)) return this.#values.get(provider.key)

    const pending = this.#pending.get(provider.key)
    if (pending) return pending

    if (!provider.isFactory) {
      this.#values.set(provider.key, provider.value)
      return provider.value
    }

    if (this.#resolving.includes(provider.key)) {
      throw new CircularDependencyError([...this.#resolving, provider.key])
    }

    const hooks: LifecycleHooks = {
      onDestroy: (fn) => this.#destroyHooks.push(fn),
    }

    this.#resolving.push(provider.key)
    let result: unknown
    try {
      result = provider.factory!(this.ctx, hooks)
    } finally {
      this.#resolving.pop()
    }

    if (isPromiseLike(result)) {
      const promise = Promise.resolve(result).then(
        (value) => {
          this.#values.set(provider.key, value)
          this.#pending.delete(provider.key)
          return value
        },
        (err) => {
          this.#pending.delete(provider.key)
          throw err
        },
      )
      this.#pending.set(provider.key, promise)
      return promise
    }

    this.#values.set(provider.key, result)
    return result
  }

  /** Resolves a provider and awaits it. Used at boot and by `ensure()`. */
  async resolveAsync(key: string): Promise<unknown> {
    return await this.get(key)
  }

  /**
   * Forces the given keys (default: everything owned by this scope) to resolve
   * so later synchronous `ctx.x` access never yields a promise.
   */
  async ensure(keys?: string[]): Promise<void> {
    const targets =
      keys ?? this.registry.byLifetime(this.scope).map((p) => p.key)
    for (const key of targets) {
      await this.resolveAsync(key)
    }
  }

  registerDestroyHook(fn: () => void | Promise<void>): void {
    this.#destroyHooks.push(fn)
  }

  get disposed(): boolean {
    return this.#disposed
  }

  /**
   * Runs this scope's `onDestroy` hooks in reverse registration order, so
   * dependents tear down before their dependencies.
   */
  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true

    // Let in-flight factory resolutions settle so their hooks are registered.
    await Promise.allSettled([...this.#pending.values()])

    const hooks = this.#destroyHooks.splice(0).reverse()
    const errors: unknown[] = []
    for (const hook of hooks) {
      try {
        await hook()
      } catch (err) {
        errors.push(err)
      }
    }
    this.#values.clear()
    this.#pending.clear()

    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) {
      throw new AggregateError(errors, "Errors thrown while disposing scope")
    }
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === "function"
  )
}

function createCtxProxy(container: Container): RuntimeCtx {
  return new Proxy(Object.create(null) as RuntimeCtx, {
    get(_target, prop) {
      if (typeof prop === "symbol") return undefined
      return container.get(prop)
    },
    set(_target, prop, value) {
      if (typeof prop === "symbol") return false
      container.set(prop, value)
      return true
    },
    has(_target, prop) {
      if (typeof prop === "symbol") return false
      return container.has(prop)
    },
    deleteProperty() {
      return false
    },
    ownKeys() {
      return container.registry.keys()
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (typeof prop === "symbol") return undefined
      if (!container.has(prop)) return undefined
      return { enumerable: true, configurable: true, value: container.get(prop) }
    },
  })
}
