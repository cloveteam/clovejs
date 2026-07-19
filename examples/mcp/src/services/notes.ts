import { service } from "clovejs"

export interface Note {
  id: number
  title: string
  body: string
}

export default service(async (ctx, { onDestroy }) => {
  const notes = new Map<number, Note>([
    [1, { id: 1, title: "Welcome", body: "This note came from services/notes.ts" }],
  ])
  let nextId = 2

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
