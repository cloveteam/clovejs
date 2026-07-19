import { R as RouteHandlerFn, a as RouteDefinition, D as DiSpec, b as DiDefinition, M as MiddlewareFn, c as MiddlewareDefinition, S as ServiceFactory, d as ServiceDefinition, W as WsHandlerFn, e as WsDefinition, f as Route, g as McpScan, h as Registry, C as Container, L as Logger, i as LogLevel, j as McpRuntime, k as SessionManager } from './runtime-eQBcZdL-.js';
export { l as CloveBootError, m as CloveRequest, n as CloveResponse, o as CookieOptions, p as Ctx, H as HttpError, q as HttpMethod, r as LifecycleHooks, s as Lifetime, t as MemorySessionStore, u as MiddlewareArgs, v as RouteMeta, w as RuntimeCtx, x as SessionStore, V as ValueFactory, y as WsArgs, z as createLogger, A as error, B as isHttpError } from './runtime-eQBcZdL-.js';
import { Server, IncomingMessage, ServerResponse } from 'node:http';
import { Duplex } from 'node:stream';

declare const get: (handler: RouteHandlerFn) => RouteDefinition;
declare const post: (handler: RouteHandlerFn) => RouteDefinition;
declare const put: (handler: RouteHandlerFn) => RouteDefinition;
declare const patch: (handler: RouteHandlerFn) => RouteDefinition;
declare const del: (handler: RouteHandlerFn) => RouteDefinition;
declare const head: (handler: RouteHandlerFn) => RouteDefinition;
declare const options: (handler: RouteHandlerFn) => RouteDefinition;
/** Matches every HTTP method at this path. */
declare const all: (handler: RouteHandlerFn) => RouteDefinition;
declare function middleware(fn: MiddlewareFn): MiddlewareDefinition;
declare function service<T>(factory: ServiceFactory<T>): ServiceDefinition<T>;
declare function di<T>(spec: DiSpec<T>): DiDefinition<T>;
declare function ws(handler: WsHandlerFn): WsDefinition;

interface MatchResult {
    route: Route;
    params: Record<string, string>;
}
/**
 * A prefix-tree router over `/`-separated segments.
 *
 * Matching is deterministic: at each segment a literal match is preferred over
 * a `[param]` match, so `api/users/me.get.ts` beats `api/users/[id].get.ts`.
 */
declare class RouterTrie {
    #private;
    add(route: Route): void;
    match(method: string, path: string): MatchResult | null;
    /** True when the path exists under some other method — used for 405s. */
    hasPath(path: string): boolean;
    /** Every registered route, for diagnostics and the dev-server route list. */
    list(): Route[];
}

interface LoadedMiddleware {
    name: string;
    priority: number[] | null;
    fn: MiddlewareDefinition["fn"];
    file: string;
}
interface SocketRoute {
    path: string;
    handler: WsDefinition["handler"];
    file: string;
}
interface ScanResult {
    routes: RouterTrie;
    middlewares: LoadedMiddleware[];
    sockets: RouterTrie;
    socketHandlers: Map<string, SocketRoute>;
    mcp: McpScan;
    registry: Registry;
    /** Every file that contributed, for the dev watcher. */
    files: string[];
}

interface WsRuntimeOptions {
    sockets: RouterTrie;
    handlers: Map<string, SocketRoute>;
    root: Container;
    logger: Logger;
}
/**
 * Routes WebSocket upgrades to `ws/` handlers.
 *
 * Each connection gets its own request-scoped container, disposed when the
 * socket closes. HTTP middlewares do not run for upgrades — authenticate
 * inside the `ws()` handler using `ctx`.
 */
declare class WsRuntime {
    #private;
    constructor(options: WsRuntimeOptions);
    get empty(): boolean;
    /** Attaches the upgrade listener to an HTTP server. */
    attach(server: Server): void;
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
    /** Closes every open socket and disposes their scopes. */
    close(): Promise<void>;
}

