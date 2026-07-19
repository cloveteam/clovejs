import { IncomingMessage, ServerResponse, Server } from 'node:http';
import { Duplex } from 'node:stream';

/**
 * The request object handed to route handlers and middlewares.
 *
 * Wraps `IncomingMessage` rather than extending it, so the surface stays small
 * and predictable. The raw node request is available as `req.raw`.
 */
declare class CloveRequest {
    #private;
    readonly raw: IncomingMessage;
    readonly method: string;
    readonly path: string;
    readonly query: Record<string, string>;
    /** Route parameters, e.g. `{ id: "1" }` for `api/users/[id].get.ts`. */
    params: Record<string, string>;
    constructor(raw: IncomingMessage, bodyLimit?: number);
    get url(): URL;
    get headers(): NodeJS.Dict<string | string[]>;
    header(name: string): string | undefined;
    /** Parsed request cookies, keyed by name. */
    get cookie(): Record<string, string>;
    /** Alias of {@link cookie}, for readers who expect the plural. */
    get cookies(): Record<string, string>;
    /**
     * The parsed body. Populated by the pipeline before handlers run, so it is
     * safe to access synchronously as `req.body`.
     */
    get body(): any;
    set body(value: any);
    /** Reads and parses the body if it has not been consumed yet. */
    readBody(): Promise<unknown>;
    /** Reads the untouched body bytes. Only valid if the body was not parsed. */
    rawBody(): Promise<Buffer>;
    get ip(): string | undefined;
}

interface CookieOptions {
    domain?: string;
    path?: string;
    expires?: Date;
    maxAge?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "strict" | "lax" | "none";
    partitioned?: boolean;
}

/**
 * The response object handed to route handlers and middlewares.
 *
 * Handlers usually just return a value and let the JSON middleware do the
 * writing; this class is for the cases that need explicit control.
 */
declare class CloveResponse {
    #private;
    readonly raw: ServerResponse;
    constructor(raw: ServerResponse);
    get sent(): boolean;
    /** Whether the handler chose the content type rather than inheriting it. */
    get typeIsExplicit(): boolean;
    get statusCode(): number;
    status(code: number): this;
    /**
     * Sets the `Content-Type`. Accepts either a full MIME type or one of the
     * shorthands (`"html"`, `"json"`, `"text"`, ...).
     *
     * Setting a non-JSON type disables the built-in JSON middleware.
     */
    type(value: string): this;
    /** The content type currently set on the response, if any. */
    get contentType(): string | undefined;
    header(name: string, value: string | string[] | number): this;
    /** Alias of {@link header}, for readers coming from Express. */
    set(name: string, value: string | string[] | number): this;
    cookie(name: string, value: string, opts?: CookieOptions): this;
    clearCookie(name: string, opts?: CookieOptions): this;
    redirect(location: string, status?: number): this;
    /**
     * Writes a body and ends the response. Objects are JSON-serialized; strings
     * and buffers are written as-is with a sensible default content type.
     */
    send(body?: unknown): this;
    json(body: unknown): this;
    /** Ends the response with no body. */
    end(): this;
}

/**
 * The dependency injection context.
 *
 * This interface is intentionally empty in the framework itself. User projects
 * get it augmented by the generated `.clove/types.d.ts`, which declares one
 * property per file in `services/` and `di/`.
 */
interface Ctx {
}
/** `ctx` as seen at runtime: the augmented interface plus arbitrary keys. */
type RuntimeCtx = Ctx & Record<string, any>;
type Lifetime = "singleton" | "session" | "request";
declare const KIND: unique symbol;
type DefinitionKind = "route" | "middleware" | "service" | "di" | "ws";
interface Definition<K extends DefinitionKind> {
    readonly [KIND]: K;
}
type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
/** Hook registrar handed to service / di / ws factories. */
interface LifecycleHooks {
    onDestroy(fn: () => void | Promise<void>): void;
}
type RouteHandlerFn = (req: CloveRequest, res: CloveResponse, ctx: RuntimeCtx) => unknown | Promise<unknown>;
interface RouteMeta {
    /** Set `false` to disable the built-in JSON middleware for this route. */
    json?: boolean;
    [key: string]: unknown;
}
declare const META: unique symbol;
interface RouteDefinition extends Definition<"route"> {
    method: HttpMethod | "ALL";
    handler: RouteHandlerFn;
    /** Collected metadata. Read by the scanner, written by `.meta()`. */
    [META]: RouteMeta;
    /** Attach route metadata. Chainable; merges with any previous call. */
    meta(meta: RouteMeta): RouteDefinition;
}
/** A route as registered in the router, with its resolved path and origin. */
interface Route {
    method: HttpMethod | "ALL";
    path: string;
    handler: RouteHandlerFn;
    meta: Readonly<RouteMeta>;
    /** Absolute path of the file this route came from. Used in error messages. */
    file: string;
}
interface MiddlewareArgs {
    route: Route;
    handler: {
        execute(): Promise<unknown>;
    };
    req: CloveRequest;
    res: CloveResponse;
    ctx: RuntimeCtx;
}
type MiddlewareFn = (args: MiddlewareArgs) => unknown | Promise<unknown>;
interface MiddlewareDefinition extends Definition<"middleware"> {
    fn: MiddlewareFn;
}
/**
 * A service factory.
 *
 * The return type is a bare `T` rather than `T | Promise<T>` on purpose: with a
 * union, `this` inside the returned object literal widens to include
 * `PromiseLike`, and calling a sibling method (`this.sign(user)`) stops
 * type-checking. Callers unwrap with `Awaited<T>` instead.
 */
