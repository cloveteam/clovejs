/**
 * An in-process stand-in for the commands the Redis adapters issue.
 *
 * Not a Redis: it implements the streams, groups, sorted-set and pub/sub
 * commands `redisStreams()` and `redisPubSub()` actually send, with the
 * semantics those adapters depend on — pending-entry lists, delivery counts,
 * blocking reads, `MAXLEN` trimming. That is enough to exercise the parts worth
 * testing (where a retry goes, when a message is claimed, what gets acked) with
 * no server and no timers of its own.
 *
 * Two front ends share one store, because which of them a project has is
 * exactly what the adapter's command shim has to figure out:
 *
 * - {@link FakeNodeRedis} exposes `sendCommand(args)` and `isOpen`, as `redis`.
 * - {@link FakeIoredis} exposes `call(cmd, ...args)` and `status`, as `ioredis`.
 */

export interface FakeEntry {
  id: string
  fields: string[]
}

interface PendingEntry {
  consumer: string
  deliveredAt: number
  deliveries: number
}

interface Group {
  lastId: string
  pending: Map<string, PendingEntry>
}

type Listener = (...args: string[]) => void

interface Subscriber {
  selector: string
  pattern: boolean
  /** node-redis passes `(message, channel)`; ioredis emits `(channel, …)`. */
  deliver(channel: string, message: string): void
}

/** Everything the two front ends share. One "server". */
export class FakeRedisStore {
  streams = new Map<string, FakeEntry[]>()
  groups = new Map<string, Map<string, Group>>()
  zsets = new Map<string, Map<string, number>>()
  subscribers = new Set<Subscriber>()
  /** Every command executed, for assertions about what was *not* sent. */
  commands: string[][] = []

  #sequence = 0
  #waiters = new Set<() => void>()

  entries(stream: string): FakeEntry[] {
    return this.streams.get(stream) ?? []
  }

  fields(stream: string, index = 0): Record<string, string> {
    const entry = this.entries(stream)[index]
    if (!entry) return {}
    const fields: Record<string, string> = {}
    for (let i = 0; i + 1 < entry.fields.length; i += 2) {
      fields[entry.fields[i]!] = entry.fields[i + 1]!
    }
    return fields
  }

  pending(stream: string, group: string): Map<string, PendingEntry> {
    return this.groups.get(stream)?.get(group)?.pending ?? new Map()
  }

  /** Simulates another worker that read the message and then died. */
  async strand(
    stream: string,
    group: string,
    consumer = "gone",
    deliveries = 1,
    idleFor = 10_000,
  ): Promise<void> {
    await this.exec([
      "XREADGROUP",
      "GROUP",
      group,
      consumer,
      "COUNT",
      "100",
      "STREAMS",
      stream,
      ">",
    ])
    for (const entry of this.pending(stream, group).values()) {
      entry.deliveries = deliveries
      entry.deliveredAt = Date.now() - idleFor
    }
  }

  /** Runs one command. Every front end funnels into this. */
  async exec(args: (string | number)[]): Promise<unknown> {
    const argv = args.map(String)
    this.commands.push(argv)
    const command = argv[0]!.toUpperCase()

    switch (command) {
      case "XADD":
        return this.#xadd(argv)
      case "XGROUP":
        return this.#xgroup(argv)
      case "XREADGROUP":
        return await this.#xreadgroup(argv)
      case "XACK":
        return this.#xack(argv)
      case "XPENDING":
        return this.#xpending(argv)
      case "XCLAIM":
        return this.#xclaim(argv)
      case "XRANGE":
        return this.#xrange(argv)
      case "ZADD":
        return this.#zadd(argv)
      case "EVAL":
        return this.#eval(argv)
      case "PUBLISH":
        return this.#publish(argv)
      default:
        throw new Error(`FakeRedis does not implement ${command}`)
    }
  }

  subscribe(selector: string, pattern: boolean, deliver: Subscriber["deliver"]): Subscriber {
    const subscriber: Subscriber = { selector, pattern, deliver }
    this.subscribers.add(subscriber)
    return subscriber
  }

  /** Wakes every blocked read, as a closed connection does. */
  interrupt(): void {
    for (const wake of this.#waiters) wake()
    this.#waiters.clear()
  }

  #nextId(): string {
    return `${Date.now()}-${this.#sequence++}`
  }

  #xadd(argv: string[]): string {
    const stream = argv[1]!
    let i = 2
    let maxLen: number | undefined
    if (argv[i]?.toUpperCase() === "MAXLEN") {
      i += argv[i + 1] === "~" ? 2 : 1
      maxLen = Number(argv[i])
      i += 1
    }
    if (argv[i] !== "*") throw new Error("FakeRedis only supports XADD with *")
    const id = this.#nextId()

