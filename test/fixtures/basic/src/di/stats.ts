import { di } from "clovejs"

/**
 * A singleton counter the websocket handlers write to, so tests can observe
 * connection lifecycle through an HTTP route rather than by importing the
 * handler module (which would be a separate copy).
 */
export default di({
  lifetime: "singleton",
  value: {
    socketsOpened: 0,
    socketsDestroyed: 0,
    streamsOpened: 0,
    streamsClosed: 0,
  },
})
