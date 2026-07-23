import { describe, expect, it, vi } from "vitest"
import { createMockCtx, runHandler, runMiddleware } from "clovejs/testing"

// Unit tests skip the project scan entirely: import one handler or middleware,
// hand it a mock `ctx`, and assert on the response the JSON rules produce.
import listNotes from "../src/api/notes.get.js"
import getNote from "../src/api/notes/[id].get.js"
import createNote from "../src/api/notes.post.js"
import authorize from "../src/middlewares/authorize.1.js"

describe("runHandler", () => {
  it("runs a handler against a mock ctx", async () => {
    const ctx = createMockCtx({
      notes: { list: () => [{ id: 1, title: "Only", body: "" }] },
    })

    const res = await runHandler(listNotes, { ctx })

    expect(res.status).toBe(200)
    expect(res.json).toEqual([{ id: 1, title: "Only", body: "" }])
  })

  it("turns a null return from a GET into 404", async () => {
    const ctx = createMockCtx({ notes: { findById: () => null } })

    const res = await runHandler(getNote, { params: { id: "42" }, ctx })

    expect(res.status).toBe(404)
  })

  it("passes params and body through, and honours res.status(201)", async () => {
    const create = vi.fn((input: { title: string; body: string }) => ({ id: 5, ...input }))
    const ctx = createMockCtx({ notes: { create } })

    const res = await runHandler(createNote, { body: { title: "T", body: "B" }, ctx })

    expect(res.status).toBe(201)
    expect(res.json).toMatchObject({ id: 5, title: "T" })
    expect(create).toHaveBeenCalledWith({ title: "T", body: "B" })
  })

  it("renders a thrown error() into its status", async () => {
    const ctx = createMockCtx({ notes: { create: () => ({}) } })

    const res = await runHandler(createNote, { body: {}, ctx }) // missing title

    expect(res.status).toBe(400)
    expect(res.json).toEqual({ message: "title is required" })
  })
})

describe("runMiddleware", () => {
  it("rejects an admin-only route with no session", async () => {
    const { response } = await runMiddleware(authorize, {
      ctx: createMockCtx({ currentUser: null }),
      route: { meta: { adminOnly: true } },
      execute: () => "should not run",
    })

    expect(response.status).toBe(403)
  })

  it("passes an admin through to the handler", async () => {
    const { result } = await runMiddleware(authorize, {
      ctx: createMockCtx({ currentUser: { id: 1, username: "ada", isAdmin: true } }),
      route: { meta: { adminOnly: true } },
      execute: () => "reached the handler",
    })

    expect(result).toBe("reached the handler")
  })
})

describe("createMockCtx", () => {
  it("supports get, set and has like the real container", () => {
    const ctx = createMockCtx({ notes: { list: () => [] } })

    expect("notes" in ctx).toBe(true)
    ctx.currentUser = { id: 1, username: "ada", isAdmin: true }
    expect(ctx.currentUser.username).toBe("ada")
  })
})
