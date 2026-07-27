# Message bus

Files in `bus/` declare connections to brokers. Files in `consumers/` handle the
messages that arrive on them.

CloveJS ships no broker client and adds no runtime dependency. It understands
consumers and the delivery lifecycle — validation, scopes, ack, retry, reject —
and nothing about RabbitMQ, Kafka, SQS, NATS or Redis. You install the SDK you
want and adapt it in one file.

Everything here comes from `clovejs/bus`, not the core barrel:

```ts
import { bus, consume, reject, pattern, memoryBus } from "clovejs/bus"
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
[`MemoryCacheStore`](/guide/caching). By default it claims the whole contract:
wildcards expand, redelivery carries the failure counter, and retry delays are
actually waited out.

That makes an app developed against it *portable*, which is not the same as
identical. Being the most capable bus there is also makes it the weakest possible
check — no capability mismatch can surface against a bus that claims everything,
so every one waits for the day a real adapter arrives. `capabilities` fixes that:

```ts
export default bus(
  memoryBus({
    // Mirror the broker you actually deploy against, so its boot errors happen
    // here instead of in staging.
    capabilities: { retries: "immediate" },
  }),
)
```

What it cannot do is outlive the process. Messages live in memory, nothing is
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
the second argument, and the full envelope — `attempt`, `failures`, `headers`,
the concrete `channel` — is the third.

How the handler finishes decides what happens to the message:

| The handler | CloveJS returns to the adapter | Which means |
| --- | --- | --- |
| returns | `{ action: "ack" }` | Done. The broker may forget the message. |
| throws anything | `{ action: "retry", subscription, delay, headers, failures }` | Redeliver it to *this* subscription — until `.retry({ attempts })` runs out, then `reject` |
| throws `reject(reason)` | `{ action: "reject", reason, failures }` | Give up now, skipping every remaining retry |

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

Headers beginning `x-clove-` are reserved. Control metadata and user headers
share one map on every broker, so the boundary is drawn by name: CloveJS strips
that prefix from what a handler sees, and `publish()` throws if you set one.
Without that rule a producer forwarding headers could hand a consumer a failure
count it never earned, spending its whole retry budget on the first delivery.

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
import { bus, encodeJson, readFailures } from "clovejs/bus"
import amqplib from "amqplib"

export default bus(async (ctx, { onDestroy }) => {
  const conn = await amqplib.connect(ctx.config.amqpUrl)
  const ch = await conn.createConfirmChannel()
  onDestroy(() => conn.close())

  return {
    capabilities: {
      retries: "immediate",
      patterns: true,
    },

    publish(channel, payload, options) {
      return new Promise<void>((resolve, reject) => {
        ch.publish(
          "events",
          channel,
          Buffer.from(encodeJson(payload)),
          { messageId: options?.id, headers: options?.headers, persistent: true },
          (err) => (err ? reject(err) : resolve()),
        )
      })
    },

    async subscribe(spec, deliver, { report }) {
      await ch.prefetch(spec.maxInFlight)
      const q = await ch.assertQueue(`${spec.subscription}.${spec.channel}`, {
        durable: true,
        deadLetterExchange: "events.dlx",
      })
      await ch.bindQueue(q.queue, "events", spec.channel)
      report("consuming")
      conn.on("close", () => report("stopped"))

      const { consumerTag } = await ch.consume(q.queue, async (raw) => {
        if (!raw) return
        const headers = decodeHeaders(raw.properties.headers)

        const outcome = await deliver({
          // The routing key the producer used — not `spec.channel`, which may
          // be a pattern.
          channel: raw.fields.routingKey,
          subscription: spec.subscription,
          // Bytes, not a parsed object: decoding belongs inside the delivery
          // path, so a malformed message gets a `reject` verdict instead of
          // throwing here, where nothing can ack it.
          body: raw.content,
          headers,
          failures: readFailures(headers),
        })

        if (outcome.action === "ack") return ch.ack(raw)
        if (outcome.action === "reject") return ch.nack(raw, false, false)

        // Retry: redeliver to *this queue* and ack the original. Publishing back
        // to the "events" exchange would re-route the message to every other
        // queue bound to the same key, so billing's retry would silently make
        // email process the order twice. `nack(requeue)` would lose the counter
        // and spin.
        //
        // `outcome.headers` already carries the counter — core stamps it, so an
        // adapter cannot forget to increment it. `outcome.delay` is ignored
        // here, which is exactly what `retries: "immediate"` declares, and why
        // CloveJS refuses at boot to let a consumer on this bus ask for a
        // backoff.
        ch.publish("", q.queue, raw.content, {
          ...raw.properties,
          headers: outcome.headers,
        })
        ch.ack(raw)
      })

      return { close: async () => void (await ch.cancel(consumerTag)) }
    },
  }
})
```

