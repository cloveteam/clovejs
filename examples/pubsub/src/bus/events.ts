import { bus, memoryBus } from "clovejs/bus"

/**
 * The durable bus: everything a real broker offers.
 *
 * `memoryBus()` supports the whole contract — wildcard selectors, accurate
 * attempt counts, honored retry delays, and a `publish()` that resolves only
 * once the message is accepted — so an app developed against it behaves the
 * same way when a RabbitMQ or Kafka adapter is dropped in here later. Swapping
 * this one file is the entire migration.
 */
export default bus(memoryBus())
