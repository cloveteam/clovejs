import { randomUUID } from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { Container } from "../container/container.js"
import type { Logger } from "../container/logger.js"
import { CloveBootError } from "../errors.js"
import type { SessionManager } from "../session/index.js"
import { errorText, isRecoverable, toPromptMessages, toResourceContents, toToolContent } from "./content.js"
import { isUriTemplate } from "./paths.js"
import type { McpScan, McpToolArgs } from "./types.js"

export const MCP_SESSION_HEADER = "mcp-session-id"

export interface McpRuntimeOptions {
  scan: McpScan
  root: Container
  logger: Logger
  sessions: SessionManager
  /** Path the Streamable HTTP transport is served from. Defaults to `/mcp`. */
  path?: string
  /** Reported to clients during initialization. */
  serverInfo?: { name: string; version: string }
  /** Include the underlying message when a handler fails unexpectedly. */
  exposeErrors?: boolean
}

/** The slice of the MCP SDK this runtime uses, resolved lazily. */
interface Sdk {
  McpServer: any
  ResourceTemplate: any
  StreamableHTTPServerTransport: any
  StdioServerTransport: any
}

interface Live {
  server: any
  transport: any
  /** Parent container for calls on this connection: session- or root-scoped. */
  parent: Container
  /** Set when `parent` is a session container that needs persisting. */
  sessionId: string | null
  /** Resolves once `parent` holds the session container for this connection. */
  ready: Promise<void>
}

/**
 * Serves the project's `mcp/` directory as a Model Context Protocol server.
 *
 * The protocol itself is handled by `@modelcontextprotocol/sdk`; this class
 * owns the CloveJS half — scoping each connection to a session container,
 * each call to a request container, and mapping handler results and errors
 * onto MCP's wire shapes.
 */
export class McpRuntime {
  readonly path: string
  #options: McpRuntimeOptions & { exposeErrors: boolean }
  #sdk: Sdk | null = null
  #live = new Map<string, Live>()
  /** The single connection used by stdio, which has no session ids. */
  #standalone: Live | null = null

  constructor(options: McpRuntimeOptions) {
    this.#options = { exposeErrors: false, ...options }
    this.path = options.path ?? "/mcp"
  }

  get empty(): boolean {
    const { tools, resources, prompts } = this.#options.scan
    return tools.length === 0 && resources.length === 0 && prompts.length === 0
  }

  get counts(): { tools: number; resources: number; prompts: number } {
    const { tools, resources, prompts } = this.#options.scan
    return { tools: tools.length, resources: resources.length, prompts: prompts.length }
  }

  /**
   * Handles one MCP HTTP request. Returns false when the path does not match,
   * so the caller can fall through to routes.
   */
  async handle(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<boolean> {
    if (this.empty) return false
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
    if (url.pathname !== this.path) return false

    const sdk = await this.#load()
    const existingId = headerValue(req, MCP_SESSION_HEADER)

    if (existingId) {
      const live = this.#live.get(existingId)
      if (!live) {
        writeJsonRpcError(res, 404, -32001, "Unknown or expired MCP session")
        return true
      }
      await live.ready
      await live.transport.handleRequest(req, res, body)
      await this.#persist(live)
      return true
    }

    if (req.method !== "POST") {
      // GET opens the server-to-client stream and DELETE ends a session; both
      // need a session that initialization already created.
      writeJsonRpcError(res, 400, -32000, "Missing Mcp-Session-Id header")
      return true
    }

    // No session id and a POST: this is an initialize request. The transport
    // mints the id, and we attach a session container once it does.
    const transport = new sdk.StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId: string) => {
        // Registered synchronously, before any await: the client may send its
        // first call the moment it has the id, and a lookup that missed here
        // would 404 a session that is perfectly valid. `ready` is what makes
        // the container available, and every path awaits it.
        this.#live.set(sessionId, live)
        this.#options.logger.debug(`MCP session opened: ${sessionId}`)

        live.ready = (async () => {
          if (!this.#options.sessions.needed) return
          const { container } = await this.#options.sessions.acquireById(sessionId)
          live.parent = container
          live.sessionId = sessionId
        })()
        return live.ready
      },
      onsessionclosed: (sessionId: string) => {
        void this.#closeSession(sessionId)
      },
    })

    const live: Live = {
      server: this.#buildServer(sdk, () => live.parent),
      transport,
      parent: this.#options.root,
      sessionId: null,
      ready: Promise.resolve(),
    }