`deliver(message)` is the one call into CloveJS. It runs the whole delivery —
scope, decode, validation, handler — and resolves with the outcome you have to
translate into broker vocabulary. It does not throw, and it does not act on the
broker itself:

| `outcome.action` | The adapter must |
| --- | --- |
| `"ack"` | Acknowledge — `ch.ack`, commit the offset, delete from the queue |
| `"retry"` | Arrange one more delivery **to `outcome.subscription` alone**, `outcome.delay` ms from now, carrying `outcome.headers` |
| `"reject"` | Stop delivering it — dead-letter, park, or drop, whichever your topology says |

Note who waits: `outcome.delay` is a number of milliseconds CloveJS computed but
never sleeps on. The adapter implements the wait with whatever its broker
offers — a delayed exchange, `visibilityTimeout`, a `NAK` with a delay, a
scheduled republish. `retries: "immediate"` says you have no such mechanism.

Three properties make this work across brokers with irreconcilable models:

**The adapter owns the driver loop.** CloveJS never polls and never
acknowledges. It hands you a `deliver` callback and gives you back an outcome to
translate. That is why Rabbit's per-message ack, Kafka's offset commit and SQS's
visibility timeout all fit the same interface. Because core cannot see that loop,
it also cannot tell a healthy subscription from one whose connection dropped —
so the adapter `report()`s state changes, and `app.bus.health()` exposes them for
a readiness probe.

**A retry is a redelivery, never a re-publish.** One channel usually has several
subscriptions, and sending a failed message back to the exchange or topic routes
it to all of them. `outcome.subscription` names the only one that may see it
again.

**A consumer never sees a native message.** No AMQP channel, no Kafka offset, no
`raw` escape hatch. If a handler needs the native client, inject it as an
ordinary service.

### Decoding

Passing `body` rather than `payload` puts the bytes-to-value step inside the
delivery path. It is optional, and it is the difference between a poison message
and a poison loop: a `JSON.parse` in your own consume callback throws where no
outcome exists, so nothing acks and an at-least-once broker returns the same
unparseable bytes forever. Done by core, a failure becomes
`reject` with `Payload failed to decode: …` — the same verdict, for the same
reason, as a payload that fails `input` validation.

JSON is the default both ways; `encodeJson` is exported so `publish()` need not
hand-roll it. A bus that speaks something else says so once:

```ts
decode: (body) => msgpack.decode(body),
```

## Capabilities

Every bus answers two questions, and neither is optional: a `bus/` file that
leaves one out fails the boot naming itself. The answers are not documentation.
CloveJS compares them against what every consumer on that bus asks for and
refuses to start on a mismatch, rather than letting the gap surface as a runtime
surprise.

```ts
capabilities: {
  retries: "none" | "immediate" | "delayed",
  patterns: boolean,
}
```

| Capability | Promises that |
| --- | --- |
| `retries: "none"` | an un-acked message never comes back. Redis Pub/Sub, where an undelivered message is simply gone |
| `retries: "immediate"` | it comes back carrying `outcome.headers`, but `outcome.delay` is ignored |
| `retries: "delayed"` | it comes back, and you actually wait `outcome.delay` ms first |
| `patterns` | `spec.channel` may be a selector, and your broker will expand it |

What each refusal looks like:

| A consumer declares | Its bus says | Result |
| --- | --- | --- |
| `.retry({ attempts: n })`, `n > 1` | `retries: "none"` | Boot error — retrying cannot happen |
| `.retry({ backoff })` | `retries: "immediate"` | Boot error — the delay would be dropped |
| `channel: pattern("orders.#")` | `patterns: false` | Boot error |

These are errors, not warnings, because each means a guarantee the code on the
page asks for does not exist at runtime. A bus with `retries: "none"` is still
perfectly usable — it just cannot retry, so consumers on it must not ask.

