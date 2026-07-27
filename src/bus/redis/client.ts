/**
 * The seam between the Redis adapters and whichever client the project
 * installed.
 *
 * CloveJS ships no Redis client and imports none: `redis` and `ioredis` are
 * optional peer dependencies, present only in the app's own `package.json`.
 * What the adapters need is described structurally and reached through one
 * generic command call, so the same code drives node-redis, ioredis, a cluster
 * client, or anything else that can send a command and duplicate a connection.
 */

import { CloveBootError } from "../../errors.js"

/**
 * A method on a client this module did not write.
 *
 * Every signature is deliberately unstated. `redis` and `ioredis` disagree
 * about the argument types of methods with the same name — `sendCommand` takes
 * a string array on one and a `Command` object on the other — so declaring
 * either shape here would make the *other* client fail to type-check as a
 * `RedisLike` at the call site, which is a compile error about a library the
 * project chose. Narrowing happens once, at runtime, in {@link commandRunner}.
 */
type RedisMethod = (...args: never[]) => unknown

/**
 * The subset of a Redis client the adapters rely on.
 *
 * Every member is optional because the two mainstream clients disagree about
 * which of them exists — the shape is duck-typed at runtime by
 * {@link commandRunner}, which raises a boot error naming what it looked for
 * rather than failing on the first command.
 */
export interface RedisLike {
  /** ioredis: `call("XADD", key, …)`. */
  call?: RedisMethod
  /** node-redis: `sendCommand(["XADD", key, …])`. */
  sendCommand?: RedisMethod
  /** Both clients. Required: a blocking read needs a connection of its own. */
  duplicate?: () => RedisLike
  /** node-redis needs an explicit connect; ioredis dials on construction. */
  connect?: () => Promise<unknown>
  quit?: RedisMethod
  disconnect?: RedisMethod
  /** node-redis. */
  readonly isOpen?: boolean
  /** ioredis. */
  readonly status?: string
  // Pub/Sub only — the one place the two clients cannot be reached through a
  // generic command, because push messages arrive through their own dispatcher.
  /** Both clients, with different signatures. */
  subscribe?: RedisMethod
  /** node-redis. */
  pSubscribe?: RedisMethod
  /** ioredis. */
  psubscribe?: RedisMethod
  /** ioredis, which pushes every message through one event per kind. */
  on?: RedisMethod
}

/** Calls a duck-typed client method with arguments its own types never saw. */
export function invoke(
  client: RedisLike,
  method: keyof RedisLike,
  ...args: unknown[]
): unknown {
  const fn = client[method] as ((...a: unknown[]) => unknown) | undefined
  return fn?.call(client, ...args)
}

/** Sends one command and resolves with the raw reply. */
export type RedisCommand = (args: (string | number)[]) => Promise<unknown>

/**
 * Picks the generic command method the given client exposes.
 *
 * `call` is checked first because it identifies ioredis, whose `sendCommand`
 * takes a `Command` object rather than an argument array — calling that one
 * with an array of strings fails in a way that reads like a Redis error rather
 * than a client mismatch.
 */
export function commandRunner(client: RedisLike): RedisCommand {
  if (typeof client.call === "function") {
    return async (args) =>
      await invoke(client, "call", String(args[0]), ...args.slice(1).map(String))
  }
  if (typeof client.sendCommand === "function") {
    return async (args) => await invoke(client, "sendCommand", args.map(String))
  }
  throw new CloveBootError(
    "The value passed to a CloveJS Redis bus is not a Redis client: it has " +
      "neither `call()` (ioredis) nor `sendCommand()` (node-redis). Pass a " +
      "connected client, or pass `{ url }` and let the adapter create one.",
  )
}

/**
 * A second connection, for a command that monopolizes the one it runs on.
 *
 * `XREADGROUP … BLOCK` and `SUBSCRIBE` both hold their connection for as long
 * as they last, so every driver loop gets a duplicate and the shared client
 * stays free for the acks and publishes that happen while a read is blocked.
 */
export async function openConnection(client: RedisLike): Promise<RedisLike> {
  if (typeof client.duplicate !== "function") {
    throw new CloveBootError(
      "This Redis client has no duplicate(). A blocking read needs a " +
        "connection of its own, so the adapter cannot share the one it was " +
        "given.",
    )
  }
  const connection = client.duplicate()
  if (needsConnect(connection)) await connection.connect!()
  return connection
}

/**
 * node-redis hands back an unconnected duplicate; ioredis dials immediately,
 * and calling `connect()` on one that is already connecting throws. Both are
 * distinguished by the state field each exposes.
 */