    transport.onclose = () => {
      const id = transport.sessionId
      if (id) void this.#closeSession(id)
    }

    await live.server.connect(transport)
    await transport.handleRequest(req, res, body)
    await live.ready
    await this.#persist(live)
    return true
  }

  /**
   * Serves the project over stdio, for clients that launch the server as a
   * subprocess. Resolves when the client disconnects.
   */
  async serveStdio(): Promise<void> {
    const sdk = await this.#load()
    const transport = new sdk.StdioServerTransport()
    const live: Live = {
      server: this.#buildServer(sdk, () => this.#options.root),
      transport,
      parent: this.#options.root,
      sessionId: null,
      ready: Promise.resolve(),
    }
    this.#standalone = live
    await live.server.connect(transport)
    await new Promise<void>((resolve) => {
      transport.onclose = () => resolve()
    })
  }

  /** Builds an MCP server with every scanned tool, resource and prompt bound. */
  #buildServer(sdk: Sdk, parent: () => Container): any {
    const { scan, serverInfo } = this.#options
    const server = new sdk.McpServer(
      serverInfo ?? { name: "clovejs", version: "0.1.1" },
      { capabilities: { logging: {} } },
    )

    for (const tool of scan.tools) {
      const shape = tool.shape
      const run = (input: unknown, extra: unknown) =>
        this.#call(parent(), tool.file, extra, async (ctx, args) => ({
          content: toToolContent(await tool.handler(input ?? {}, ctx, args)),
        }), true)

      server.registerTool(
        tool.name,
        {
          description: tool.description,
          ...(tool.title ? { title: tool.title } : {}),
          ...(shape ? { inputSchema: shape } : {}),
          ...annotationsOf(tool.meta),
        },
        // A tool without an input schema takes no arguments, so the SDK calls
        // back with `(extra)` alone rather than `(input, extra)`.
        shape
          ? (input: unknown, extra: unknown) => run(input, extra)
          : (extra: unknown) => run({}, extra),
      )
    }

    for (const res of scan.resources) {
      const target = isUriTemplate(res.uri)
        ? new sdk.ResourceTemplate(res.uri, { list: undefined })
        : res.uri

      server.registerResource(
        res.name,
        target,
        {
          description: res.description,
          ...(res.title ? { title: res.title } : {}),
          ...(res.mimeType ? { mimeType: res.mimeType } : {}),
        },
        async (uri: URL, a: unknown, b?: unknown) => {
          // Template reads pass (uri, variables, extra); static reads pass
          // (uri, extra) — the variables argument simply is not there.
          const variables = (isUriTemplate(res.uri) ? a : {}) as Record<string, unknown>
          const extra = isUriTemplate(res.uri) ? b : a
          return this.#call(parent(), res.file, extra, async (ctx, args) => ({
            contents: toResourceContents(
              await res.handler(stringParams(variables), ctx, { ...args, uri: uri.href }),
              uri.href,
              res.mimeType,
            ),
          }))
        },
      )
    }

    for (const p of scan.prompts) {
      const shape = p.shape
      const run = (input: unknown, extra: unknown) =>
        this.#call(parent(), p.file, extra, async (ctx, args) => ({
          messages: toPromptMessages(await p.handler(input ?? {}, ctx, args)),
        }))

      server.registerPrompt(
        p.name,
        {
          description: p.description,
          ...(p.title ? { title: p.title } : {}),
          ...(shape ? { argsSchema: shape } : {}),
        },
        // As with tools, an argument-less prompt is called with `(extra)` only.
        shape
          ? (input: unknown, extra: unknown) => run(input, extra)
          : (extra: unknown) => run({}, extra),
      )
    }

    return server
  }

  /**
   * Runs one handler in a fresh request-scoped container.
   *
   * A client error (4xx) is the model's problem — bad arguments, a missing
   * record — so its message is passed through verbatim for the model to act
   * on. Anything else is ours: it is logged in full and reported as a generic
   * failure, so internal detail does not reach the client. That mirrors what
   * the HTTP pipeline does with a 500, `exposeErrors` and all.
   *
   * Only tools can carry a failure in their result. Resources and prompts have
   * no such field in the protocol, so for those the error is rethrown and the
   * SDK turns it into a JSON-RPC error.
   */
  async #call<T>(
    parent: Container,
    file: string,
    extra: any,
    run: (ctx: any, args: McpToolArgs) => Promise<T>,
    soft = false,
  ): Promise<T | { content: Array<{ type: "text"; text: string }>; isError: true }> {
    const container = parent.createChild("request")
    const args: McpToolArgs = {
      ctx: container.ctx,
      sessionId: typeof extra?.sessionId === "string" ? extra.sessionId : null,
      signal: extra?.signal ?? new AbortController().signal,
      log: (level, message) => {
        void extra?.sendNotification?.({
          method: "notifications/message",
          params: { level, data: message },
        })
      },
    }

    try {
      return await run(container.ctx, args)
    } catch (err) {
      const message = isRecoverable(err)
        ? errorText(err)
        : this.#reportInternal(err, file)
      if (soft) return { content: [{ type: "text", text: message }], isError: true }
      // Rethrown rather than propagated so the client sees `message` — which
      // is redacted for anything that is not a 4xx — while the original stays
      // attached for a server-side reader.
      throw new Error(message, { cause: err })
    } finally {
      await container
        .dispose()
        .catch((err) => this.#options.logger.error("Error disposing MCP request scope:", err))
    }
  }

  /** Logs an unexpected failure and returns the message the client may see. */
  #reportInternal(err: unknown, file: string): string {
    this.#options.logger.error(`MCP handler failed (${file}):`, err)
    return this.#options.exposeErrors && err instanceof Error
      ? `Internal error: ${err.message}`
      : "Internal error"
  }

  async #persist(live: Live): Promise<void> {
    if (!live.sessionId) return
    await this.#options.sessions
      .persist(live.sessionId, live.parent)
      .catch((err) => this.#options.logger.error("Failed to persist MCP session:", err))
  }

  async #closeSession(sessionId: string): Promise<void> {
    const live = this.#live.get(sessionId)
    if (!live) return
    this.#live.delete(sessionId)
    this.#options.logger.debug(`MCP session closed: ${sessionId}`)
    await live.server.close().catch(() => undefined)
    if (live.sessionId) {
      await this.#options.sessions.destroy(live.sessionId).catch(() => undefined)
    }
  }

  /** Closes every open connection. */
  async close(): Promise<void> {
    const ids = [...this.#live.keys()]
    await Promise.all(ids.map((id) => this.#closeSession(id)))
    if (this.#standalone) {
      await this.#standalone.server.close().catch(() => undefined)
      this.#standalone = null
    }
  }

  /**
   * Imports the MCP SDK on first use.
   *
   * It is an optional peer dependency: a project with no `mcp/` directory
   * never loads it, and never has to install it.
   */
  async #load(): Promise<Sdk> {
    if (this.#sdk) return this.#sdk
    try {
      const [mcp, http, stdio] = await Promise.all([
        import("@modelcontextprotocol/sdk/server/mcp.js"),
        import("@modelcontextprotocol/sdk/server/streamableHttp.js"),
        import("@modelcontextprotocol/sdk/server/stdio.js"),
      ])
      this.#sdk = {
        McpServer: mcp.McpServer,
        ResourceTemplate: mcp.ResourceTemplate,
        StreamableHTTPServerTransport: http.StreamableHTTPServerTransport,
        StdioServerTransport: stdio.StdioServerTransport,
      }
      return this.#sdk
    } catch (err) {
      throw new CloveBootError(
        `This project has an mcp/ directory, which needs the MCP SDK and zod:\n\n` +
          `  npm install @modelcontextprotocol/sdk zod\n\n` +
          `They are optional peer dependencies, so projects without MCP tools ` +
          `do not carry them.\n\nUnderlying error: ${(err as Error).message}`,
      )
    }
  }
}

function annotationsOf(meta: Readonly<Record<string, unknown>>): {
  annotations?: Record<string, boolean>
} {
  const annotations: Record<string, boolean> = {}
  if (typeof meta.readOnly === "boolean") annotations.readOnlyHint = meta.readOnly
  if (typeof meta.destructive === "boolean") annotations.destructiveHint = meta.destructive
  if (typeof meta.idempotent === "boolean") annotations.idempotentHint = meta.idempotent
  if (typeof meta.openWorld === "boolean") annotations.openWorldHint = meta.openWorld
  return Object.keys(annotations).length ? { annotations } : {}
}

/** URI template variables arrive as string or string[]; handlers want strings. */
function stringParams(variables: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(variables ?? {})) {
    out[key] = Array.isArray(value) ? value.join("/") : String(value)
  }
  return out
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name]
  return Array.isArray(raw) ? raw[0] : raw
}

function writeJsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }))
}