The list is deliberately short. **A capability earns its place only if CloveJS
changes what it does based on the answer.** Whether the counter survives a
redelivery is not one: core stamps it onto `outcome.headers`, so any adapter that
redelivers the message core handed back carries it for free, and one that drops
the headers instead — a bare `nack(requeue)` — has a bug rather than a transport
limit. Whether `publish()` waits for a broker acknowledgement is not one either:
it is real and worth knowing, but core does nothing differently, and a permanent
boot warning about a bus that is *deliberately* fire-and-forget only teaches
people to ignore the boot log.

All of this is checked once, after every bus has connected and before anything
subscribes, so the mismatch surfaces on the boot log rather than at 3am on a
poison message.

## Retries

**CloveJS computes the schedule and stamps the counter. The adapter carries it.**

Backoff maths is pure and identical for every broker, so leaving it to adapters
would only guarantee they diverge. Where the counter *travels* is broker-specific,
so core cannot do that part: it holds no state between deliveries, and a
redelivery may land on a different replica.

| Handler | Outcome |
| --- | --- |
| Returns | `ack` |
| Throws | `retry` carrying `failures + 1`, a computed `delay` and stamped `headers`, until `attempts` is exhausted — then `reject` |
| Throws `reject(reason)` | `reject`, skipping remaining retries |
| Fails to decode | `reject` — those bytes will not parse on delivery two either |
| Fails `input` validation | `reject` — same reasoning |
| Throws on a `retries: "none"` bus | `reject` immediately |

`backoff.base` is the delay before the second delivery; subsequent ones multiply
by `factor` (default 2), capped at `max` (default 30s), with equal jitter applied
unless `jitter: false` — half the delay fixed, half spread, so a burst of
simultaneous failures does not come back as a synchronised burst.

### What `attempts` counts, and what it does not

A message carries one number, and the envelope exposes the obvious view of it:

| Envelope field | Counts |
| --- | --- |
| `failures` | handler runs that ended in a throw. 0 on a first delivery |
| `attempt` | `failures + 1` — which run of the handler this is |

`.retry({ attempts })` counts handler attempts including the first, so
`attempts: 1` is the default no-retry behaviour and `attempts: 5` means at most
four redeliveries *caused by failures*.

