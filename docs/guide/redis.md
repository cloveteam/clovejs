# Redis

`clovejs/bus/redis` ships two [message bus](/guide/message-bus) adapters, so the
one broker most projects already run does not need a hand-written one.

It changes nothing about the dependency story. CloveJS still ships no Redis
client and imports none: `redis` and `ioredis` are **optional peer
dependencies**, this is a separate entry point that core never touches, and a
project that does not import it never loads either package.

```sh
npm install redis      # or: npm install ioredis
```

## Which one

Redis is two brokers wearing one name, and they make opposite promises. Each
gets its own adapter, so neither has to lie in `capabilities`:

| | `redisStreams()` | `redisPubSub()` |
| --- | --- | --- |
| Backed by | streams + consumer groups | `PUBLISH` / `SUBSCRIBE` |
| Survives a restart | yes | no |
| Redelivers | yes, with a real backoff | never |
| `capabilities` | `{ retries: "delayed", patterns: false }` | `{ retries: "none", patterns: true }` |
| For | work that must not be lost | presence, live counters, cache busting |

Those declarations do real work. A consumer on the Pub/Sub bus that writes
`.retry({ attempts: 5 })` fails at boot rather than quietly never retrying, and
one on the Streams bus that asks for `pattern("orders.*")` fails too — there is
no `XREADGROUP` across a key pattern.

## A durable bus

```ts
// src/bus/events.ts
import { bus } from "clovejs/bus"
import { redisStreams } from "clovejs/bus/redis"

export default bus(redisStreams({ url: process.env.REDIS_URL! }))
```

Given `{ url }` the adapter loads whichever of `redis` and `ioredis` is
installed, owns the connection, and closes it on shutdown. Consumers are
ordinary consumers — nothing about them is Redis-specific:

```ts
// src/consumers/billing/orderCreated.ts
import { consume } from "clovejs/bus"
import { z } from "zod"

export default consume({
  bus: "events",
  channel: "orders.created",
  subscription: "billing",
  input: z.object({ orderId: z.string(), total: z.number() }),

  async handler({ orderId, total }, ctx) {
    await ctx.invoices.createForOrder(orderId, total)
  },
}).retry({ attempts: 5, backoff: { base: 250 } })
```

Requires **Redis 6.2 or later**, for `XPENDING … IDLE`.

### Bringing your own client

Pass a connected client instead when the app already has one, needs cluster or
TLS options, or wants one connection shared with everything else:

```ts
// src/bus/events.ts
import { bus } from "clovejs/bus"
import { redisStreams } from "clovejs/bus/redis"
import { createClient } from "redis"

export default bus(async (ctx, { onDestroy }) => {
  const client = createClient({ url: ctx.config.redisUrl })
  await client.connect()
  onDestroy(() => client.quit())

  return redisStreams(client, { maxLen: 100_000, maxDeliveries: 10 })
})
```

`ioredis` is a drop-in substitute — swap the import and nothing else changes.
The adapter reaches the client through one generic command call (`sendCommand`
on node-redis, `call` on ioredis) and `duplicate()`, so a cluster client or any
other wrapper with those two works as well.

### Options

| Option | Default | What it does |
| --- | --- | --- |
| `prefix` | `""` | Prepended to every key. Namespaces one Redis across apps |
| `maxLen` | none | `XADD … MAXLEN ~ n`. How acked entries are reclaimed |
| `deadLetter` | `"clove.dead"` | Stream rejected messages are copied to. `false` drops them |
| `maxDeliveries` | `10` | Hand-overs before a message is dead-lettered untried |
| `claimIdle` | `60_000` | How long a delivery may sit un-acked before another worker claims it |
| `sweepInterval` | `5_000` | How often the delay set and pending list are swept |
| `blockTimeout` | `5_000` | `XREADGROUP … BLOCK` |
| `retries` | `"delayed"` | `"immediate"` skips the delay set — and downgrades the declared capability |
| `consumer` | host-pid | This process's name inside every consumer group |

## A fire-and-forget bus

```ts
// src/bus/presence.ts
import { bus } from "clovejs/bus"
import { redisPubSub } from "clovejs/bus/redis"

export default bus(redisPubSub({ url: process.env.REDIS_URL! }))
```

Two buses in one project is the normal arrangement, and they are just two files:

```text
src/bus/
  events.ts      →  ctx.bus.events      (Redis Streams — durable)
  presence.ts    →  ctx.bus.presence    (Redis Pub/Sub — fire and forget)
```

**Patterns here are globs, not AMQP topics.** `PSUBSCRIBE` reads `*` as "any run
of characters" and `#` as an ordinary character, so `pattern("orders.#")` — legal
everywhere else, and routed correctly by `app.bus.dispatch()` in tests — would
match nothing at all in production. The adapter raises a boot error naming the
subscription and suggesting `pattern("orders.*")` rather than letting that
through.

**Headers have nowhere to ride.** Redis Pub/Sub has no header frame, so
publishing with `headers` throws instead of dropping them. Set
`redisPubSub(client, { envelope: true })` to wrap each message as
`{"d":payload,"h":headers}` — at the cost of a wire format both ends have to
agree on, where the bare payload is what an outside producer would send.

## How it maps

| CloveJS | Redis Streams |
| --- | --- |
| `channel` | the stream key, verbatim |
| `subscription` | the consumer group |
| `publish()` | `XADD` |
| `ack` | `XACK` |
| `retry` | `ZADD` to a delay set, then `XADD` to a private retry stream |
| `reject` | `XACK` plus a copy on the dead-letter stream |
| a delivery whose worker died | `XPENDING … IDLE` then `XCLAIM` |
| `maxInFlight` | `XREADGROUP COUNT` plus a local ceiling |

Three details are worth knowing, because each is a place a hand-written adapter
usually goes wrong.

**A retry goes to a private stream, never back to the channel.** One stream
commonly feeds several consumer groups. Re-`XADD`ing a failed message to
`orders.created` would hand a copy to *every* group bound to it, so billing's
retry would silently make email process the order a second time. Each
subscription gets `{orders.created}:billing:retry`, and its read loop takes both
streams in one `XREADGROUP`.

**A delayed retry is durable, not a timer.** Streams have no per-message delay,
and a `setTimeout` loses the message if the process dies. The redelivery is
written to a sorted set scored with the time it comes due, and only then is the
original acked; a sweep moves due entries into the retry stream inside a single
Lua call, so two replicas cannot both fire and a crash cannot drop one.

**Derived keys share the channel's cluster slot.** `XREADGROUP` cannot span
slots, so the retry and delay keys are tagged — `{orders.created}:billing:retry`
hashes on `orders.created`, exactly as the untagged stream key does. The channel
itself is never rewritten: it stays the key a producer outside this app would
`XADD` to.

## What Redis does not do

- **`options.key` is carried, not honored.** Redis has no partitions, so it
  reaches the consumer as `message.key` and orders nothing.
- **Ordering** is per stream, and a group with `maxInFlight > 1` or a second
  replica interleaves anyway.
- **A consumer group starts at `$`** — new messages only. To replay a stream
  from the beginning, create the group yourself with `XGROUP CREATE … 0` before
  the app boots; the adapter leaves an existing group alone.
- **Acked entries are not deleted.** `XACK` clears the pending list, and `XDEL`
  is not an option when a stream may feed several groups — set `maxLen` and let
  Redis trim.
- **Connections:** the shared client, plus one per subscription for the blocking
  read. A blocked `XREADGROUP` accepts nothing else, so acks and publishes go
  over the shared one.

## Developing without Redis

`memoryBus()` is still the right default for `clove dev` and for tests. Give it
the Streams adapter's answers so a capability mismatch surfaces locally instead
of in staging:

```ts
// src/bus/events.ts
import { bus, memoryBus } from "clovejs/bus"
import { redisStreams } from "clovejs/bus/redis"

export default bus(
  process.env.REDIS_URL
    ? redisStreams({ url: process.env.REDIS_URL })
    : memoryBus({ capabilities: { retries: "delayed", patterns: false } }),
)
```

`app.bus.published()` and `app.bus.dead()` read an in-memory bus and throw on a
real one — a broker connection has no record of what it published. `dispatch()`
and `app.bus.health()` work against either.

## See also

- [Message bus](/guide/message-bus) for consumers, retries, capabilities and
  writing an adapter of your own.
- [Sessions](/guide/sessions) and [Caching](/guide/caching), whose stores take a
  Redis connection too.
