import { Buffer } from "node:buffer"
import { spawn } from "node:child_process"
import console from "node:console"
import { Agent, createServer, request } from "node:http"
import { performance } from "node:perf_hooks"
import process from "node:process"
import { clearInterval, clearTimeout, setInterval, setTimeout } from "node:timers"
import { fileURLToPath, URL } from "node:url"

const defaults = {
  connections: 100,
  duration: 10,
  target: "both",
}

const options = parseArgs(process.argv.slice(2))
const targets = [
  {
    id: "clove",
    name: "CloveJS",
    entry: new URL("./dist/main.js", import.meta.url),
  },
  {
    id: "express",
    name: "Express",
    entry: new URL("./express.js", import.meta.url),
  },
].filter(({ id }) => options.target === "both" || options.target === id)

const results = []
for (const target of targets) {
  results.push(await benchmark(target))
}

printResults(results)

async function benchmark(target) {
  const port = await availablePort()
  const childOutput = []
  const startedAt = performance.now()
  const child = spawn(process.execPath, [fileURLToPath(target.entry)], {
    cwd: new URL(".", import.meta.url),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      NODE_ENV: "production",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })

  child.stdout.on("data", (chunk) => childOutput.push(chunk))
  child.stderr.on("data", (chunk) => childOutput.push(chunk))

  try {
    await waitUntilReady(child, port, childOutput)
    const heatUpMs = performance.now() - startedAt
    const throughput = await runLoad(port)
    return { name: target.name, heatUpMs, ...throughput }
  } finally {
    await stop(child)
  }
}

async function waitUntilReady(child, port, output) {
  const deadline = performance.now() + 10_000

  while (performance.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Server exited with code ${child.exitCode} before it was ready.\n${joinOutput(output)}`,
      )
    }

    try {
      const response = await sendRequest(port, undefined, true)
      if (
        response.statusCode === 200 &&
        response.body === '{"message":"Hello, world!"}'
      ) {
        return
      }
    } catch {
      // Connection failures are expected until the child starts listening.
    }

    await delay(5)
  }

  throw new Error(`Server did not become ready within 10 seconds.\n${joinOutput(output)}`)
}

async function runLoad(port) {
  const agent = new Agent({
    keepAlive: true,
    maxSockets: options.connections,
    maxFreeSockets: options.connections,
  })
  const durationMs = options.duration * 1000
  const startedAt = performance.now()
  const deadline = startedAt + durationMs
  const samples = []
  let completed = 0
  let failed = 0
  let sampledCompleted = 0
  let sampledAt = startedAt

  const sampler = setInterval(() => {
    const now = performance.now()
    samples.push({
      endedAtMs: now - startedAt,
      spanMs: now - sampledAt,
      rps: ((completed - sampledCompleted) * 1000) / (now - sampledAt),
    })
    sampledCompleted = completed
    sampledAt = now
  }, 1000)

  const workers = Array.from({ length: options.connections }, async () => {
    while (performance.now() < deadline) {
      try {
        const response = await sendRequest(port, agent)
        if (response.statusCode === 200) completed++
        else failed++
      } catch {
        failed++
      }
    }
  })

  await Promise.all(workers)
  clearInterval(sampler)

  const endedAt = performance.now()
  if (endedAt > sampledAt) {
    samples.push({
      endedAtMs: endedAt - startedAt,
      spanMs: endedAt - sampledAt,
      rps: ((completed - sampledCompleted) * 1000) / (endedAt - sampledAt),
    })
  }
  agent.destroy()

  const fullSamples = samples.filter((sample) => sample.spanMs >= 900)
  const peak = fullSamples.reduce(
    (best, sample) => (sample.rps > best.rps ? sample : best),
    { rps: 0, endedAtMs: 0 },
  )

  return {
    averageRps: (completed * 1000) / (endedAt - startedAt),
    peakRps: peak.rps,
    peakAtSeconds: peak.endedAtMs / 1000,
    completed,
    failed,
  }
}

function sendRequest(port, agent, collectBody = false) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/api",
        agent,
        headers: { accept: "application/json" },
      },
      (res) => {
        let body = ""
        if (collectBody) res.setEncoding("utf8")
        res.on("data", (chunk) => {
          if (collectBody) body += chunk
        })
        res.on("end", () => resolve({ statusCode: res.statusCode, body }))
      },
    )
    req.on("error", reject)
    req.end()
  })
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close()
        reject(new Error("Could not allocate a benchmark port."))
        return
      }
      server.close((error) => {
        if (error) reject(error)
        else resolve(address.port)
      })
    })
  })
}

function stop(child) {
  if (child.exitCode !== null) return Promise.resolve()

  return new Promise((resolve) => {
    const force = setTimeout(() => child.kill("SIGKILL"), 3000)
    child.once("exit", () => {
      clearTimeout(force)
      resolve()
    })
    child.kill("SIGTERM")
  })
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function joinOutput(chunks) {
  return Buffer.concat(chunks).toString("utf8").trim()
}

function parseArgs(args) {
  const parsed = { ...defaults }

  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    const value = args[index + 1]

    if (argument === "--connections" || argument === "-c") {
      parsed.connections = positiveInteger(value, argument)
      index++
    } else if (argument === "--duration" || argument === "-d") {
      parsed.duration = positiveNumber(value, argument)
      index++
    } else if (argument === "--target" || argument === "-t") {
      if (!["both", "clove", "express"].includes(value)) {
        usage(`Invalid target: ${value ?? "(missing)"}`)
      }
      parsed.target = value
      index++
    } else if (argument === "--help" || argument === "-h") {
      usage()
    } else {
      usage(`Unknown argument: ${argument}`)
    }
  }

  if (parsed.duration < 1) usage("Duration must be at least one second.")
  return parsed
}

function positiveInteger(value, flag) {
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) usage(`${flag} must be a positive integer.`)
  return number
}

function positiveNumber(value, flag) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) usage(`${flag} must be positive.`)
  return number
}

function usage(error) {
  if (error) console.error(`${error}\n`)
  console.error(
    "Usage: node load-test.js [-c connections] [-d seconds] " +
      "[-t both|clove|express]",
  )
  process.exit(error ? 1 : 0)
}

function printResults(rows) {
  const headings = ["App", "Heat-up", "Average RPS", "Peak RPS", "Peak at", "Errors"]
  const values = rows.map((row) => [
    row.name,
    `${row.heatUpMs.toFixed(1)} ms`,
    Math.round(row.averageRps).toLocaleString("en-US"),
    Math.round(row.peakRps).toLocaleString("en-US"),
    `${row.peakAtSeconds.toFixed(1)} s`,
    row.failed.toLocaleString("en-US"),
  ])
  const widths = headings.map((heading, column) =>
    Math.max(heading.length, ...values.map((row) => row[column].length)),
  )
  const format = (row) =>
    row.map((cell, column) => cell.padEnd(widths[column])).join("  ")

  console.log(
    `\n${options.connections} persistent connections, ${options.duration}s per app\n`,
  )
  console.log(format(headings))
  console.log(format(widths.map((width) => "-".repeat(width))))
  for (const row of values) console.log(format(row))
  console.log(
    "\nHeat-up is process spawn to the first valid response; peak RPS is the " +
      "highest one-second sample.",
  )
}