function needsConnect(client: RedisLike): boolean {
  if (typeof client.connect !== "function") return false
  if (typeof client.isOpen === "boolean") return !client.isOpen
  // ioredis: "wait" is the lazyConnect idle state; anything else is in hand.
  if (typeof client.status === "string") return client.status === "wait"
  return false
}

/** Closes a connection this adapter opened, quietly. */
export async function closeConnection(client: RedisLike): Promise<void> {
  try {
    if (typeof client.quit === "function") await invoke(client, "quit")
    else if (typeof client.disconnect === "function") invoke(client, "disconnect")
  } catch {
    // A connection that is already gone is closed, which is what was asked for.
    // Anything else would fail a shutdown over a socket nobody needs again.
  }
}

/** Connection details for the form that creates the client itself. */
export interface RedisConnectionOptions {
  /** `redis://` or `rediss://`. */
  url: string
  /**
   * Which peer to load. Defaults to whichever of `redis` and `ioredis`
   * resolves, preferring `redis`.
   */
  client?: "redis" | "ioredis"
}

export function isConnectionOptions(
  value: RedisLike | RedisConnectionOptions,
): value is RedisConnectionOptions {
  return typeof (value as RedisConnectionOptions).url === "string"
}

/**
 * Loads the installed client and dials `url`.
 *
 * The import is dynamic and the specifier is held in a variable, so neither the
 * bundler nor a project that passes its own client ever resolves a package it
 * did not install.
 */
export async function connect(
  options: RedisConnectionOptions,
): Promise<RedisLike> {
  const wanted = options.client
  const order: Array<"redis" | "ioredis"> = wanted
    ? [wanted]
    : ["redis", "ioredis"]

  const tried: string[] = []
  for (const name of order) {
    const mod = await load(name)
    if (!mod) {
      tried.push(name)
      continue
    }
    return name === "redis"
      ? await dialNodeRedis(mod, options.url)
      : dialIoredis(mod, options.url)
  }

  throw new CloveBootError(
    `A Redis bus was given { url } but ${tried.map((n) => `"${n}"`).join(" and ")} ` +
      `${tried.length > 1 ? "are" : "is"} not installed. Install one — ` +
      "`npm install redis` or `npm install ioredis` — or construct the client " +
      "yourself and pass it in.",
  )
}

type Module = Record<string, unknown>

async function load(specifier: string): Promise<Module | null> {
  try {
    // Indirected through a parameter so the specifier is not a literal: these
    // are optional peers, and a bundler that saw the string would try to
    // resolve a package the project may never have installed.
    return (await import(specifier)) as Module
  } catch {
    return null
  }
}

async function dialNodeRedis(mod: Module, url: string): Promise<RedisLike> {
  const factory = pick(mod, "createClient") as
    | ((options: { url: string }) => RedisLike)
    | undefined
  if (typeof factory !== "function") {
    throw new CloveBootError('The "redis" package exports no createClient().')
  }
  const client = factory({ url })
  if (typeof client.connect === "function") await client.connect()
  return client
}

function dialIoredis(mod: Module, url: string): RedisLike {
  const Ctor = (pick(mod, "Redis") ?? mod.default ?? mod) as
    | (new (url: string) => RedisLike)
    | undefined
  if (typeof Ctor !== "function") {
    throw new CloveBootError('The "ioredis" package exports no Redis class.')
  }
  return new Ctor(url)
}

/** Reads a named export, looking through a CJS interop `default` wrapper. */
function pick(mod: Module, name: string): unknown {
  if (mod[name] !== undefined) return mod[name]
  const fallback = mod.default as Module | undefined
  return fallback?.[name]
}

/**
 * Narrows a reply to an array, treating a nil reply as empty.
 *
 * Deliberately `unknown[]`: the same command answers with nested arrays under
 * RESP2 and with objects under RESP3, and which one arrives depends on how the
 * project built its client rather than on anything visible from here.
 */
export function asArray(reply: unknown): unknown[] {
  if (reply === null || reply === undefined) return []
  return Array.isArray(reply) ? (reply as unknown[]) : []
}

/**
 * Replies arrive as strings from ioredis and as strings or Buffers from
 * node-redis depending on how the client was built, so every value is
 * normalized once on the way in.
 */
export function asString(reply: unknown): string {
  if (typeof reply === "string") return reply
  if (typeof reply === "number") return String(reply)
  if (reply instanceof Uint8Array) return Buffer.from(reply).toString("utf8")
  return String(reply)
}