type ServiceFactory<T = any> = (ctx: RuntimeCtx, hooks: LifecycleHooks) => T;
interface ServiceDefinition<T = any> extends Definition<"service"> {
    factory: ServiceFactory<T>;
}
type ValueFactory<T = any> = (ctx: RuntimeCtx, hooks: LifecycleHooks) => T;
interface DiSpec<T = any> {
    lifetime: Lifetime;
    value: T | ValueFactory<T>;
}
interface DiDefinition<T = any> extends Definition<"di"> {
    lifetime: Lifetime;
    value: T | ValueFactory<T>;
    /** True when `value` was supplied as a factory function. */
    isFactory: boolean;
}
interface WsArgs {
    onMessage(fn: (msg: string | Buffer) => void | Promise<void>): void;
    onClose(fn: () => void | Promise<void>): void;
    onDestroy(fn: () => void | Promise<void>): void;
    send(data: string | Buffer | object): void;
    close(code?: number, reason?: string): void;
    ctx: RuntimeCtx;
    req: CloveRequest;
    params: Record<string, string>;
}
type WsHandlerFn = (args: WsArgs) => void | Promise<void>;
interface WsDefinition extends Definition<"ws"> {
    handler: WsHandlerFn;
}

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

/**
 * Brands HTTP errors so they are recognised across module copies.
 *
 * `instanceof` is not enough: a project can end up with more than one copy of
 * the framework loaded (ESM alongside CJS, or a hoisting miss), and an error
 * thrown by one copy must still be rendered by the other.
 */
declare const HTTP_ERROR: unique symbol;
/**
 * An HTTP error that the pipeline renders into a response instead of a 500.
 * Anything else thrown from a handler is treated as an unexpected failure.
 */
declare class HttpError extends Error {
    readonly status: number;
    readonly body: unknown;
    readonly expose = true;
    readonly [HTTP_ERROR] = true;
    constructor(status: number, body?: unknown);
}
/**
 * Creates an HTTP error to throw from a handler, middleware or service.
 *
 * ```ts
 * throw error(400, { message: "username and password are required" })
 * ```
 */
declare function error(status: number, body?: unknown): HttpError;
declare function isHttpError(value: unknown): value is HttpError;
/**
 * A failure detected while scanning and validating the project, before the
 * server starts. These always name the offending file so the user can act.
 */
declare class CloveBootError extends Error {
    readonly files: string[];
    constructor(message: string, files?: string[]);
}

type ProviderKind = "service" | "di" | "builtin";
interface Provider {
    key: string;
    kind: ProviderKind;
    lifetime: Lifetime;
    /** Absolute file the provider came from, or a builtin marker. */
    file: string;
    /** Present when the provider computes its value. */
    factory?: (ctx: RuntimeCtx, hooks: LifecycleHooks) => unknown;
    /** Present when the provider is a plain literal value. */
    value?: unknown;
    isFactory: boolean;
}
/**
 * The set of everything injectable, keyed by the name it takes on `ctx`.
 *
 * Built once at boot from `services/` and `di/`, then treated as immutable by
 * the containers that read it.
 */
declare class Registry {
    #private;
    add(provider: Provider): void;
    get(key: string): Provider | undefined;
    has(key: string): boolean;
    keys(): string[];
    all(): Provider[];
    byLifetime(lifetime: Lifetime): Provider[];
}

/**
 * One lifetime scope's worth of resolved dependencies.
 *
 * Containers form a chain — request -> session -> singleton — and a provider is
 * always resolved and cached in the container matching its declared lifetime,
 * no matter which container the lookup started from.
 */
