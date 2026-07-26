# Message bus

Files in `bus/` declare connections to brokers. Files in `consumers/` handle the
messages that arrive on them.

CloveJS ships no broker client and adds no runtime dependency. It understands
consumers and the delivery lifecycle — validation, scopes, ack, retry, reject —
and nothing about RabbitMQ, Kafka, SQS, NATS or Redis. You install the SDK you
want and adapt it in one file.

Everything here comes from `clovejs/bus`, not the core barrel:

```ts
import { bus, consume, reject, memoryBus } from "clovejs/bus"
```

## A first bus

`bus/` is a directory, one file per connection. The filename becomes the name
everything else addresses it by:

```ts
// src/bus/events.ts
import { bus, memoryBus } from "clovejs/bus"

export default bus(memoryBus())
```

`memoryBus()` is an in-process implementation for development, tests and
single-process deployments — the analogue of the
[`MemoryCacheStore`](/guide/caching). It answers `true` to all five
capabilities, so an app developed against it behaves the same way once a real
broker adapter replaces it: wildcards expand, attempt counts are accurate, retry
delays are actually waited out, and `publish()` resolves only once every matching
consumer has the message queued.

What it does not do is outlive the process. Messages live in memory, nothing is
persisted, and nothing crosses to a second instance — so it is the right default
for `clove dev` and the wrong one for anything horizontally scaled.

## A first consumer

```ts
// src/consumers/billing/orderCreated.ts
import { consume, reject } from "clovejs/bus"
import { z } from "zod"

export default consume({
  bus: "events",
  channel: "orders.created",
  subscription: "billing",
  input: z.object({ orderId: z.string(), total: z.number() }),

  async handler({ orderId, total }, ctx, message) {
    if (total < 0) throw reject(`negative total on ${orderId}`)
    await ctx.invoices.createForOrder(orderId, total)
    await ctx.bus.events.publish("invoice.created", { orderId })
  },
}).retry({ attempts: 5, backoff: { base: 250 } })
```

The handler receives the payload first, exactly like an MCP `tool()`. `ctx` is
the second argument, and the full envelope — `attempt`, `headers`, the concrete
`channel` — is the third.

How the handler finishes decides what happens to the message:

| The handler | CloveJS returns to the adapter | Which means |
| --- | --- | --- |
| returns | `{ action: "ack" }` | Done. The broker may forget the message. |
| throws anything | `{ action: "retry", attempt, delay }` | Deliver it again — until `.retry({ attempts })` runs out, then `reject` |
| throws `reject(reason)` | `{ action: "reject", reason, attempt }` | Give up now, skipping every remaining retry |

`reject()` is for failures a second delivery cannot fix — an unknown tenant, a
discriminator the handler will never understand. Where the message goes after a
`reject` is your adapter's business (a dead-letter exchange, a DLQ, a log);
CloveJS only reports the verdict.

`.retry(...)` is chainable off `consume(...)`, like `.meta()` on a route.
Without it a consumer gets one delivery and no redelivery.

## Publishing

```ts
export default post(async (req, res, ctx) => {
  const order = await ctx.orders.create(req.body)
  await ctx.bus.events.publish("orders.created", order, { key: order.id })
  return order
})
```

`ctx.bus.<name>` is typed from your `bus/` directory by the generated
`.clove/types.d.ts`, so the misspelled `ctx.bus.evnets` is a compile error.

