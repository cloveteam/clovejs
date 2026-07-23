import { sse } from "clovejs"

// The smallest possible stream, served at /api/clock: the server time, once a
// second. `send(obj)` is shorthand for a default `message` event with a
// JSON-serialised payload. Clearing the timer in `onClose` is the whole
// lifecycle — no heartbeat needed, since it is never idle.
export default sse(async ({ send, onClose }) => {
  const timer = setInterval(() => {
    send({ now: new Date().toISOString() })
  }, 1000)

  onClose(() => clearInterval(timer))
})
