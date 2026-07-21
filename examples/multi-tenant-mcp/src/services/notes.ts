import { service } from "clovejs"

export interface Note {
  id: number
  title: string
  body: string
}

/**
 * A tenant-isolated note store. Every method takes the tenant as its first
 * argument, and data never crosses between tenants: `acme` and `globex` each
 * get their own bucket, seeded with a sample note the first time they are
 * seen. This is the multi-tenant boundary — a tool passes `auth.tenant`, so a
 * token can only ever reach its own tenant's notes.
 *
 * One singleton backs every connection; the isolation is by key, not by
 * instance. A real app would swap this Map for a database with a tenant column
 * (or a schema, or a database) behind the same interface.
 */
export default service(async () => {
  const buckets = new Map<string, Map<number, Note>>()
  const sequence = new Map<string, number>()

  function bucket(tenant: string): Map<number, Note> {
    let notes = buckets.get(tenant)
    if (!notes) {
      notes = new Map([
        [1, { id: 1, title: `Welcome, ${tenant}`, body: `Only ${tenant} can read this note.` }],
      ])
      buckets.set(tenant, notes)
      sequence.set(tenant, 2)
    }
    return notes
  }

  return {
    list(tenant: string): Note[] {
      return [...bucket(tenant).values()]
    },

    findById(tenant: string, id: number): Note | null {
      return bucket(tenant).get(id) ?? null
    },

    search(tenant: string, query: string, limit = 10): Note[] {
      const needle = query.toLowerCase()
      return [...bucket(tenant).values()]
        .filter((n) => n.title.toLowerCase().includes(needle) || n.body.toLowerCase().includes(needle))
        .slice(0, limit)
    },

    create(tenant: string, input: { title: string; body: string }): Note {
      const notes = bucket(tenant)
      const id = sequence.get(tenant) ?? 1
      sequence.set(tenant, id + 1)
      const note: Note = { id, ...input }
      notes.set(id, note)
      return note
    },
  }
})
