import type { Server } from "node:http"
import express from "express"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { engine, type CloveEngine } from "../../src/index.js"
import { Client, fixturePath } from "./helpers.js"

let server: Server
let clove: CloveEngine
let client: Client

beforeAll(async () => {
  const app = express()

  // A native Express route that must keep working alongside Clove's.
  app.get("/express-only", (_req, res) => {
    res.json({ from: "express" })
  })

  clove = await engine(app, {
    rootDir: fixturePath("basic"),
    logLevel: "silent",
    sessionSecret: "test-secret",
  })

  app.use((_req, res) => {
    res.status(404).json({ from: "express-fallthrough" })
  })

  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s))
  })
  clove.attachUpgrade(server)

  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  client = new Client(`http://127.0.0.1:${port}`)
})

afterAll(async () => {
  await clove?.close()
  await new Promise<void>((resolve) => server?.close(() => resolve()))
})

describe("express interop", () => {
  it("serves clove routes through the mounted engine", async () => {
    const res = await client.get("/api/v1/users")
    expect(res.status).toBe(200)
    expect(res.json).toHaveLength(2)
  })

  it("leaves the host's own routes alone", async () => {
    const res = await client.get("/express-only")
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ from: "express" })
  })

  it("falls through to the host for unmatched paths", async () => {
    const res = await client.get("/not-a-route")
    expect(res.status).toBe(404)
    expect(res.json).toEqual({ from: "express-fallthrough" })
  })

  it("runs the middleware chain and DI inside the host", async () => {
    const res = await client.get("/api/v1/users/1")
    expect(res.json.username).toBe("ada")
    expect(res.headers.get("x-request-id")).toMatch(/^req-\d+$/)
  })

  it("supports websockets once the upgrade handler is attached", async () => {
    const { WebSocket } = await import("ws")
    const address = server.address()
    const port = typeof address === "object" && address ? address.port : 0
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/echo`)
    const message = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 5000)
      socket.on("message", (data) => {
        clearTimeout(timer)
        resolve(data.toString())
      })
      socket.on("error", reject)
    })
    expect(JSON.parse(message)).toEqual({ hello: true })
    socket.close()
  })
})
