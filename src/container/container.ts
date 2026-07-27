import type { Lifetime, LifecycleHooks, RuntimeCtx, Trigger } from "../types.js"
import type { Provider, Registry } from "./registry.js"

/** How deep each scope sits in the container chain. */
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
 * Raised when an isolated scope is asked for a lifetime it has no parent for.
 *
 * Without isolation the lookup would silently walk past the missing scope and
 * resolve into the singleton root, where the value would then be cached for the
 * lifetime of the process — a session-scoped value leaking from one unit of
 * work into every later one.
 */
export class ScopeUnavailableError extends Error {
  readonly key: string
  readonly lifetime: Lifetime

  constructor(key: string, lifetime: Lifetime, scope: Lifetime) {
    super(
      `Cannot resolve "${key}": it is declared with lifetime "${lifetime}", but ` +
        `this ${scope} scope has no ${lifetime} parent. ` +
        WHERE_AVAILABLE[lifetime],
    )
    this.name = "ScopeUnavailableError"
    this.key = key
    this.lifetime = lifetime
  }
}

/** Where each lifetime does resolve, since the error is usually a wrong file. */
const WHERE_AVAILABLE: Record<Lifetime, string> = {
  singleton: "Singleton values resolve everywhere; this should not happen.",
  session:
    "Session values need a visitor, so they resolve under an HTTP request and " +
    "nowhere else — not in a message delivery, which has no session.",
  request:
    "Request values resolve under an HTTP request, a socket, an MCP call or a " +
    "message delivery.",
}

export interface ChildScopeOptions {
  /**
   * Refuse to resolve lifetimes that are missing from this chain, instead of
   * falling back to the nearest outer scope. Used for message deliveries and
   * socket connections, which are request-shaped but have no session.
   */
  isolated?: boolean
  /**
   * What opened this scope. Surfaced to factories resolving in it (and in its
   * children) as `trigger` on their second argument.
   */
  trigger?: Trigger
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
  #isolated = false
  #trigger?: Trigger

  constructor(
    registry: Registry,
    scope: Lifetime,
    parent?: Container,
    options: ChildScopeOptions = {},
  ) {
    this.registry = registry
    this.scope = scope
    this.parent = parent
    this.#isolated = options.isolated ?? false
    this.#trigger = options.trigger
  }

  /** True when missing lifetimes throw rather than resolving into an outer scope. */
  get isolated(): boolean {
    return this.#isolated
  }

  /**
   * What opened the nearest scope in this chain that declared one, or undefined
   * in the singleton root, where there is no unit of work at all.
   */
  get trigger(): Trigger | undefined {
    for (let node: Container | undefined = this; node; node = node.parent) {
      if (node.#trigger) return node.#trigger
    }
    return undefined
  }

  /** The proxy handed to handlers, middlewares and factories as `ctx`. */
  get ctx(): RuntimeCtx {
    this.#ctx ??= createCtxProxy(this)
    return this.#ctx
  }

  createChild(scope: Lifetime, options: ChildScopeOptions = {}): Container {
    return new Container(this.registry, scope, this, options)
  }

  /** True when this scope is the right home for values of that lifetime. */
  owns(lifetime: Lifetime): boolean {
    return this.scope === lifetime
  }

  /**
   * Walks up towards the container that owns the given lifetime, stopping where
   * the chain runs out of wider scopes — `#ownerFor` decides whether a miss is
   * a fallback or an error.
   */
  containerFor(lifetime: Lifetime): Container {
    let node: Container = this
    while (
      !node.owns(lifetime) &&
      node.parent &&
      SCOPE_DEPTH[node.scope] > SCOPE_DEPTH[lifetime]
    ) {
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

    return this.#ownerFor(provider).#resolve(provider)
  }

  /**
   * The container a provider belongs in, refusing to fall back to an outer
   * scope when this one is isolated.
   */
  #ownerFor(provider: Provider): Container {
    const owner = this.containerFor(provider.lifetime)
    if (owner.owns(provider.lifetime)) return owner

    // Nothing in this chain owns the lifetime. An isolated scope refuses rather
    // than caching a narrow value in a wide parent — a session value resolved
    // during a message delivery would land in the singleton root and live for
    // the rest of the process.
    if (this.#isolated) {
      throw new ScopeUnavailableError(provider.key, provider.lifetime, this.scope)
    }
    return owner
  }

  /**
   * Assigns a value, e.g. `ctx.user = ...` from a middleware.
   *
   * The target scope comes from the provider declaration when one exists;
   * undeclared keys land in the current scope.
   */
  set(key: string, value: unknown): void {
    const provider = this.registry.get(key)
    const owner = provider ? this.#ownerFor(provider) : this
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
      trigger: this.trigger,
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
    const targets = keys ?? this.registry.keysOwnedBy(this.scope)
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
