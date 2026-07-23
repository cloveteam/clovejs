import {
  CloveApp,
  CloveRequest,
  CloveResponse,
  MemoryCacheStore,
  MemorySessionStore,
  createApp,
  createLogger,
  loadEnv,
  parseEnv
} from "./chunk-BBRJXFJG.js";
import {
  CACHE,
  CloveBootError,
  HttpError,
  INVALIDATES,
  KIND,
  META,
  VIEW,
  error,
  isHttpError,
  isViewResult
} from "./chunk-HUBFYLOZ.js";

// src/http/sse.ts
var SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no"
};
function formatSseEvent(evt) {
  let frame = "";
  if (evt.event) frame += `event: ${evt.event}
`;
  if (evt.id !== void 0) frame += `id: ${evt.id}
`;
  if (evt.retry !== void 0) frame += `retry: ${evt.retry}
`;
  const data = typeof evt.data === "string" ? evt.data : JSON.stringify(evt.data);
  for (const line of data.split("\n")) frame += `data: ${line}
`;
  return frame + "\n";
}
var SseStream = class {
  lastEventId;
  #req;
  #res;
  #options;
  #logger;
  #open = false;
  #closed = false;
  #heartbeat;
  #onClose = [];
  #onDestroy = [];
  #resolveDone;
  /** Resolves once the connection has fully torn down. */
  done;
  constructor(req, res, options2, logger) {
    this.#req = req;
    this.#res = res;
    this.#options = options2;
    this.#logger = logger;
    this.lastEventId = req.header("last-event-id");
    this.done = new Promise((resolve) => {
      this.#resolveDone = resolve;
    });
  }
  get open() {
    return this.#open && !this.#closed;
  }
  /** True once the connection has been torn down. */
  get finished() {
    return this.#closed;
  }
  /**
   * Writes the status line and headers, and starts listening for disconnect.
   * Idempotent, and a no-op after teardown — so the first write of any kind
   * opens the stream, and an idle handler still becomes a valid open stream.
   */
  begin() {
    if (this.#open || this.#closed) return;
    this.#open = true;
    const raw = this.#res.raw;
    raw.writeHead(200, SSE_HEADERS);
    raw.on("close", () => void this.#teardown());
    if (this.#options.retry !== void 0) raw.write(`retry: ${this.#options.retry}

`);
    if (this.#options.heartbeat && this.#options.heartbeat > 0) {
      this.#heartbeat = setInterval(() => this.comment("ping"), this.#options.heartbeat);
      this.#heartbeat.unref?.();
    }
  }
  send(data) {
    this.emit({ data });
  }
  emit(event) {
    if (this.#closed) return;
    this.begin();
    this.#res.raw.write(formatSseEvent(event));
  }
  comment(text) {
    if (this.#closed) return;
    this.begin();
    this.#res.raw.write(`: ${text}

`);
  }
  close() {
    void this.#teardown();
  }
  onClose(fn) {
    this.#onClose.push(fn);
  }
  onDestroy(fn) {
    this.#onDestroy.push(fn);
  }
  /** The push-oriented view handed to the user handler. */
  args(ctx) {
    const view2 = {
      send: (data) => this.send(data),
      emit: (event) => this.emit(event),
      comment: (text) => this.comment(text),
      lastEventId: this.lastEventId,
      onClose: (fn) => this.onClose(fn),
      onDestroy: (fn) => this.onDestroy(fn),
      close: () => this.close(),
      open: this.open,
      ctx,
      req: this.#req,
      params: this.#req.params
    };
    Object.defineProperty(view2, "open", { get: () => this.open, enumerable: true });
    return view2;
  }
  async #teardown() {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    await this.#runHooks(this.#onClose, "onClose");
    await this.#runHooks(this.#onDestroy, "onDestroy");
    if (this.#open && !this.#res.raw.writableEnded) {
      try {
        this.#res.raw.end();
      } catch (err) {
        this.#logger.error("SSE stream failed to close:", err);
      }
    }
    this.#resolveDone();
  }
  async #runHooks(hooks, label) {
    for (const hook of hooks.splice(0)) {
      try {
        await hook();
      } catch (err) {
        this.#logger.error(`SSE ${label} hook threw:`, err);
      }
    }
  }
};
function serveSse(handler, options2) {
  return async (req, res, ctx) => {
    const logger = ctx.logger ?? console;
    const stream = new SseStream(req, res, options2, logger);
    try {
      await handler(stream.args(ctx));
    } catch (err) {
      stream.close();
      await stream.done;
      throw err;
    }
    stream.begin();
    await stream.done;
  };
}

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
    },
    cache(policy) {
      def[CACHE] = policy;
      return def;
    },
    invalidates(tags) {
      def[INVALIDATES] = tags;
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
function views(engine2) {
  return { [KIND]: "views", engine: engine2 };
}
function view(template, data) {
  return { [VIEW]: true, template, data };
}
function sse(handler) {
  const opts = {};
  const def = route("GET", serveSse(handler, opts));
  def[META].json = false;
  def.options = (options2) => {
    Object.assign(opts, options2);
    return def;
  };
  return def;
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
  MemoryCacheStore,
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
  isViewResult,
  loadEnv,
  middleware,
  options,
  parseEnv,
  patch,
  post,
  put,
  service,
  sse,
  view,
  views,
  ws
};
//# sourceMappingURL=index.js.map