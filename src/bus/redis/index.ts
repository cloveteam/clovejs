/**
 * Redis adapters for `clovejs/bus`.
 *
 * A separate entry point on purpose. `clovejs/bus` knows nothing about any
 * broker and imports no client, and that stays true: nothing in core reaches
 * into this module, `redis` and `ioredis` are optional peer dependencies, and a
 * project that never imports `clovejs/bus/redis` never loads either.
 *
 * ```ts
 * // src/bus/events.ts
 * import { bus } from "clovejs/bus"
 * import { redisStreams } from "clovejs/bus/redis"
 *
 * export default bus(redisStreams({ url: process.env.REDIS_URL! }))
 * ```
 */

export { redisStreams } from "./streams.js"
export type { RedisStreamsBus, RedisStreamsOptions } from "./streams.js"

export { redisPubSub } from "./pubsub.js"
export type { RedisPubSubOptions } from "./pubsub.js"

export { hashTag, keyLayout } from "./keys.js"
export type { KeyLayout } from "./keys.js"

export type { RedisLike, RedisConnectionOptions } from "./client.js"
