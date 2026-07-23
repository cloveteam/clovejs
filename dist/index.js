import {
  CloveApp,
  CloveRequest,
  CloveResponse,
  MemorySessionStore,
  createApp,
  createLogger,
  loadEnv,
  parseEnv
} from "./chunk-HJL3P54M.js";
import {
  CloveBootError,
  HttpError,
  KIND,
  META,
  error,
  isHttpError
} from "./chunk-LVQ3EFBC.js";

// src/definitions.ts
function route(method, handler) {
  const def = {
    [KIND]: "route",
    [META]: {},
    method,
    handler,
    meta(meta) {
      Object.assign(def[META], meta);
      return def;
    }
  };
  return def;
}
var get = (handler) => route("GET", handler);
var post = (handler) => route("POST", handler);
var put = (handler) => route("PUT", handler);
var patch = (handler) => route("PATCH", handler);
var del = (handler) => route("DELETE", handler);
var head = (handler) => route("HEAD", handler);
var options = (handler) => route("OPTIONS", handler);
var all = (handler) => route("ALL", handler);
function middleware(fn) {
  return { [KIND]: "middleware", fn };
}
function service(factory) {
  return { [KIND]: "service", factory };
}
function di(spec) {
  return {
    [KIND]: "di",
    lifetime: spec.lifetime,
    value: spec.value,
    isFactory: typeof spec.value === "function"
  };
}
function ws(handler) {
  return { [KIND]: "ws", handler };
}

// src/bootstrap.ts
import { createServer } from "http";
async function bootstrap(options2 = {}) {
  const app = await createApp(options2);
  const port = options2.port ?? Number(process.env.PORT ?? 3e3);
  const host = options2.host ?? process.env.HOST ?? "localhost";
  const server = createServer(app.listener);
  app.attachUpgrade(server);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const url = `http://${host}:${actualPort}`;
  const routeCount = app.routes.list().length;
  const socketCount = app.scan.socketHandlers.size;
  const { tools } = app.mcp.counts;
  app.logger.info(
    `CloveJS listening on ${url} \u2014 ${routeCount} route${routeCount === 1 ? "" : "s"}` + (socketCount ? `, ${socketCount} socket${socketCount === 1 ? "" : "s"}` : "") + (app.mcp.empty ? "" : `, MCP on ${app.mcp.path} with ${tools} tool${tools === 1 ? "" : "s"}`)
  );
  let closing;
  const close = async () => {
    closing ??= (async () => {
      await new Promise((resolve) => server.close(() => resolve()));
      server.closeAllConnections?.();
      await app.close();
    })();
    return closing;
  };
  if (options2.handleSignals !== false) {
    const onSignal = (signal) => {
      app.logger.info(`Received ${signal}, shutting down.`);
      void close().then(
        () => process.exit(0),
        (err) => {
          app.logger.error("Error during shutdown:", err);
          process.exit(1);
        }
      );
    };
    process.once("SIGINT", () => onSignal("SIGINT"));
    process.once("SIGTERM", () => onSignal("SIGTERM"));
  }
  return { app, server, port: actualPort, host, url, close };
}
async function engine(host, options2 = {}) {
  const app = await createApp(options2);
  if (host && typeof host.use === "function") {
    host.use(app.middleware);
  }
  return Object.assign(app.middleware, {
    app,
    middleware: app.middleware,
    listener: app.listener,
    attachUpgrade: (server) => app.attachUpgrade(server),
    close: () => app.close()
  });
}
export {
  CloveApp,
  CloveBootError,
  CloveRequest,
  CloveResponse,
  HttpError,
  MemorySessionStore,
  all,
  bootstrap,
  createApp,
  createLogger,
  del,
  di,
  engine,
  error,
  get,
  head,
  isHttpError,
  loadEnv,
  middleware,
  options,
  parseEnv,
  patch,
  post,
  put,
  service,
  ws
};
//# sourceMappingURL=index.js.map