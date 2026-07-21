import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { Container } from "../container/container.js"
import type { Logger } from "../container/logger.js"
import { CloveBootError, isHttpError } from "../errors.js"
import type { SessionManager } from "../session/index.js"
import { errorText, isRecoverable, toPromptMessages, toResourceContents, toToolContent } from "./content.js"
import { isUriTemplate } from "./paths.js"
import type { McpAuth, McpAuthInfo, McpProtectedResourceMetadata, McpScan, McpToolArgs } from "./types.js"

export const MCP_SESSION_HEADER = "mcp-session-id"

/** Base path of the RFC 9728 protected-resource metadata endpoint. */
export const OAUTH_METADATA_PATH = "/.well-known/oauth-protected-resource"

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
  /**
   * How the server authenticates callers, from `mcp/auth.ts`. When set, every
   * request to the endpoint must carry a valid bearer token, the principal is
   * exposed to handlers as `args.auth`, and a session is bound to the tenant
   * that opened it.
   */
  auth?: McpAuth
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
  /** The principal that opened this session, bound at initialization. */
  auth: McpAuthInfo | null
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
  /**
   * Carries the request's principal from `handle()` into `#call`, without
   * threading it through the MCP SDK. Async-local so concurrent requests on
   * one session never read each other's identity.
   */
  #authStore = new AsyncLocalStorage<McpAuthInfo | null>()
  /** The metadata document, resolved (from a factory, if given) on first serve. */
  #resolvedMetadata: McpProtectedResourceMetadata | null = null

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

  /** True when this server enforces bearer-token authentication. */
  get secured(): boolean {
    return this.#options.auth != null
  }

  /**
   * True when the path is one this runtime answers: the MCP endpoint itself,
   * or — when auth is configured — its protected-resource metadata. Lets the
   * host route those paths here and fall through to routes for everything else.
   */
  owns(path: string): boolean {
    if (this.empty) return false
    if (path === this.path) return true
    return this.secured && isMetadataPath(path)
  }

  /**
   * Handles one MCP HTTP request. Returns false when the path does not match,
   * so the caller can fall through to routes.
   */
  async handle(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<boolean> {
    if (this.empty) return false
    const url = new URL(req.url ?? "/", `${scheme(req)}://${req.headers.host ?? "localhost"}`)

    // Discovery: `/.well-known/oauth-protected-resource` is public, so it is
    // answered before the token check that guards everything else.
    if (this.secured && isMetadataPath(url.pathname)) {
      await this.#serveMetadata(res, url)
      return true
    }

    if (url.pathname !== this.path) return false

    const sdk = await this.#load()

    // Authenticate before touching the transport. A rejection writes its own
    // 401/403 response, so we simply stop.
    let authInfo: McpAuthInfo | null = null
    if (this.#options.auth) {
      authInfo = await this.#authenticate(req, res, url)
      if (!authInfo) return true
    }

    const existingId = headerValue(req, MCP_SESSION_HEADER)

    if (existingId) {
      const live = this.#live.get(existingId)
      if (!live) {
        writeJsonRpcError(res, 404, -32001, "Unknown or expired MCP session")
        return true
      }
      await live.ready
      // A session belongs to the tenant that opened it. A token for a
      // different tenant must not ride an existing connection.
      if (live.auth && authInfo && live.auth.tenant !== authInfo.tenant) {
        writeJsonRpcError(res, 403, -32003, "This MCP session belongs to another tenant")
        return true
      }
      await this.#authStore.run(authInfo, () => live.transport.handleRequest(req, res, body))
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
      auth: authInfo,
      ready: Promise.resolve(),
    }

    transport.onclose = () => {
      const id = transport.sessionId
      if (id) void this.#closeSession(id)
    }

    await live.server.connect(transport)
    await this.#authStore.run(authInfo, () => transport.handleRequest(req, res, body))
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
      auth: null,
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
      auth: this.#authStore.getStore() ?? null,
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

  /**
   * Runs the project's `authenticate` handler for one request. Returns the
   * principal on success, or null after writing a rejection response.
   *
   * A 4xx thrown by the handler is the caller's problem — a missing or invalid
   * token — and is turned into that status, with a `WWW-Authenticate`
   * challenge on a 401 so the client knows where to get a token. Anything else
   * is ours: logged in full, reported as a generic 500.
   */
  async #authenticate(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<McpAuthInfo | null> {
    const token = bearerToken(req)
    try {
      return await this.#options.auth!.authenticate({
        ctx: this.#options.root.ctx,
        req,
        token,
        resource: `${url.origin}${this.path}`,
      })
    } catch (err) {
      if (!isHttpError(err)) {
        this.#reportInternal(err, this.#options.auth!.file ?? "mcp/auth")
        writeJsonRpcError(res, 500, -32603, "Internal error")
        return null
      }
      const status = err.status
      const message = errorText(err)
      if (status === 401) {
        this.#challenge(res, url, "invalid_token", message)
      } else {
        writeJsonRpcError(res, status, -32003, message)
      }
      return null
    }
  }

  /** Answers a request that lacks a usable token with an RFC 6750 challenge. */
  #challenge(res: ServerResponse, url: URL, code: string, description: string): void {
    const metadata = `${url.origin}${OAUTH_METADATA_PATH}${this.path}`
    const params = [
      `resource_metadata="${metadata}"`,
      `error="${code}"`,
      `error_description="${description.replace(/"/g, "'")}"`,
    ].join(", ")
    res.writeHead(401, {
      "content-type": "application/json",
      "www-authenticate": `Bearer ${params}`,
    })
    res.end(JSON.stringify({ error: code, error_description: description }))
  }

  /**
   * Resolves the auth metadata, invoking a factory against the root context on
   * first use and caching the result. A factory lets the document depend on
   * DI-resolved values that do not exist when `mcp/auth.ts` is imported.
   */
  async #metadata(): Promise<McpProtectedResourceMetadata> {
    if (this.#resolvedMetadata) return this.#resolvedMetadata
    const { metadata } = this.#options.auth!
    this.#resolvedMetadata =
      typeof metadata === "function" ? await metadata({ ctx: this.#options.root.ctx }) : metadata
    return this.#resolvedMetadata
  }

  /** Serves the RFC 9728 protected-resource metadata document. */
  async #serveMetadata(res: ServerResponse, url: URL): Promise<void> {
    let metadata: McpProtectedResourceMetadata
    try {
      metadata = await this.#metadata()
    } catch (err) {
      this.#reportInternal(err, this.#options.auth!.file ?? "mcp/auth")
      writeJsonRpcError(res, 500, -32603, "Internal error")
      return
    }
    const { authorizationServers, scopesSupported, resourceName, ...rest } = metadata
    const body = {
      resource: `${url.origin}${this.path}`,
      authorization_servers: authorizationServers,
      ...(scopesSupported ? { scopes_supported: scopesSupported } : {}),
      ...(resourceName ? { resource_name: resourceName } : {}),
      bearer_methods_supported: ["header"],
      ...rest,
    }
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "public, max-age=3600",
    })
    res.end(JSON.stringify(body))
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

/** The bearer token from the `Authorization` header, or null. */
function bearerToken(req: IncomingMessage): string | null {
  const header = headerValue(req, "authorization")
  const match = header?.match(/^Bearer[ ]+(.+)$/i)
  return match?.[1]?.trim() ?? null
}

/**
 * True for the protected-resource metadata endpoint. Both the bare path and
 * its path-suffixed form (`.../oauth-protected-resource/mcp`) are recognised,
 * since clients derive the latter from a resource that has a path.
 */
function isMetadataPath(path: string): boolean {
  return path === OAUTH_METADATA_PATH || path.startsWith(`${OAUTH_METADATA_PATH}/`)
}

/** The request scheme, honouring a terminating proxy's `x-forwarded-proto`. */
function scheme(req: IncomingMessage): string {
  const forwarded = headerValue(req, "x-forwarded-proto")?.split(",")[0]?.trim()
  if (forwarded) return forwarded
  return (req.socket as { encrypted?: boolean }).encrypted ? "https" : "http"
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