declare class Container {
    #private;
    readonly scope: Lifetime;
    readonly parent?: Container;
    readonly registry: Registry;
    constructor(registry: Registry, scope: Lifetime, parent?: Container);
    /** The proxy handed to handlers, middlewares and factories as `ctx`. */
    get ctx(): RuntimeCtx;
    createChild(scope: Lifetime): Container;
    /** Walks up to the container that owns the given lifetime. */
    containerFor(lifetime: Lifetime): Container;
    /**
     * Looks up a key across the scope chain.
     *
     * Returns the cached value when it is already resolved, a promise when a
     * factory has to run, or `undefined` when nothing provides the key.
     */
    get(key: string): unknown;
    /**
     * Assigns a value, e.g. `ctx.user = ...` from a middleware.
     *
     * The target scope comes from the provider declaration when one exists;
     * undeclared keys land in the current scope.
     */
    set(key: string, value: unknown): void;
    has(key: string): boolean;
    /** True when the key already has a value and access will not return a promise. */
    isResolved(key: string): boolean;
    /** Resolves a provider and awaits it. Used at boot and by `ensure()`. */
    resolveAsync(key: string): Promise<unknown>;
    /**
     * Forces the given keys (default: everything owned by this scope) to resolve
     * so later synchronous `ctx.x` access never yields a promise.
     */
    ensure(keys?: string[]): Promise<void>;
    registerDestroyHook(fn: () => void | Promise<void>): void;
    get disposed(): boolean;
    /**
     * Runs this scope's `onDestroy` hooks in reverse registration order, so
     * dependents tear down before their dependencies.
     */
    dispose(): Promise<void>;
}

type LogLevel = "debug" | "info" | "warn" | "error" | "silent";
interface Logger {
    debug(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
}
/**
 * The default `ctx.logger`. Deliberately minimal — projects that want more can
 * define `services/logger.ts` or `di/logger.ts` and it takes over the key.
 */
declare function createLogger(level?: LogLevel): Logger;

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
    registry: Registry;
    /** Every file that contributed, for the dev watcher. */
    files: string[];
}

/**
 * Persistence for session-scoped values.
 *
 * Projects override the default by defining `services/sessionStore.ts` that
 * returns an object with this shape — no config wiring needed, the key is
 * picked up like any other service.
 */
interface SessionStore {
    get(id: string): Promise<Record<string, unknown> | undefined>;
    set(id: string, data: Record<string, unknown>): Promise<void>;
    /** Extends the TTL without rewriting the data. */
    touch(id: string): Promise<void>;
    destroy(id: string): Promise<void>;
}
interface MemorySessionStoreOptions {
    /** Idle lifetime in milliseconds. Defaults to 24 hours. */
    ttl?: number;
    /** Invoked when a session is dropped, so its container can be disposed. */
    onExpire?: (id: string) => void | Promise<void>;
}
/**
 * The default in-process store: a Map with sliding expiry.
 *
 * Fine for a single process; swap it for a Redis-backed store before scaling
 * horizontally.
 */
declare class MemorySessionStore implements SessionStore {
    #private;
    constructor(options?: MemorySessionStoreOptions);
    get(id: string): Promise<Record<string, unknown> | undefined>;
    set(id: string, data: Record<string, unknown>): Promise<void>;
    touch(id: string): Promise<void>;
    destroy(id: string): Promise<void>;
    /** Stops the sweep timer. Called on server shutdown. */
    close(): void;
    get size(): number;
}

interface SessionOptions {
    secret: string;
    cookieName?: string;
    cookie?: CookieOptions;
    store?: SessionStore;
    ttl?: number;
}
/**
 * Maps session ids to live session containers and keeps their contents in the
 * store, so session-scoped `di` values survive across requests.
 */
declare class SessionManager {
    #private;
    readonly store: SessionStore;
    readonly cookieName: string;
    constructor(root: Container, registry: Registry, options: SessionOptions);
    /** True when the project declares at least one session-scoped provider. */
    get needed(): boolean;
    /**
     * Resolves the session container for a request, creating one (and issuing a
     * cookie) only when the request actually carries or needs a session.
     */
    acquire(req: CloveRequest, res: CloveResponse): Promise<{
        container: Container;
        id: string;
        isNew: boolean;
    }>;
    /** Writes the session container's session-scoped values back to the store. */
    persist(id: string, container: Container): Promise<void>;
    destroy(id: string): Promise<void>;
    /** Disposes every live session. Called during server shutdown. */
    disposeAll(): Promise<void>;
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
    readonly sessions: SessionManager;
    readonly scan: ScanResult;
    constructor(scan: ScanResult, root: Container, logger: Logger, sessions: SessionManager, ws: WsRuntime, options: Required<Pick<AppOptions, "bodyLimit" | "exposeErrors">>);
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

export { type AppOptions, type BootstrapOptions, type Clove, CloveApp, CloveBootError, type CloveDi, type CloveEngine, CloveRequest, CloveResponse, type CloveService, type CookieOptions, type Ctx, type DiDefinition, type DiSpec, HttpError, type HttpMethod, type LifecycleHooks, type Lifetime, type LogLevel, type Logger, MemorySessionStore, type MiddlewareArgs, type MiddlewareDefinition, type MiddlewareFn, type Route, type RouteDefinition, type RouteHandlerFn, type RouteMeta, type RuntimeCtx, type ServiceDefinition, type ServiceFactory, type SessionStore, type ValueFactory, type WsArgs, type WsDefinition, type WsHandlerFn, all, bootstrap, createApp, createLogger, del, di, engine, error, get, head, isHttpError, middleware, options, patch, post, put, service, ws };
