import { bus, memoryBus } from "clovejs/bus"

/**
 * The durable bus: everything a real broker offers.
 *
 * `memoryBus()` claims the whole contract — wildcard selectors, redelivery that
 * carries the failure counter, and honored retry delays — so an app developed
 * against it behaves the same way when a RabbitMQ or Kafka adapter is dropped in
 * here later. Swapping this one file is the entire migration.
 */
export default bus(memoryBus())
