import { get } from "clovejs"

// The same live state the streams read, over plain HTTP: who is listening and
// the recent event log.
export default get(async (req, _res, ctx) => {
  const channel = req.params.channel
  return {
    channel,
    live: ctx.feed.live(channel),
    recent: ctx.feed.since(channel, 0),
  }
})
