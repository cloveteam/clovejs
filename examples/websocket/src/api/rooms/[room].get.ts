import { get } from "clovejs"

// Who is in the room and what was said recently — the same state the sockets
// read, over plain HTTP.
export default get(async (req, _res, ctx) => {
  const room = req.params.room
  return {
    room,
    occupants: ctx.chat.occupants(room),
    recent: ctx.chat.recent(room),
  }
})
