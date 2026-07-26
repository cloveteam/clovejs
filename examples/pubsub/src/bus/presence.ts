import { bus } from "clovejs/bus"
import { fanoutBus } from "../lib/fanoutBus.js"

/**
 * The second bus, on a different transport with different guarantees.
 *
 * `bus/` is a directory precisely so this is possible: a project routinely has
 * a durable broker for work that must not be lost and a fire-and-forget one for
 * presence, typing indicators or live counters. Each file is one connection,
 * and the filename is the name everything else addresses it by — this one is
 * `ctx.bus.presence` and `consume({ bus: "presence" })`.
 *
 * The factory form `(ctx, hooks)` is available when a connection needs config
 * or a teardown hook, exactly like `di()`:
 *
 * ```ts
 * export default bus(async (ctx, { onDestroy }) => {
 *   const client = await createClient(ctx.config.redisUrl)
 *   onDestroy(() => client.quit())
 *   return redisBus(client)
 * })
 * ```
 */
export default bus(fanoutBus())
