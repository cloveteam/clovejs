import { service } from "clovejs"

export interface Note {
  id: number
  title: string
}

/** Tenant-isolated store: data never crosses between tenants. */
export default service(async () => {
  const buckets = new Map<string, Map<number, Note>>()
  const seq = new Map<string, number>()

  function bucket(tenant: string): Map<number, Note> {
    let notes = buckets.get(tenant)
    if (!notes) {
      notes = new Map([[1, { id: 1, title: `${tenant} welcome` }]])
      buckets.set(tenant, notes)
      seq.set(tenant, 2)
    }
    return notes
  }

  return {
    list(tenant: string): Note[] {
      return [...bucket(tenant).values()]
    },
    create(tenant: string, title: string): Note {
      const notes = bucket(tenant)
      const id = seq.get(tenant) ?? 1
      seq.set(tenant, id + 1)
      const note = { id, title }
      notes.set(id, note)
      return note
    },
  }
})
