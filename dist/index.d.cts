import { R as RouteHandlerFn, a as RouteDefinition, D as DiSpec, b as DiDefinition, M as MiddlewareFn, c as MiddlewareDefinition, S as ServiceFactory, d as ServiceDefinition, e as SseHandlerFn, f as SseRouteDefinition, W as WsHandlerFn, g as WsDefinition } from './runtime-IsKMEuKt.cjs';
export { C as CloveRequest, h as CloveResponse, i as CookieOptions, j as Ctx, H as HttpMethod, L as LifecycleHooks, k as Lifetime, l as LogLevel, m as Logger, n as MemorySessionStore, o as MiddlewareArgs, p as Route, q as RouteMeta, r as RuntimeCtx, s as SessionStore, t as SseArgs, u as SseEvent, v as SseOptions, V as ValueFactory, w as WsArgs, x as createLogger } from './runtime-IsKMEuKt.cjs';
export { C as CloveBootError, H as HttpError, e as error, i as isHttpError } from './errors-il7qK9dp.cjs';
import { Server } from 'node:http';
import { A as AppOptions, C as CloveApp } from './app-SL2sUO4j.cjs';
export { c as createApp } from './app-SL2sUO4j.cjs';
import 'node:stream';

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
declare function service<M>(factory: ServiceFactory<M>): ServiceDefinition<M>;
declare function di<T>(spec: DiSpec<T>): DiDefinition<T>;
declare function ws(handler: WsHandlerFn): WsDefinition;
/**
 * Declares a Server-Sent Events endpoint. Lives in `api/` like any GET route —
 * it flows through the HTTP middleware chain and supports path params — but the
 * handler receives a push-oriented {@link SseArgs} instead of `(req, res)`, and
 * the connection stays open until the client disconnects or `close()` is called.
 *
 * Stream options are set with a chainable `.options()`, the way routes carry
 * `.meta()`: `sse(handler).options({ heartbeat: 15_000 })`.
 */
declare function sse(handler: SseHandlerFn): SseRouteDefinition;

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

interface LoadEnvOptions {
    /** Directory the `.env` files are resolved against. */
    rootDir: string;
    /** Selects the `.env.<mode>` variants. Defaults to `NODE_ENV`. */
    mode?: string;
    /** Explicit file list, relative to `rootDir` or absolute. Skips the cascade. */
    files?: string[];
}
/**
 * Loads `.env` files into `process.env`.
 *
 * Variables already present in the real environment always win, so an exported
 * shell variable or a value injected by the deployment platform is never
 * clobbered by a file checked into the repo.
 *
 * Returns the keys that were actually applied.
 */
declare function loadEnv(options: LoadEnvOptions): string[];
/**
 * Parses dotenv syntax: `KEY=value`, optional `export` prefix, `#` comments,
 * and single, double or backtick quoting. Double-quoted values expand `\n`,
 * `\r`, `\t` and escaped quotes, and may span multiple lines.
 */
declare function parseEnv(contents: string): Record<string, string>;

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

export { AppOptions, type BootstrapOptions, type Clove, CloveApp, type CloveDi, type CloveEngine, type CloveService, DiDefinition, DiSpec, type LoadEnvOptions, MiddlewareDefinition, MiddlewareFn, RouteDefinition, RouteHandlerFn, ServiceDefinition, ServiceFactory, SseHandlerFn, SseRouteDefinition, WsDefinition, WsHandlerFn, all, bootstrap, del, di, engine, get, head, loadEnv, middleware, options, parseEnv, patch, post, put, service, sse, ws };