    const entries = this.streams.get(stream) ?? []
    entries.push({ id, fields: argv.slice(i + 1) })
    if (maxLen !== undefined && entries.length > maxLen) {
      entries.splice(0, entries.length - maxLen)
    }
    this.streams.set(stream, entries)
    this.interrupt()
    return id
  }

  #xgroup(argv: string[]): string {
    if (argv[1]?.toUpperCase() !== "CREATE") throw new Error("unsupported XGROUP")
    const stream = argv[2]!
    const name = argv[3]!
    if (argv.includes("MKSTREAM") && !this.streams.has(stream)) {
      this.streams.set(stream, [])
    }
    const groups = this.groups.get(stream) ?? new Map<string, Group>()
    if (groups.has(name)) {
      throw new Error(`BUSYGROUP Consumer Group name already exists`)
    }
    // "$" is the only start id the adapter uses: a new group sees new messages.
    const from = argv[4] === "0" ? "0-0" : (this.entries(stream).at(-1)?.id ?? "0-0")
    groups.set(name, { lastId: from, pending: new Map() })
    this.groups.set(stream, groups)
    return "OK"
  }

  async #xreadgroup(argv: string[]): Promise<unknown> {
    const group = argv[2]!
    const consumer = argv[3]!
    const count = optionValue(argv, "COUNT") ?? 10
    const block = optionValue(argv, "BLOCK")
    const at = argv.findIndex((a) => a.toUpperCase() === "STREAMS")
    const rest = argv.slice(at + 1)
    const streams = rest.slice(0, rest.length / 2)

    // Always give the event loop a turn, even when a message is already
    // waiting. A real read is I/O; resolving one purely on microtasks lets a
    // driver loop that never blocks starve every timer in the process, which
    // turns a test that should fail in two seconds into one that hangs.
    await this.#wait(0)

    const deadline = block === undefined ? 0 : Date.now() + block
    for (;;) {
      const reply = this.#drain(streams, group, consumer, count)
      if (reply.length > 0) return reply
      if (Date.now() >= deadline) return null
      await this.#wait(Math.min(5, Math.max(1, deadline - Date.now())))
    }
  }

  #drain(streams: string[], group: string, consumer: string, count: number): unknown[] {
    const reply: unknown[] = []
    let budget = count

    for (const stream of streams) {
      const state = this.groups.get(stream)?.get(group)
      if (!state || budget <= 0) continue

      const fresh = this.entries(stream).filter((e) => after(e.id, state.lastId))
      const taken = fresh.slice(0, budget)
      if (taken.length === 0) continue

      budget -= taken.length
      state.lastId = taken.at(-1)!.id
      for (const entry of taken) {
        state.pending.set(entry.id, {
          consumer,
          deliveredAt: Date.now(),
          deliveries: 1,
        })
      }
      reply.push([stream, taken.map((e) => [e.id, e.fields])])
    }
    return reply
  }

  #xack(argv: string[]): number {
    const pending = this.pending(argv[1]!, argv[2]!)
    let acked = 0
    for (const id of argv.slice(3)) if (pending.delete(id)) acked += 1
    return acked
  }

  #xpending(argv: string[]): unknown[] {
    const pending = this.pending(argv[1]!, argv[2]!)
    const idle = optionValue(argv, "IDLE") ?? 0
    const count = Number(argv.at(-1)) || 10
    const now = Date.now()

    const rows: unknown[] = []
    for (const [id, entry] of pending) {
      const age = now - entry.deliveredAt
      if (age < idle) continue
      rows.push([id, entry.consumer, String(age), String(entry.deliveries)])
      if (rows.length >= count) break
    }
    return rows
  }

  #xclaim(argv: string[]): unknown[] {
    const stream = argv[1]!
    const pending = this.pending(stream, argv[2]!)
    const consumer = argv[3]!
    const minIdle = Number(argv[4])
    const claimed: unknown[] = []

    for (const id of argv.slice(5)) {
      const entry = pending.get(id)
      if (!entry || Date.now() - entry.deliveredAt < minIdle) continue
      entry.consumer = consumer
      entry.deliveredAt = Date.now()
      entry.deliveries += 1
      const stored = this.entries(stream).find((e) => e.id === id)
      if (stored) claimed.push([stored.id, stored.fields])
    }
    return claimed
  }

  #xrange(argv: string[]): unknown[] {
    const [, stream, start, end] = argv
    return this.entries(stream!)
      .filter((e) => !after(start!, e.id) && !after(e.id, end!))
      .map((e) => [e.id, e.fields])
  }

  #zadd(argv: string[]): number {
    const set = this.zsets.get(argv[1]!) ?? new Map<string, number>()
    set.set(argv[3]!, Number(argv[2]))
    this.zsets.set(argv[1]!, set)
    return 1
  }

  /**
   * Stands in for the sweep script rather than running Lua: it recognises the
   * one script the adapter sends and performs the same effect.
   */
  #eval(argv: string[]): number {
    const script = argv[1]!
    if (!/ZRANGEBYSCORE/.test(script) || !/XADD/.test(script)) {
      throw new Error("FakeRedis does not implement this script")
    }
    const delayed = argv[3]!
    const retry = argv[4]!
    const now = Number(argv[5])
    const limit = Number(argv[6])

    const set = this.zsets.get(delayed)
    if (!set) return 0

    let moved = 0
    for (const [member, score] of [...set].sort((a, b) => a[1] - b[1])) {
      if (score > now || moved >= limit) break
      this.#xadd(["XADD", retry, "*", ...(JSON.parse(member) as string[])])
      set.delete(member)
      moved += 1
    }
    return moved
  }

  #publish(argv: string[]): number {
    const [, channel, message] = argv
    let received = 0
    for (const subscriber of this.subscribers) {
      const selects = subscriber.pattern
        ? glob(subscriber.selector, channel!)
        : subscriber.selector === channel
      if (!selects) continue
      received += 1
      subscriber.deliver(channel!, message!)
    }
    return received
  }

  #wait(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const waiters = this.#waiters
      const timer = setTimeout(done, ms)
      function done(): void {
        clearTimeout(timer)
        waiters.delete(done)
        resolve()
      }
      waiters.add(done)
    })
  }
}