`ctx.bus.<name>` exposes `publish()` and nothing else — subscribing is the
runtime's job, not a handler's. The third argument is optional and entirely
advisory: `key` is the partition / ordering key for brokers that have one
(Kafka, and Rabbit's consistent-hash exchange), `id` is a broker-level message
id, `headers` ride along to the consumer as `message.headers`. An adapter whose
broker has no equivalent simply ignores the field.

## Nothing is derived from the file path

This is the one place CloveJS deliberately breaks with file-based derivation,
and it is worth knowing why.

Routes and MCP tools derive their identity from where they sit, because that
identity is **local** — your app owns the URL `/api/users`. A channel is not
local. It is a contract co-owned with whatever publishes it, and deriving it
from your private directory layout derives a shared contract from an
implementation detail.

The practical consequence is decisive: **one channel usually has several
consumers.** Billing and email both care about `orders.created`, and they cannot
both be `consumers/orders/created.ts`. With `channel` as data instead of a path,
they are two ordinary files:

```text
src/consumers/
  billing/orderCreated.ts    channel "orders.created", subscription "billing"
  email/orderCreated.ts      channel "orders.created", subscription "email"
```

`subscription` is explicit for a different reason: it is the durable subscriber
identity — a Rabbit queue, a Kafka consumer group. Renaming one does not fail
loudly; it silently creates a *new* consumer group, which on Kafka replays the
topic from the beginning. That is not something to infer from a directory name.

The file path is still used, just not as identity: it becomes the consumer's
display name in logs, metrics and boot errors — `consumers/billing/orderCreated.ts`
logs as `billing/orderCreated`. A consumer's actual identity is the triple
`bus` + `channel` + `subscription`, and two consumers claiming the same triple
is a boot error naming both files.

## Several buses

A project routinely has more than one broker: a durable one for work that must
not be lost, a fire-and-forget one for presence or live counters. Each is a file:

```text
src/bus/
  events.ts      →  ctx.bus.events      (RabbitMQ)
  audit.ts       →  ctx.bus.audit       (RabbitMQ, different server)
  presence.ts    →  ctx.bus.presence    (Redis Pub/Sub)
```

Nested files flatten the way `services/` does: `bus/rabbit/orders.ts` is
`ctx.bus.rabbitOrders`.

There is **no default bus**, even with one file. A default is exactly the thing
that becomes wrong the day a second bus appears, and `ctx.bus.events.publish(…)`
reads the same whether the project has one bus or four.

## Writing an adapter

A bus is any object with `capabilities`, `publish` and `subscribe`. `bus()`
takes that object directly, or a factory `(ctx, hooks)` — the same contract as
`di()` — when the connection needs injected config or a teardown hook. Either
way it is resolved once, as a singleton, during boot: a `bus/` file that fails
to connect fails the boot, and `onDestroy` runs on shutdown.

```ts
// src/bus/events.ts
import { bus, readAttempt, stampAttempt } from "clovejs/bus"
import amqplib from "amqplib"

export default bus(async (ctx, { onDestroy }) => {
  const conn = await amqplib.connect(ctx.config.amqpUrl)
  const ch = await conn.createConfirmChannel()
  onDestroy(() => conn.close())

  return {
    capabilities: {
      redelivery: true,
      attempts: true,
      delayedRetry: false,
      patterns: true,
      confirms: true,
    },

    publish(channel, payload, options) {
      return new Promise<void>((resolve, reject) => {
        ch.publish(
          "events",
          channel,
          Buffer.from(JSON.stringify(payload)),
          { messageId: options?.id, headers: options?.headers, persistent: true },
          (err) => (err ? reject(err) : resolve()),
        )
      })
    },

    async subscribe(spec, deliver) {
      await ch.prefetch(spec.maxInFlight)
      const q = await ch.assertQueue(`${spec.subscription}.${spec.channel}`, {
        durable: true,
        deadLetterExchange: "events.dlx",
      })
      await ch.bindQueue(q.queue, "events", spec.channel)

      const { consumerTag } = await ch.consume(q.queue, async (raw) => {
        if (!raw) return
        const headers = decodeHeaders(raw.properties.headers)

        const outcome = await deliver({
          // The routing key the producer used — not `spec.channel`, which may
          // be a pattern.
          channel: raw.fields.routingKey,
          subscription: spec.subscription,
          payload: JSON.parse(raw.content.toString()),
          headers,
          attempt: readAttempt(headers),
        })

        if (outcome.action === "ack") return ch.ack(raw)
        if (outcome.action === "reject") return ch.nack(raw, false, false)

        // Retry: republish carrying the next attempt number, then ack the
        // original. `nack(requeue)` would lose the counter and spin.
        // `outcome.delay` is ignored here — which is exactly what
        // `delayedRetry: false` above declares, and why CloveJS refuses at boot
        // to let a consumer on this bus ask for a backoff.
        ch.publish("events", raw.fields.routingKey, raw.content, {
          ...raw.properties,
          headers: stampAttempt(headers, outcome.attempt),
        })
        ch.ack(raw)
      })

      return { close: async () => void (await ch.cancel(consumerTag)) }
    },
  }
})
```

`deliver(envelope)` is the one call into CloveJS. It runs the whole delivery —
scope, validation, handler — and resolves with the outcome you have to translate
into broker vocabulary. It does not throw, and it does not act on the broker
itself:

| `outcome.action` | The adapter must |
| --- | --- |
| `"ack"` | Acknowledge — `ch.ack`, commit the offset, delete from the queue |
| `"retry"` | Arrange one more delivery, `outcome.delay` ms from now, reporting `outcome.attempt` as the next `envelope.attempt` |
| `"reject"` | Stop delivering it — dead-letter, park, or drop, whichever your topology says |

Note who waits: `outcome.delay` is a number of milliseconds CloveJS computed but
never sleeps on. The adapter implements the wait with whatever its broker
offers — a delayed exchange, `visibilityTimeout`, a `NAK` with a delay, a
scheduled republish. `delayedRetry: false` says you have no such mechanism.

Two properties make this work across brokers with irreconcilable models:

**The adapter owns the driver loop.** CloveJS never polls and never
acknowledges. It hands you a `deliver` callback and gives you back an outcome to
translate. That is why Rabbit's per-message ack, Kafka's offset commit and SQS's
visibility timeout all fit the same interface.

**A consumer never sees a native message.** No AMQP channel, no Kafka offset, no
`raw` escape hatch. If a handler needs the native client, inject it as an
ordinary service.

## Capabilities

Every bus declares five booleans, and none is optional: an adapter author has to
answer all five, and a `bus/` file that leaves one out fails the boot naming
itself. The answers are not documentation. CloveJS compares them against what
every consumer on that bus asks for and refuses to start on a mismatch, rather
than letting the gap surface as a runtime surprise.

| Capability | `true` promises that |
| --- | --- |
| `redelivery` | an un-acked message comes back at all. False for Redis Pub/Sub, where an undelivered message is simply gone |
| `attempts` | the `envelope.attempt` you pass to `deliver()` is the real delivery count, not always 1. Implies `redelivery` |
| `delayedRetry` | you actually wait `outcome.delay` ms before redelivering, rather than dropping the number |
| `patterns` | `spec.channel` may contain wildcards and your broker will expand them |
| `confirms` | your `publish()` promise resolves only after the broker accepted the message, not merely after the write |

What each refusal looks like:

| A consumer declares | Its bus says | Result |
| --- | --- | --- |
| `.retry({ attempts: n })`, `n > 1` | `redelivery: false` | Boot error — retrying cannot happen |
| `.retry({ attempts: n })`, `n > 1` | `attempts: false` | Boot error — the cap would never fire |
| `.retry({ backoff })` | `delayedRetry: false` | Boot error — the delay would be dropped |
| `channel: "orders.#"` | `patterns: false` | Boot error |
| — | `confirms: false` | One boot warning naming the bus |

These are errors, not warnings, because each means a guarantee the code on the
page asks for does not exist at runtime. A bus with `attempts: false` is still
perfectly usable — it just cannot cap retries, so consumers on it must not ask.
`confirms: false` is only a warning because it degrades a promise rather than
breaking one: `publish()` still works, it just resolves earlier than it reads.

All of this is checked once, after every bus has connected and before anything
subscribes, so the mismatch surfaces on the boot log rather than at 3am on a
poison message.

## Retries

**CloveJS computes the schedule. The adapter carries the counter.**

Backoff maths is pure and identical for every broker, so leaving it to adapters
would only guarantee they diverge. Counting deliveries is broker-specific, so
core cannot do it: it holds no state between deliveries, and a redelivery may
land on a different replica.

| Handler | Outcome |
| --- | --- |
| Returns | `ack` |
| Throws | `retry` carrying `attempt + 1` and a computed `delay`, until `attempts` is exhausted — then `reject` |
| Throws `reject(reason)` | `reject`, skipping remaining retries |
| Fails `input` validation | `reject` — it will not parse on attempt two either |
| Throws on a `redelivery: false` bus | `reject` immediately |

`.retry({ attempts })` counts *total* deliveries including the first, so
`attempts: 1` is the default no-retry behaviour and `attempts: 5` means at most
four redeliveries. `backoff.base` is the delay before the second delivery;
subsequent ones multiply by `factor` (default 2), capped at `max` (default 30s),
with equal jitter applied unless `jitter: false` — half the delay fixed, half
spread, so a burst of simultaneous failures does not come back as a
synchronised burst.

### Carrying the counter

`envelope.attempt` is the number the retry cap is compared against: with
`.retry({ attempts: 5 })`, a failure on attempt 5 rejects instead of retrying
again. So every delivery has to arrive knowing which delivery it is.

For brokers that count natively — SQS's `ApproximateReceiveCount`, NATS
JetStream's `num_delivered` — read theirs and pass it as `attempt`. For those
that do not (RabbitMQ and Kafka among them), the count has to travel *with the
message*, and CloveJS ships the mechanism so that every adapter does it
identically:

```ts
import { readAttempt, stampAttempt, ATTEMPT_HEADER } from "clovejs/bus"
```

| Export | What it is | Where you call it |
| --- | --- | --- |
| `ATTEMPT_HEADER` | the string `"x-clove-attempt"` — the header the count rides in | rarely; the two helpers use it for you |
| `readAttempt(headers)` | reads that header, returns a number | on the way **in**, to fill `envelope.attempt` |
| `stampAttempt(headers, n)` | returns a **copy** of the headers with the counter set to `n` | on the way **out**, on the message you republish for a retry |

Neither helper touches the broker or the payload — `stampAttempt` returns a new
plain object and mutates nothing, so what it affects is exactly one header on
the message you are about to publish.

Together they close the loop. A message failing twice under
`.retry({ attempts: 3 })` goes:

| Delivery | Header on arrival | `readAttempt` → `envelope.attempt` | Handler | Outcome | Adapter republishes with |
| --- | --- | --- | --- | --- | --- |
| 1st | absent | `1` | throws | `retry`, `attempt: 2` | `stampAttempt(headers, 2)` |
| 2nd | `x-clove-attempt: 2` | `2` | throws | `retry`, `attempt: 3` | `stampAttempt(headers, 3)` |
| 3rd | `x-clove-attempt: 3` | `3` | throws | `reject` — cap reached | nothing |

`readAttempt` returns `1` when the header is absent, which is the normal first
delivery, and *also* when the value is corrupt — not a number, zero, negative.
That direction is chosen on purpose: a garbled counter that read as a huge
number would reject a healthy message on its first try, whereas reading as 1
costs at most a few extra attempts. CloveJS applies the same rule to whatever
you pass as `envelope.attempt`, so a native count that arrives as `0` or `NaN`
is normalized to 1 rather than corrupting the cap.

Skip the whole mechanism by declaring `attempts: false` — then the bus is
perfectly usable, it just cannot cap retries, and CloveJS fails at boot if a
consumer on it asks for one.

## Wildcards

When the bus advertises `patterns: true`, `channel` may be a selector rather
than a literal. The syntax is the broker's, not CloveJS's — the selector is
passed through to `subscribe()` verbatim and expanded there. In the AMQP and
NATS conventions the in-memory bus and most adapters follow, `*` matches one
dot-separated segment and `#` matches zero or more.

CloveJS itself only looks for the characters `*`, `#` and `>` in a `channel`, to
decide whether the consumer is asking for something a `patterns: false` bus
cannot do.

```ts
export default consume<OrderEvent>({
  bus: "events",
  channel: "orders.#",
  subscription: "analytics",
  maxInFlight: 8,

  async handler(order, ctx, message) {
    // Always the concrete channel the producer published to, never the pattern.
    ctx.ledger.record(message.channel, order.orderId)
  },
})
```

## Validation

A message arrives as bytes someone else wrote, so its type is a claim until
something checks it. There are two ways to handle that, and you pick one per
consumer:

- **`input: <schema>`** — the payload is parsed on arrival and the handler's
  parameter type is inferred from the schema.
- **`consume<T>({...})`** with no `input` — nothing is checked; the payload is
  `T` because you said so.

### With zod

zod is an **optional** peer dependency. Nothing in `clovejs/bus` imports it, so
install it only if you want it:

```sh
npm install zod
```

Then pass the schema as `input` and let the handler's types follow from it:

```ts
// src/consumers/billing/orderCreated.ts
import { consume } from "clovejs/bus"
import { z } from "zod"

export default consume({
  bus: "events",
  channel: "orders.created",
  subscription: "billing",
  input: z.object({ orderId: z.string(), total: z.number() }),

  //          ┌─ { orderId: string; total: number }, inferred from `input`
  async handler({ orderId, total }, ctx) {
    await ctx.invoices.createForOrder(orderId, total)
  },
})
```

Note there is **no type argument**. Writing `consume<OrderCreated>({ input: … })`
turns schema inference off and makes `input` a type error — use one mechanism or
the other, never both.

A payload does not have to be an object, so `input: z.array(z.string())` or
`input: z.string()` are fine — unlike an MCP tool, whose arguments are always
named.

### Without zod

`input` is duck-typed: CloveJS looks at the *shape* of what you pass rather than
importing any library, so three forms work and anything else is a boot error
naming the file.

| Pass | Recognised because | The handler receives |
| --- | --- | --- |
| Any [Standard Schema](https://standardschema.dev) validator — zod 3.24+, valibot, arktype | it exposes `~standard` | that validator's output |
| Anything with a `parse()` that returns the value or throws | it has `.parse` | whatever `parse` returns |
| An object mapping field names to per-field schemas, e.g. `{ orderId: z.string() }` | every value has `.parse` | an object of just those fields — anything else in the payload is dropped |

The second row is the escape hatch: a validator you write by hand needs no
dependency at all, and still gets full type inference.

```ts
// src/consumers/billing/orderCreated.ts
interface OrderCreated { orderId: string; total: number }

const orderCreated = {
  parse(value: unknown): OrderCreated {
    const v = value as Partial<OrderCreated>
    if (typeof v?.orderId !== "string") throw new Error("orderId must be a string")
    if (typeof v?.total !== "number") throw new Error("total must be a number")
    return { orderId: v.orderId, total: v.total }
  },
}

export default consume({
  bus: "events",
  channel: "orders.created",
  subscription: "billing",
  input: orderCreated,

  async handler(order, ctx) {
    // order is OrderCreated — inferred from what parse() returns.
  },
})
```

### Skipping validation

Omit `input` entirely and name the payload type instead:

```ts
export default consume<OrderCreated>({
  bus: "events",
  channel: "orders.created",
  subscription: "billing",

  async handler(order, ctx) {
    // order is OrderCreated by assertion. Nothing verified it.
  },
})
```

This is the same trade a route handler makes when it reads `req.body`:
convenient, and only as true as the producer is trustworthy. Reasonable when
both ends are your own code and deploy together; risky across a team boundary,
where the schema is the contract.

### What a failure does

A payload that does not validate is **rejected, never retried** — it will not
parse on attempt two either. The `reject` reason is
`Payload failed validation: <issues>`, where the issues come from the validator
(a Standard Schema one contributes the field path, a hand-written `parse()`
contributes whatever it threw). It is logged as a warning rather than an error,
because a malformed message is a verdict the code reached on purpose rather than
a crash.

When validation succeeds, the *parsed* value is what the handler gets — and also
what `message.payload` holds, so the third argument never disagrees with the
first.

## Concurrency and ordering

`maxInFlight` is how many deliveries of this consumer may run at once. It
defaults to `1` and reaches the adapter as `spec.maxInFlight`, which is where it
is enforced — as `prefetch` on Rabbit, `maxMessages` on SQS, and so on.

Raising it is an explicit trade: concurrent deliveries forfeit per-key ordering,
so `orders.cancelled` may be processed before `orders.created` for the same key.
Raise it on counters and aggregations, not on anything that reads its own
writes.

## Per-delivery hooks

To run code around every delivery — tracing, metrics, a unit of work — use an
eager `request`-lifetime `di/` value. There is no separate consumer middleware
API.

That is not the bus opting out of the framework; it is the bus reusing the part
of it that already fits. `middlewares/` wrap an HTTP request: they take
`{ req, res, handler }` and their whole vocabulary — status codes, headers,
short-circuiting with a response — is meaningless for a message that has no
client waiting on it. `di/` is the mechanism that *does* carry over unchanged.
Every delivery opens its own `request`-scoped container, exactly as every HTTP
request does, so a `request`-lifetime value is already per-delivery state with a
matching teardown.

The one thing to know is that resolution is lazy: a factory nothing reads never
runs, so a tracing value nobody injects would silently do nothing. `eager: true`
is what turns it from an available value into a hook that fires on every
delivery:

```ts
// src/di/tracing.ts
export default di({
  lifetime: "request",
  eager: true,
  value(ctx, { onDestroy }) {
    const span = tracer.startSpan("delivery")
    onDestroy(() => span.end())
    return span
  },
})
```

One consequence worth stating plainly: that value is not bus-specific. The same
file fires on every HTTP request as well, because a request and a delivery are
the same shape of work under the same lifetime. If a hook must apply to only one
of them, branch inside the factory rather than expecting the framework to.

## Scopes

A delivery reuses the `request` lifetime, but its container is **isolated**,
meaning its parent is the singleton root directly, with no session scope in
between. Reading a `session`-lifetime value from a consumer therefore throws
`ScopeUnavailableError` naming the key, rather than returning something wrong.

That is deliberate. Without isolation the lookup would walk past the missing
scope and resolve into the singleton root, where the value would be cached for
the life of the process — one delivery's session state leaking into every later
one. `singleton` and `request` values work normally.

## Testing

By default an app subscribes every consumer during boot. `bus: "manual"` holds
that back until you call `app.bus.start()`, so a test can drive one message at a
time instead of racing the broker:

```ts
import { createTestApp } from "clovejs/testing"

const app = await createTestApp({ bus: "manual" })   // subscriptions unstarted

// One message through the full delivery path — scope, eager values,
// validation, handler, outcome — with no broker and no timers.
const outcome = await app.bus.dispatch({
  bus: "events",
  channel: "orders.created",
  subscription: "billing",
  payload: { orderId: "o1", total: 10 },
})
expect(outcome).toEqual({ action: "ack" })

// Or drive it end to end.
await app.bus.start()
await app.bus.publish("events", "orders.created", { orderId: "o2", total: 5 })
await app.bus.drain()
expect(app.bus.published("events")).toContainEqual(
  expect.objectContaining({ channel: "invoice.created" }),
)
```

The two halves differ in what they exercise. `dispatch()` skips the bus entirely
— it picks the consumer itself and calls the delivery path directly, so no
`publish`/`subscribe` and no adapter is involved, and the outcome comes back to
you instead of being acted on. `bus` and `subscription` are needed only to
disambiguate: leave them out and `dispatch` matches on the channel alone,
failing loudly if that matches zero or several consumers. `publish()` + `drain()`
goes through the real bus object, which for `memoryBus()` means retries, delays
and dead-lettering all actually happen.

Because `dispatch()` does not itself redeliver, the way to test a redelivery is
to state which one it is. Pass `attempt` and you get the outcome that delivery
would produce — including exhaustion, where a consumer capped at 5 rejects
instead of asking for a sixth:

```ts
const last = await app.bus.dispatch({ …, attempt: 5 })
expect(last).toMatchObject({ action: "reject" })
```

`app.bus.published(name)` reads the recorded publishes off an in-memory bus, so
it works against `memoryBus()` and throws an explanatory error on any real
adapter — a broker connection has nothing to record.

## Shutdown

On close, CloveJS closes every subscription first, so no new message is handed
over, then waits for the deliveries already running — up to `busDrainTimeout`,
an `AppOptions` field that defaults to 30s. Consumers drain **before**
sockets and MCP, so a handler still finishing has every service it depends on;
bus connections close last, in `root.dispose()`.

Deliveries still running when the timeout expires are **abandoned un-acked**, so
an at-least-once broker redelivers them, and each is logged. The alternative —
acking work that did not finish — is data loss.

## What stays out

Topology creation, broker configuration, serialization format, the delay
*mechanism*, dead-letter routing, transactional publishing, "exactly once", and
native message access. All of it sits behind the adapter, in your code, where
the broker-specific knowledge already is.

**Cross-bus transactions** most of all: publishing to two buses atomically is
not something two connections can offer, and the API does not imply it.

A **transactional outbox** is a recipe rather than a feature — wrap the bus you
return from `bus/<name>.ts`.

## See also

- [`examples/pubsub`](https://github.com/cloveteam/clovejs/tree/main/examples/pubsub)
  — two buses with different guarantees, three consumers on one channel,
  wildcards, retry with backoff, and a hand-written adapter in fifty lines.
- [Values and lifetimes](/guide/dependency-injection) for `di({ eager })`.
- [Testing](/guide/testing) for the rest of the harness.
