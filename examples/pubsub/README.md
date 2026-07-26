# CloveJS — message bus example

Two buses with different guarantees, three consumers on one channel, wildcard
selectors, retry with backoff, and a hand-written broker adapter in fifty lines
— with no broker to install and no network.

[`../rest`](../rest) covers routing, DI and sessions;
[`../websocket`](../websocket) covers sockets; [`../mcp`](../mcp) covers the
Model Context Protocol.

## Run it

From the repository root (this example is an npm workspace, so one install
covers it):

```bash
npm install
npm run dev -w clovejs-example-pubsub
```

Or from this directory once the root install has run:

```bash
cd examples/pubsub
npm run dev
```

The banner lists the consumers alongside the routes, and warns about
`bus/presence.ts` — see [Capabilities](#capabilities-are-checked-at-boot) below:

```
WARN  Bus "presence" advertises confirms: false — `ctx.bus.presence.publish()`
      resolves before the broker has accepted the message …
INFO  CloveJS dev server ready on http://localhost:3000
INFO    POST    /api/orders
INFO    BUS     orders.#        →  events/analytics
INFO    BUS     orders.created  →  events/billing
INFO    BUS     orders.created  →  events/email
INFO    BUS     user.*          →  presence/live
```

## What to look at

| File | Demonstrates |
| --- | --- |
| [`src/bus/events.ts`](./src/bus/events.ts) | The whole bus in one line, via `memoryBus()` |
| [`src/lib/fanoutBus.ts`](./src/lib/fanoutBus.ts) | **Writing an adapter**: capabilities, `publish`, the `subscribe` driver loop |
| [`src/bus/presence.ts`](./src/bus/presence.ts) | A second connection, with weaker guarantees |
| [`src/consumers/billing/orderCreated.ts`](./src/consumers/billing/orderCreated.ts) | `retry()` with backoff, and `reject()` for failures a retry cannot fix |
| [`src/consumers/email/orderCreated.ts`](./src/consumers/email/orderCreated.ts) | The **same channel**, different subscription, with zod validation |
| [`src/consumers/analytics/orders.ts`](./src/consumers/analytics/orders.ts) | A wildcard selector, and `maxInFlight` |
| [`src/consumers/presence/userActive.ts`](./src/consumers/presence/userActive.ts) | A consumer that *cannot* declare `retry()`, and why |
| [`src/di/deliveryLog.ts`](./src/di/deliveryLog.ts) | `di({ eager: true })` — the per-delivery hook |
| [`src/api/orders.post.ts`](./src/api/orders.post.ts) | Publishing from an HTTP route |

## Try it

Publish an order. Billing invoices it, email thanks the customer, analytics
counts it — one publish, three independent consumers:

```bash
curl -X POST localhost:3000/api/orders -H 'content-type: application/json' \
  -d '{"orderId":"ord-1","customer":"a@example.com","total":100}'

curl -s localhost:3000/api/state | jq
```

**Watch a retry.** `flaky@example.com` fails its first three deliveries, then
succeeds — with exponential backoff between attempts:

```bash
curl -X POST localhost:3000/api/orders -H 'content-type: application/json' \
  -d '{"orderId":"ord-2","customer":"flaky@example.com","total":50}'
```

```
WARN [bus:events] billing/orderCreated (orders.created → billing) attempt 1 retried: …
WARN [bus:events] billing/orderCreated (orders.created → billing) attempt 2 retried: …
WARN [bus:events] billing/orderCreated (orders.created → billing) attempt 3 retried: …
```

**Watch two rejections, for two different reasons.** Billing throws `reject()`
because a negative total is not something a redelivery fixes; email's zod schema
refuses the same payload at the process boundary. Neither is retried:

```bash
curl -X POST localhost:3000/api/orders -H 'content-type: application/json' \
  -d '{"orderId":"ord-3","customer":"c@example.com","total":-5}'
```

```
ERROR … billing … attempt 1 rejected: RejectSignal: negative total on order ord-3
ERROR … email   … attempt 1 rejected: MessageValidationError: Payload failed
                  validation: total: Number must be greater than or equal to 0
```

Analytics still counts it — a rejection is per subscription, not per message.

**Watch the wildcard.** `consumers/analytics/orders.ts` subscribes to
`orders.#`, so a channel it has never heard of arrives anyway:

```bash
curl -X POST localhost:3000/api/orders/cancel -H 'content-type: application/json' \
  -d '{"orderId":"ord-1"}'
```

**The other bus:**

```bash
curl -X POST localhost:3000/api/presence -H 'content-type: application/json' \
  -d '{"userId":"u-42"}'
```

## Capabilities are checked at boot

`src/bus/presence.ts` advertises `redelivery: false` — it fans a message out to
whoever is listening and forgets it. Add a `.retry(...)` to
`src/consumers/presence/userActive.ts` and the app refuses to start:

```
Consumer "presence/userActive" declares retry({ attempts: 3 }), but bus
"presence" advertises redelivery: false — an un-acked message never comes back,
so retrying cannot happen. Drop the retry() call, or bind this consumer to a
bus that redelivers.
  - src/consumers/presence/userActive.ts
  - src/bus/presence.ts
```

That is the point of declaring capabilities. Retrying on a transport that never
redelivers is not a slower success — it is a promise nothing can keep, so it
fails at boot naming both files rather than looking like it works.

The same check catches a backoff a bus would silently drop, a wildcard on a bus
without pattern support, and a retry cap on a bus that cannot count deliveries
(which would redeliver forever).

## Going to a real broker

Swap one file. `src/bus/events.ts` becomes:

```ts
export default bus(async (ctx, { onDestroy }) => {
  const conn = await amqplib.connect(ctx.config.amqpUrl)
  onDestroy(() => conn.close())
  return amqpBus(conn)
})
```

No consumer changes, because no consumer has ever seen a native message.
`src/lib/fanoutBus.ts` is the shape you are filling in — the
[guide](https://cloveteam.github.io/clovejs/guide/message-bus) has a complete
RabbitMQ adapter, including how `readAttempt`/`stampAttempt` carry the delivery
counter across a retry hop.
