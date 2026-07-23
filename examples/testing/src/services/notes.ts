import { service } from "clovejs"

export interface Note {
  id: number
  title: string
  body: string
}

// An in-memory notes store. It is the main subject under test: the integration
// tests drive it through routes, and the override tests swap it for a fake.
export default service(async (ctx, { onDestroy }) => {
  const notes = new Map<number, Note>([
    [1, { id: 1, title: "Welcome", body: "This note came from services/notes.ts" }],
    [2, { id: 2, title: "Testing", body: "Boot the app in memory with clovejs/testing" }],
  ])
  let nextId = 3

  onDestroy(async () => {
    ctx.logger.info("notes service shutting down")
  })

  return {
    list(): Note[] {
      return [...notes.values()]
    },

    findById(id: number): Note | null {
      return notes.get(id) ?? null
    },

    search(query: string): Note[] {
      const needle = query.toLowerCase()
      return [...notes.values()].filter(
        (n) => n.title.toLowerCase().includes(needle) || n.body.toLowerCase().includes(needle),
      )
    },

    create(input: { title: string; body: string }): Note {
      const note: Note = { id: nextId++, ...input }
      notes.set(note.id, note)
      return note
    },

    remove(id: number): boolean {
      return notes.delete(id)
    },
  }
})