It bounds handler failures, and nothing else — which matters when a delivery ends
some other way. A delivery that dies with the process, or that is still running
when `busDrainTimeout` expires and is [abandoned un-acked](#shutdown), never ran
the handler to a verdict, so it never spent an attempt. A handler that reliably
outlives the drain timeout would be redelivered indefinitely as far as CloveJS is
concerned.

**Bounding those is the broker's job, and every broker that can count them
already does it better.** SQS has a redrive policy with `maxReceiveCount`,
JetStream has `MaxDeliver`, Rabbit has a dead-letter policy on the queue. Each is
enforced broker-side, so it also covers the process that crashed and never came
back — which nothing running inside your app can see. Set it where you declare
the topology, in the same adapter that declares the queue.

### Carrying the counter

Every delivery has to arrive knowing how many handler runs already failed on it,
because core holds no state between deliveries and a redelivery may land on a
different replica. So the count travels *with the message*, and CloveJS ships the
mechanism so that every adapter does it identically:

```ts
import { readFailures, ATTEMPT_HEADER } from "clovejs/bus"
```

| Export | What it is | Where you call it |
| --- | --- | --- |
| `readFailures(headers)` | reads the counter, returning 0 for a first delivery | on the way **in**, as `failures` |
| `outcome.headers` | the headers to attach on a retry, counter already stamped | on the way **out**, written verbatim |
| `ATTEMPT_HEADER` | the string `"x-clove-attempt"`, where the count rides | rarely; the above use it for you |

Core stamps the outbound headers itself rather than leaving each adapter to
remember an increment — a forgotten one is invisible until a poison message
loops. `stampFailures` stays exported for transports that cannot carry headers
as-is and have to rebuild them.

Together they close the loop. A message failing twice under
`.retry({ attempts: 3 })` goes:

| Delivery | Header on arrival | `failures` | Handler | Outcome | Adapter redelivers with |
| --- | --- | --- | --- | --- | --- |
| 1st | absent | `0` | throws | `retry`, `failures: 1` | `outcome.headers` |
| 2nd | `x-clove-attempt: 2` | `1` | throws | `retry`, `failures: 2` | `outcome.headers` |
| 3rd | `x-clove-attempt: 3` | `2` | throws | `reject` — cap reached | nothing |

A corrupt counter reads as a first delivery — not a number, zero, negative, all
of it. That direction is chosen on purpose: a garbled counter that read as a huge
number would reject a healthy message on its first try, whereas reading as 0
costs at most a few extra attempts.

Skip the whole mechanism by declaring `retries: "none"` — then the bus is
perfectly usable, it just cannot retry, and CloveJS fails at boot if a consumer
on it asks to.

## Wildcards

When the bus advertises `patterns: true`, a channel may be a selector rather than
a literal — wrapped in `pattern()`, never inferred:

```ts
import { consume, pattern } from "clovejs/bus"

export default consume<OrderEvent>({
  bus: "events",
  channel: pattern("orders.#"),
  subscription: "analytics",
  maxInFlight: 8,

  async handler(order, ctx, message) {
    // Always the concrete channel the producer published to, never the pattern.
    ctx.ledger.record(message.channel, order.orderId)
  },
})
```

The syntax is the broker's, not CloveJS's — the selector is passed through to
`subscribe()` verbatim and expanded there, with `spec.pattern` telling the adapter
which it received. In the AMQP and NATS conventions the in-memory bus and most
adapters follow, `*` matches one dot-separated segment and `#` matches zero or
more.

A bare string containing `*`, `#` or `>` is a boot error, not a pattern. Guessing
from punctuation is wrong in both directions: it silently promotes a literal
channel named `user.#1` into a subscription to far more than intended, and it
leaves no way to say the opposite. For that rare literal, there is `literal()`:

```ts
channel: literal("user.#1")   // yes, the name really contains a #
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
importing any library, so two forms work and anything else is a boot error
naming the file.

| Pass | Recognised because | The handler receives |
| --- | --- | --- |
| Any [Standard Schema](https://standardschema.dev) validator — zod 3.24+, valibot, arktype | it exposes `~standard` | that validator's output |
| Anything with a `parse()` that returns the value or throws | it has `.parse` | whatever `parse` returns |

The second row is the escape hatch: a validator you write by hand needs no
dependency at all, and still gets full type inference.

To keep only some fields of a payload, name them in the schema itself —
`z.object({ orderId: z.string() })` drops everything it does not mention, and
what the handler gets is what `message.payload` holds.

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

It is a concurrency limit, **not an ordering guarantee**. `maxInFlight: 1` bounds
one process, and a second replica has its own: two workers on one Rabbit queue
interleave freely no matter what either sets.

**Ordering is a property of the topology, not of anything CloveJS can declare.**
It comes from a consistent-hash exchange, a partitioned topic, a FIFO queue — all
of it set up in the adapter, all of it invisible to core, and none of it
something a field on a consumer could deliver. So there is no `ordered` option to
write: if your consumer needs order, give the broker a topology that provides it,
and leave `maxInFlight` at 1 so this process does not undo it.

Raising `maxInFlight` is the ordinary trade: `orders.cancelled` may be processed
before `orders.created` for the same key. Raise it on counters and aggregations,
not on anything that reads its own writes.

## Per-delivery hooks

To run code around every delivery — tracing, metrics, a unit of work — use an
eager `request`-lifetime `di/` value. There is no separate consumer middleware
API.

That is not the bus opting out of the framework; it is the bus reusing the part
of it that already fits. `middlewares/` wrap an HTTP request: they take
`{ req, res, handler }` and their whole vocabulary — status codes, headers,
short-circuiting with a response — is meaningless for a message that has no
client waiting on it. `di/` is the mechanism that *does* carry over unchanged.
Every delivery opens its own request scope, exactly as every HTTP request does,
so a scoped value is already per-delivery state with a matching teardown.

Two things turn it from an available value into a bus hook. `eager: true`,
because resolution is lazy — a factory nothing reads never runs, so a tracing
value nobody injects would silently do nothing. And the `trigger` guard,
because a request scope also opens for HTTP requests, sockets and MCP calls —
the factory's second argument says which one opened this scope:

```ts
// src/di/tracing.ts
export default di({
  lifetime: "request",
  eager: true,
  value(ctx, { onDestroy, trigger }) {
    if (trigger?.kind !== "delivery") return null
    const span = tracer.startSpan(trigger.consumer)
    onDestroy(() => span.end())
    return span
  },
})
```

`trigger` is a discriminated union: `kind` is `"http"`, `"ws"`, `"mcp"` or
`"delivery"`, each narrowing to what that kind actually carries — a delivery
brings the bus, channel, subscription and consumer name. It is `undefined` for
`singleton` and `session` factories, which outlive any single unit of work.
Drop the guard for a hook that genuinely serves every kind of work — a metrics
timer, say — and branch on `trigger.kind` only where the difference matters.

### What this does not cover

A `di/` value runs before the handler and tears down after it, so it can time a
delivery — but it cannot see the outcome, and it cannot short-circuit one.
Outcome-aware work (a retry-rate metric, dedup that acks a message it has already
processed) belongs in the handler, or in a service the handler calls:

```ts
async handler(order, ctx) {
  if (await ctx.seen.has(order.orderId)) return   // ack without redoing the work
  await ctx.invoices.createForOrder(order)
  await ctx.seen.add(order.orderId)
}
```

## Scopes

A delivery opens a request scope whose parent is the singleton root directly,
with no session in between. Reading a `session`-lifetime value from a consumer
therefore throws `ScopeUnavailableError` naming the key, rather than returning
something wrong.

That is deliberate. Without isolation the lookup would walk past the missing
scope and resolve into the singleton root, where the value would be cached for
the life of the process — one delivery's session state leaking into every later
one. `singleton` and `request` values work normally.

## Testing

By default an app subscribes every consumer during boot. `startConsumers: false`
holds that back until you call `app.bus.start()`, so a test can drive one message
at a time instead of racing the broker:

```ts
import { createTestApp } from "clovejs/testing"

const app = await createTestApp({ startConsumers: false })

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
to state which one it is. Pass `failures` and you get the outcome that delivery
would produce — including exhaustion, where a consumer capped at 5 rejects
instead of asking for a sixth:

```ts
const last = await app.bus.dispatch({ …, failures: 4 })
expect(last).toMatchObject({ action: "reject" })
```

`app.bus.published(name)` and `dead(name)` read an in-memory bus, so they work
against `memoryBus()` and throw an explanatory error on any real adapter — a
broker connection has nothing to record. `app.bus.health()` works everywhere.

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

Topology creation, broker configuration, the delay *mechanism*, dead-letter
routing, transactional publishing, "exactly once", and native message access. All
of it sits behind the adapter, in your code, where the broker-specific knowledge
already is.

Three things that look like they belong here and do not:

**A cap on total deliveries.** Only the broker can count hand-overs that never
reached the handler, and every broker that can count them already caps them
better — broker-side, where it also covers the process that crashed and never
came back. `retry({ attempts })` caps handler failures; a redrive policy caps the
rest.

**Ordering.** It comes from a consistent-hash exchange, a partitioned topic, a
FIFO queue — topology, set up in the adapter. A field on a consumer could only
ever restate a promise it has no way to keep.

**Publish confirmation.** Whether `publish()` waits for a broker acknowledgement
is real and worth knowing, but core behaves identically either way, so it is
documentation rather than a capability — and a boot warning about a bus that is
deliberately fire-and-forget only teaches people to ignore the boot log.

Serialization is *pluggable* rather than absent: JSON by default, one `decode`
function to change it. Leaving it out entirely only meant every adapter
hand-rolled the one part of the problem that has a correct universal answer — and
did it outside the delivery lifecycle, where a malformed message cannot get a
verdict.

### Idempotency is yours

Delivery is at-least-once, so a handler can run twice on one message: a retry
re-runs everything, including whatever it published the first time. The consumer
at the top of this page creates an invoice *and* publishes `invoice.created`, and
a retry after the invoice succeeds duplicates both.

Nothing in the framework can fix that — the fix is a key your handler checks, and
`options.id` is the natural one to key on:

```ts
async handler(order, ctx) {
  const invoice = await ctx.invoices.createForOrder(order)   // upsert on orderId
  await ctx.bus.events.publish("invoice.created", invoice, { id: invoice.id })
}
```

Make the write idempotent (an upsert, a unique constraint, a `seen` set in
[`ctx.cache`](/guide/caching)) and the second run becomes a no-op. A
[transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html)
is the general answer, and it is a recipe: wrap the bus you return from
`bus/<name>.ts`.

**Cross-bus transactions** most of all: publishing to two buses atomically is not
something two connections can offer, and the API does not imply it.

## See also

- [`examples/pubsub`](https://github.com/cloveteam/clovejs/tree/main/examples/pubsub)
  — two buses with different guarantees, three consumers on one channel,
  wildcards, retry with backoff, and a hand-written adapter in fifty lines.
- [Values and lifetimes](/guide/dependency-injection) for `di({ eager })`.
- [Testing](/guide/testing) for the rest of the harness.
