import express from "express"
import process from "node:process"

const app = express()
const port = Number(process.env.PORT ?? 3000)
const host = process.env.HOST ?? "localhost"

app.disable("x-powered-by")
app.get("/api", (_req, res) => {
  res.json({ message: "Hello, world!" })
})

app.listen(port, host)
