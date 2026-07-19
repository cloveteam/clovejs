import { service } from "clovejs"

export interface Note {
  id: string
  title: string
  body: string
}

export default service(async (ctx) => {
  const notes = new Map<string, Note>([
    ["1", { id: "1", title: "Groceries", body: "Milk, eggs, cloves" }],
    ["2", { id: "2", title: "Reading", body: "Finish the MCP specification" }],
  ])
  let nextId = 3

  ctx.logger.debug("notes service initialized")

  return {
    findById(id: string): Note | null {
      return notes.get(id) ?? null
    },

    search(query: string): Note[] {
      const needle = query.toLowerCase()
      return [...notes.values()].filter(
        (note) =>
          note.title.toLowerCase().includes(needle) ||
          note.body.toLowerCase().includes(needle),
      )
    },

    create(title: string, body: string): Note {
      const note = { id: String(nextId++), title, body }
      notes.set(note.id, note)
      return note
    },

    get size(): number {
      return notes.size
    },
  }
})