/** A `redis`-shaped client: `sendCommand(argv)`, explicit `connect()`. */
export class FakeNodeRedis {
  isOpen = true
  readonly store: FakeRedisStore
  #subscriber: Subscriber | null = null

  constructor(store = new FakeRedisStore()) {
    this.store = store
  }

  async sendCommand(args: string[]): Promise<unknown> {
    if (!this.isOpen) throw new Error("The client is closed")
    return await this.store.exec(args)
  }

  duplicate(): FakeNodeRedis {
    const copy = new FakeNodeRedis(this.store)
    copy.isOpen = false
    return copy
  }

  async connect(): Promise<void> {
    this.isOpen = true
  }

  async quit(): Promise<void> {
    this.isOpen = false
    if (this.#subscriber) this.store.subscribers.delete(this.#subscriber)
    this.store.interrupt()
  }

  async subscribe(channel: string, listener: Listener): Promise<void> {
    this.#listen(channel, false, listener)
  }

  async pSubscribe(selector: string, listener: Listener): Promise<void> {
    this.#listen(selector, true, listener)
  }

  #listen(selector: string, pattern: boolean, listener: Listener): void {
    this.#subscriber = this.store.subscribe(selector, pattern, (channel, message) =>
      // node-redis calls the listener with the message first.
      listener(message, channel),
    )
  }
}

/** An `ioredis`-shaped client: `call(cmd, …)`, events for pushed messages. */
export class FakeIoredis {
  status = "ready"
  readonly store: FakeRedisStore
  #listeners = new Map<string, Listener[]>()
  #subscriber: Subscriber | null = null

  constructor(store = new FakeRedisStore()) {
    this.store = store
  }

  async call(command: string, ...args: string[]): Promise<unknown> {
    if (this.status === "end") throw new Error("Connection is closed")
    return await this.store.exec([command, ...args])
  }

  duplicate(): FakeIoredis {
    return new FakeIoredis(this.store)
  }

  disconnect(): void {
    this.status = "end"
    if (this.#subscriber) this.store.subscribers.delete(this.#subscriber)
    this.store.interrupt()
  }

  on(event: string, listener: Listener): this {
    const listeners = this.#listeners.get(event) ?? []
    listeners.push(listener)
    this.#listeners.set(event, listeners)
    return this
  }

  async subscribe(channel: string): Promise<void> {
    this.#subscriber = this.store.subscribe(channel, false, (ch, message) => {
      for (const listener of this.#listeners.get("message") ?? []) listener(ch, message)
    })
  }

  async psubscribe(selector: string): Promise<void> {
    this.#subscriber = this.store.subscribe(selector, true, (ch, message) => {
      for (const listener of this.#listeners.get("pmessage") ?? []) {
        listener(selector, ch, message)
      }
    })
  }
}

/** `<ms>-<seq>` ordering, as Redis compares stream ids. */
function after(a: string, b: string): boolean {
  const [ams, aseq] = a.split("-").map(Number) as [number, number]
  const [bms, bseq] = b.split("-").map(Number) as [number, number]
  return ams === bms ? aseq > bseq : ams > bms
}

function optionValue(argv: string[], name: string): number | undefined {
  const at = argv.findIndex((a) => a.toUpperCase() === name)
  return at === -1 ? undefined : Number(argv[at + 1])
}

/** Redis glob matching, enough of it for `*` and `?`. */
function glob(selector: string, value: string): boolean {
  const source = selector.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`^${source.replace(/\*/g, ".*").replace(/\?/g, ".")}$`).test(value)
}