interface AppOptions {
    /** Project root. Defaults to `process.cwd()`. */
    rootDir?: string;
    /** Overrides the auto-detected `src/` vs project-root source directory. */
    sourceDir?: string;
    logLevel?: LogLevel;
    /** Maximum request body size in bytes. */
    bodyLimit?: number;
    /** Secret used to sign the session cookie. Falls back to `CLOVE_SECRET`. */
    sessionSecret?: string;
    sessionTtl?: number;
    /** Include error messages and stacks in 500 responses. Defaults to dev-only. */
    exposeErrors?: boolean;
    /**
     * Cache evaluated modules. Defaults to true; the dev server sets it false so
     * that a reload actually re-reads changed files.
     */
    moduleCache?: boolean;
    /** Path the MCP endpoint is served from. Defaults to `/mcp`. */
    mcpPath?: string;
    /** Name and version reported to MCP clients. Defaults to the package name. */
    mcpServerInfo?: {
        name: string;
        version: string;
    };
}
/**
 * A booted application: registry, router, middleware chain and DI root, with
 * no listening socket of its own.
 */
declare class CloveApp {
    #private;
    readonly registry: Registry;
    readonly routes: RouterTrie;
    readonly root: Container;
    readonly logger: Logger;
    readonly ws: WsRuntime;
    readonly mcp: McpRuntime;
    readonly sessions: SessionManager;
    readonly scan: ScanResult;
    constructor(scan: ScanResult, root: Container, logger: Logger, sessions: SessionManager, ws: WsRuntime, mcp: McpRuntime, options: Required<Pick<AppOptions, "bodyLimit" | "exposeErrors">>);
    /**
     * Handles one request. Returns false when no route matched, so an Express
     * host can fall through to its own stack.
     */
    handle(rawReq: IncomingMessage, rawRes: ServerResponse): Promise<boolean>;
    /** A node `request` listener that 404s unmatched paths. */
    get listener(): (req: IncomingMessage, res: ServerResponse) => void;
    /** An Express-compatible middleware: unmatched requests call `next()`. */
    get middleware(): (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => void;
    attachUpgrade(server: Server): void;
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
    /** Disposes sockets, sessions and the singleton scope, in that order. */
    close(): Promise<void>;
}
/**
 * Scans the project and wires up an application without starting a server.
 *
 * This is the shared path behind `bootstrap()` and `engine()`.
 */
declare function createApp(options?: AppOptions): Promise<CloveApp>;

interface BootstrapOptions extends AppOptions {
    port?: number;
    host?: string;
    /** Register SIGINT/SIGTERM handlers for graceful shutdown. Default true. */
    handleSignals?: boolean;
}
interface Clove {
    app: CloveApp;
    server: Server;
    port: number;
    host: string;
    url: string;
    close(): Promise<void>;
}
/**
 * Boots the project and starts listening.
 *
 * ```ts
 * import { bootstrap } from "clovejs"
 * bootstrap()
 * ```
 */
declare function bootstrap(options?: BootstrapOptions): Promise<Clove>;
/**
 * Boots the project without listening, for mounting inside another server.
 *
 * ```ts
 * const app = express()
 * const clove = await engine(app)
 * app.listen(3000)
 * ```
 *
 * When an Express app is passed it is mounted automatically; otherwise the
 * returned engine can be used as a handler with `app.use(clove.middleware)`.
 * WebSockets need the host's server: `clove.attachUpgrade(server)`.
 */
declare function engine(host?: ExpressLike, options?: AppOptions): Promise<CloveEngine>;
interface ExpressLike {
    use(handler: (...args: any[]) => void): unknown;
}
type CloveEngine = CloveApp["middleware"] & {
    app: CloveApp;
    middleware: CloveApp["middleware"];
    listener: CloveApp["listener"];
    attachUpgrade(server: Server): void;
    close(): Promise<void>;
};

/**
 * Extracts the value a `service(...)` definition resolves to. Used by the
 * generated `.clove/types.d.ts`.
 */
type CloveService<T> = T extends ServiceDefinition<infer R> ? Awaited<R> : never;
/**
 * Extracts the value a `di(...)` definition resolves to. Used by the generated
 * `.clove/types.d.ts`.
 */
type CloveDi<T> = T extends DiDefinition<infer R> ? R extends (...args: any[]) => infer F ? Awaited<F> : R : never;

export { type AppOptions, type BootstrapOptions, type Clove, CloveApp, type CloveDi, type CloveEngine, type CloveService, DiDefinition, DiSpec, LogLevel, Logger, MiddlewareDefinition, MiddlewareFn, Route, RouteDefinition, RouteHandlerFn, ServiceDefinition, ServiceFactory, WsDefinition, WsHandlerFn, all, bootstrap, createApp, del, di, engine, get, head, middleware, options, patch, post, put, service, ws };
