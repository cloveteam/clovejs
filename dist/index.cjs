"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all2) => {
  for (var name in all2)
    __defProp(target, name, { get: all2[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var src_exports = {};
__export(src_exports, {
  CloveApp: () => CloveApp,
  CloveBootError: () => CloveBootError,
  CloveRequest: () => CloveRequest,
  CloveResponse: () => CloveResponse,
  HttpError: () => HttpError,
  MemoryCacheStore: () => MemoryCacheStore,
  MemorySessionStore: () => MemorySessionStore,
  all: () => all,
  bootstrap: () => bootstrap,
  createApp: () => createApp,
  createLogger: () => createLogger,
  del: () => del,
  di: () => di,
  engine: () => engine,
  error: () => error,
  get: () => get,
  head: () => head,
  isHttpError: () => isHttpError,
  isViewResult: () => isViewResult,
  loadEnv: () => loadEnv,
  middleware: () => middleware,
  options: () => options,
  parseEnv: () => parseEnv,
  patch: () => patch,
  post: () => post,
  put: () => put,
  service: () => service,
  sse: () => sse,
  view: () => view,
  views: () => views,
  ws: () => ws
});
module.exports = __toCommonJS(src_exports);

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

// src/types.ts
var KIND = /* @__PURE__ */ Symbol.for("clovejs.kind");
var META = /* @__PURE__ */ Symbol.for("clovejs.meta");
var CACHE = /* @__PURE__ */ Symbol.for("clovejs.cache");
var INVALIDATES = /* @__PURE__ */ Symbol.for("clovejs.invalidates");
var VIEW = /* @__PURE__ */ Symbol.for("clovejs.view");
function isViewResult(value) {
  return typeof value === "object" && value !== null && VIEW in value;
}
function isDefinition(value) {
  return typeof value === "object" && value !== null && KIND in value;
}
function definitionKind(value) {
  return isDefinition(value) ? value[KIND] : null;
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

// src/errors.ts
var HTTP_ERROR = /* @__PURE__ */ Symbol.for("clovejs.HttpError");
var HttpError = class extends Error {
  status;
  body;
  expose = true;
  [HTTP_ERROR] = true;
  constructor(status, body) {
    const message = typeof body === "object" && body !== null && "message" in body ? String(body.message) : typeof body === "string" ? body : `HTTP ${status}`;
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.body = body === void 0 ? { message } : body;
  }
};
function error(status, body) {
  return new HttpError(status, body);
}
function isHttpError(value) {
  return value instanceof HttpError || typeof value === "object" && value !== null && value[HTTP_ERROR] === true;
}
var CloveBootError = class extends Error {
  files;
  constructor(message, files = []) {
    super(files.length ? `${message}
${files.map((f) => `  - ${f}`).join("\n")}` : message);
    this.name = "CloveBootError";
    this.files = files;
  }
};

// src/bootstrap.ts
var import_node_http = require("http");

// src/cache/runtime.ts
var import_node_crypto = require("crypto");
var import_node_v8 = require("v8");
var CacheRuntime = class {
  store;
  #logger;
  #pending = /* @__PURE__ */ new Map();
  #transactions = /* @__PURE__ */ new WeakMap();
  #generation = 0;
  constructor(store, logger) {
    this.store = store;
    this.#logger = logger;
  }
  async execute(route2, req, res, ctx, handler) {
    const policy = route2.cache;
    if (!policy || !this.#canUse(policy, req, res)) return handler();
    const context = { route: route2, req, res, ctx };
    let key;
    try {
      key = await this.#key(policy, context);
    } catch (err) {
      this.#logger.error("Failed to build route cache key:", err);
      return handler();
    }
    let existing;
    try {
      existing = await this.store.get(key);
    } catch (err) {
      this.#logger.error("Route cache read failed:", err);
      return handler();
    }
    const now = Date.now();
    if (existing && existing.freshUntil > now) {
      return this.#replay(existing, res);
    }
    const pending = this.#pending.get(key);
    if (pending) {
      if (existing && existing.staleUntil > now) {
        return this.#replay(existing, res);
      }
      const refreshed = await pending.promise;
      if (refreshed) return this.#replay(refreshed, res);
      return handler();
    }
    const deferred = createDeferred();
    this.#pending.set(key, deferred);
    const checkpoint = res.checkpoint();
    try {
      const result = await handler();
      let payload;
      try {
        payload = encodeResult(result);
      } catch {
        this.#finishPending(key, deferred, void 0);
        return result;
      }
      this.#transactions.set(res, {
        key,
        policy,
        context,
        result,
        payload,
        response: res.deltaSince(checkpoint),
        deferred,
        generation: this.#generation
      });
      return result;
    } catch (err) {
      this.#finishPending(key, deferred, void 0);
      throw err;
    }
  }
  /**
   * Publishes a captured handler outcome only after every interceptor has
   * unwound successfully and the final response is known to be cacheable.
   */
  async complete(res, completion) {
    const transaction = this.#transactions.get(res);
    if (!transaction) return;
    this.#transactions.delete(res);
    if (completion.error !== void 0 || res.statusCode !== 200 || !res.replayable || transaction.response.headers.some(([name]) => name === "set-cookie") || transaction.generation !== this.#generation) {
      this.#finishPending(transaction.key, transaction.deferred, void 0);
      return;
    }
    try {
      const now = Date.now();
      const ttl = durationMs(transaction.policy.ttl);
      const stale = durationMs(transaction.policy.staleWhileRevalidate ?? 0);
      const tags = await resolveTags(transaction.policy, {
        ...transaction.context,
        result: transaction.result
      });
      const entry = {
        payload: transaction.payload,
        response: transaction.response,
        freshUntil: now + ttl,
        staleUntil: now + ttl + stale
      };
      await this.store.set(transaction.key, entry, {
        ttl: ttl + stale,
        tags
      });
      this.#finishPending(transaction.key, transaction.deferred, entry);
    } catch (err) {
      this.#logger.error("Route cache write failed:", err);
      this.#finishPending(transaction.key, transaction.deferred, void 0);
    }
  }
  /** Applies browser/CDN headers and conditional request handling. */
  applyClientPolicy(route2, req, res) {
    const policy = route2.cache;
    if (!policy || !res.replayable || res.statusCode !== 200) return;
    if (policy.vary?.length) {
      const existing = String(res.getHeader("vary") ?? "").split(",").map((value) => value.trim()).filter(Boolean);
      const vary = /* @__PURE__ */ new Set([...existing, ...policy.vary.map((name) => name.toLowerCase())]);
      res.header("vary", [...vary].join(", "));
    }
    if (req.header("authorization") || req.header("cookie") || res.getHeader("set-cookie") !== void 0) {
      res.header("cache-control", "private, no-store");
      return;
    }
    if (policy.client === false) {
      res.header("cache-control", "no-store");
      return;
    }
    res.header("cache-control", cacheControl(policy));
    const body = res.bodyBuffer();
    if (!body) return;
    const current = res.getHeader("etag");
    const etag = current === void 0 ? `"${(0, import_node_crypto.createHash)("sha256").update(body).digest("base64url")}"` : String(current);
    res.header("etag", etag);
    if (etagMatches(req.header("if-none-match"), etag)) res.notModified();
  }
  /** Invalidates tags imperatively through `ctx.cache`. */
  async invalidate(tags) {
    const clean = uniqueTags(tags);
    if (clean.length === 0) return;
    this.#generation++;
    await this.store.invalidateTags(clean);
  }
  /** Resolves and applies a mutation route's declarative invalidation. */
  async invalidateRoute(invalidation, context) {
    const tags = typeof invalidation === "function" ? await invalidation(context) : invalidation;
    await this.invalidate(tags);
  }
  #canUse(policy, req, res) {
    if (!res.replayable || res.sent) return false;
    if ((req.header("authorization") || req.header("cookie")) && policy.scope !== "public" && !policy.key) {
      return false;
    }
    return true;
  }
  async #key(policy, context) {
    const { req, route: route2 } = context;
    const query = [...req.url.searchParams.entries()].sort(([ak, av], [bk, bv]) => ak.localeCompare(bk) || av.localeCompare(bv));
    const vary = (policy.vary ?? []).map((name) => [name.toLowerCase(), req.header(name) ?? ""]).sort(([a], [b]) => a.localeCompare(b));
    const custom = policy.key ? await policy.key(context) : "";
    const identity = JSON.stringify({
      method: req.method,
      route: route2.path,
      params: Object.entries(req.params).sort(([a], [b]) => a.localeCompare(b)),
      query,
      vary,
      custom
    });
    return (0, import_node_crypto.createHash)("sha256").update(identity).digest("base64url");
  }
  #replay(entry, res) {
    const result = decodeResult(entry.payload);
    res.applyDelta(entry.response);
    return result;
  }
  #finishPending(key, deferred, entry) {
    if (this.#pending.get(key) === deferred) this.#pending.delete(key);
    deferred.resolve(entry);
  }
};
function validateCachePolicy(policy) {
  durationMs(policy.ttl);
  if (policy.scope !== void 0 && !["public", "private"].includes(policy.scope)) {
    throw new TypeError(`Cache scope must be "public" or "private".`);
  }
  if (policy.staleWhileRevalidate !== void 0) {
    durationMs(policy.staleWhileRevalidate);
  }
  for (const value of [
    policy.client && policy.client.maxAge,
    policy.client && policy.client.sharedMaxAge,
    policy.client && policy.client.staleWhileRevalidate
  ]) {
    if (value !== false && value !== void 0) durationMs(value);
  }
  if (policy.client && policy.client.private && policy.client.sharedMaxAge !== void 0) {
    throw new TypeError("A private client cache cannot declare sharedMaxAge.");
  }
}
function durationMs(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError(`Cache duration must be a non-negative finite number.`);
    }
    return value;
  }
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(value);
  if (!match) {
    throw new TypeError(
      `Invalid cache duration "${value}". Use milliseconds or values such as "30s", "5m" or "1h".`
    );
  }
  const multiplier = { ms: 1, s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[match[2]];
  return Number(match[1]) * multiplier;
}
function encodeResult(result) {
  if (isViewResult(result)) {
    return (0, import_node_v8.serialize)({ kind: "view", template: result.template, data: result.data });
  }
  return (0, import_node_v8.serialize)({ kind: "value", value: result });
}
function decodeResult(payload) {
  const decoded = (0, import_node_v8.deserialize)(payload);
  if (decoded.kind === "view") {
    return { [VIEW]: true, template: decoded.template, data: decoded.data };
  }
  return decoded.value;
}
async function resolveTags(policy, context) {
  if (!policy.tags) return [];
  const tags = typeof policy.tags === "function" ? await policy.tags(context) : policy.tags;
  return uniqueTags(tags);
}
function uniqueTags(tags) {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
}
function cacheControl(policy) {
  const client = policy.client;
  if (!client) return "private, no-cache";
  const isPrivate = client.private ?? client.sharedMaxAge === void 0;
  const parts = [isPrivate ? "private" : "public"];
  if (client.maxAge !== void 0) {
    parts.push(`max-age=${Math.floor(durationMs(client.maxAge) / 1e3)}`);
  } else {
    parts.push("max-age=0");
  }
  if (client.sharedMaxAge !== void 0) {
    parts.push(`s-maxage=${Math.floor(durationMs(client.sharedMaxAge) / 1e3)}`);
  }
  if (client.staleWhileRevalidate !== void 0) {
    parts.push(
      `stale-while-revalidate=${Math.floor(
        durationMs(client.staleWhileRevalidate) / 1e3
      )}`
    );
  }
  if (client.immutable) parts.push("immutable");
  return parts.join(", ");
}
function etagMatches(header, etag) {
  if (!header) return false;
  const target = etag.replace(/^W\//, "");
  return header.split(",").some((candidate) => {
    const value = candidate.trim();
    return value === "*" || value.replace(/^W\//, "") === target;
  });
}
function createDeferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// src/cache/store.ts
var MemoryCacheStore = class {
  #entries = /* @__PURE__ */ new Map();
  #tagKeys = /* @__PURE__ */ new Map();
  async get(key) {
    const entry = this.#entries.get(key);
    if (!entry) return void 0;
    if (entry.expiresAt <= Date.now()) {
      this.#drop(key, entry);
      return void 0;
    }
    return cloneEntry(entry.value);
  }
  async set(key, value, options2) {
    const previous = this.#entries.get(key);
    if (previous) this.#drop(key, previous);
    const tags = new Set(options2.tags);
    const entry = {
      value: cloneEntry(value),
      expiresAt: Date.now() + options2.ttl,
      tags
    };
    this.#entries.set(key, entry);
    for (const tag of tags) {
      let keys = this.#tagKeys.get(tag);
      if (!keys) {
        keys = /* @__PURE__ */ new Set();
        this.#tagKeys.set(tag, keys);
      }
      keys.add(key);
    }
  }
  async delete(key) {
    const entry = this.#entries.get(key);
    if (entry) this.#drop(key, entry);
  }
  async invalidateTags(tags) {
    const keys = /* @__PURE__ */ new Set();
    for (const tag of tags) {
      for (const key of this.#tagKeys.get(tag) ?? []) keys.add(key);
    }
    for (const key of keys) {
      const entry = this.#entries.get(key);
      if (entry) this.#drop(key, entry);
    }
  }
  clear() {
    this.#entries.clear();
    this.#tagKeys.clear();
  }
  get size() {
    return this.#entries.size;
  }
  #drop(key, entry) {
    this.#entries.delete(key);
    for (const tag of entry.tags) {
      const keys = this.#tagKeys.get(tag);
      keys?.delete(key);
      if (keys?.size === 0) this.#tagKeys.delete(tag);
    }
  }
};
function isCacheStore(value) {
  if (typeof value !== "object" || value === null) return false;
  const v = value;
  return typeof v.get === "function" && typeof v.set === "function" && typeof v.delete === "function" && typeof v.invalidateTags === "function";
}
function cloneEntry(entry) {
  return {
    payload: Buffer.from(entry.payload),
    response: {
      ...entry.response,
      headers: entry.response.headers.map(([name, value]) => [
        name,
        Array.isArray(value) ? [...value] : value
      ]),
      ...entry.response.removedHeaders ? { removedHeaders: [...entry.response.removedHeaders] } : {},
      ...entry.response.body ? { body: Buffer.from(entry.response.body) } : {}
    },
    freshUntil: entry.freshUntil,
    staleUntil: entry.staleUntil
  };
}

// src/container/container.ts
var SCOPE_DEPTH = {
  singleton: 0,
  session: 1,
  request: 2
};
var CircularDependencyError = class extends Error {
  constructor(chain) {
    super(`Circular dependency detected: ${chain.join(" -> ")}`);
    this.name = "CircularDependencyError";
  }
};
var Container = class _Container {
  scope;
  parent;
  registry;
  #values = /* @__PURE__ */ new Map();
  #pending = /* @__PURE__ */ new Map();
  #destroyHooks = [];
  #resolving = [];
  #ctx;
  #disposed = false;
  constructor(registry, scope, parent) {
    this.registry = registry;
    this.scope = scope;
    this.parent = parent;
  }
  /** The proxy handed to handlers, middlewares and factories as `ctx`. */
  get ctx() {
    this.#ctx ??= createCtxProxy(this);
    return this.#ctx;
  }
  createChild(scope) {
    return new _Container(this.registry, scope, this);
  }
  /** Walks up to the container that owns the given lifetime. */
  containerFor(lifetime) {
    let node = this;
    while (SCOPE_DEPTH[node.scope] > SCOPE_DEPTH[lifetime] && node.parent) {
      node = node.parent;
    }
    return node;
  }
  /**
   * Looks up a key across the scope chain.
   *
   * Returns the cached value when it is already resolved, a promise when a
   * factory has to run, or `undefined` when nothing provides the key.
   */
  get(key) {
    for (let node = this; node; node = node.parent) {
      if (node.#values.has(key)) return node.#values.get(key);
    }
    const provider = this.registry.get(key);
    if (!provider) return void 0;
    const owner = this.containerFor(provider.lifetime);
    return owner.#resolve(provider);
  }
  /**
   * Assigns a value, e.g. `ctx.user = ...` from a middleware.
   *
   * The target scope comes from the provider declaration when one exists;
   * undeclared keys land in the current scope.
   */
  set(key, value) {
    const provider = this.registry.get(key);
    const owner = provider ? this.containerFor(provider.lifetime) : this;
    owner.#values.set(key, value);
    owner.#pending.delete(key);
  }
  has(key) {
    for (let node = this; node; node = node.parent) {
      if (node.#values.has(key)) return true;
    }
    return this.registry.has(key);
  }
  /** True when the key already has a value and access will not return a promise. */
  isResolved(key) {
    for (let node = this; node; node = node.parent) {
      if (node.#values.has(key)) return true;
    }
    return false;
  }
  /** Resolves a provider inside this container, memoizing the result. */
  #resolve(provider) {
    if (this.#values.has(provider.key)) return this.#values.get(provider.key);
    const pending = this.#pending.get(provider.key);
    if (pending) return pending;
    if (!provider.isFactory) {
      this.#values.set(provider.key, provider.value);
      return provider.value;
    }
    if (this.#resolving.includes(provider.key)) {
      throw new CircularDependencyError([...this.#resolving, provider.key]);
    }
    const hooks = {
      onDestroy: (fn) => this.#destroyHooks.push(fn)
    };
    this.#resolving.push(provider.key);
    let result;
    try {
      result = provider.factory(this.ctx, hooks);
    } finally {
      this.#resolving.pop();
    }
    if (isPromiseLike(result)) {
      const promise = Promise.resolve(result).then(
        (value) => {
          this.#values.set(provider.key, value);
          this.#pending.delete(provider.key);
          return value;
        },
        (err) => {
          this.#pending.delete(provider.key);
          throw err;
        }
      );
      this.#pending.set(provider.key, promise);
      return promise;
    }
    this.#values.set(provider.key, result);
    return result;
  }
  /** Resolves a provider and awaits it. Used at boot and by `ensure()`. */
  async resolveAsync(key) {
    return await this.get(key);
  }
  /**
   * Forces the given keys (default: everything owned by this scope) to resolve
   * so later synchronous `ctx.x` access never yields a promise.
   */
  async ensure(keys) {
    const targets = keys ?? this.registry.byLifetime(this.scope).map((p) => p.key);
    for (const key of targets) {
      await this.resolveAsync(key);
    }
  }
  registerDestroyHook(fn) {
    this.#destroyHooks.push(fn);
  }
  get disposed() {
    return this.#disposed;
  }
  /**
   * Runs this scope's `onDestroy` hooks in reverse registration order, so
   * dependents tear down before their dependencies.
   */
  async dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    await Promise.allSettled([...this.#pending.values()]);
    const hooks = this.#destroyHooks.splice(0).reverse();
    const errors = [];
    for (const hook of hooks) {
      try {
        await hook();
      } catch (err) {
        errors.push(err);
      }
    }
    this.#values.clear();
    this.#pending.clear();
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "Errors thrown while disposing scope");
    }
  }
};
function isPromiseLike(value) {
  return typeof value === "object" && value !== null && typeof value.then === "function";
}
function createCtxProxy(container) {
  return new Proxy(/* @__PURE__ */ Object.create(null), {
    get(_target, prop) {
      if (typeof prop === "symbol") return void 0;
      return container.get(prop);
    },
    set(_target, prop, value) {
      if (typeof prop === "symbol") return false;
      container.set(prop, value);
      return true;
    },
    has(_target, prop) {
      if (typeof prop === "symbol") return false;
      return container.has(prop);
    },
    deleteProperty() {
      return false;
    },
    ownKeys() {
      return container.registry.keys();
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (typeof prop === "symbol") return void 0;
      if (!container.has(prop)) return void 0;
      return { enumerable: true, configurable: true, value: container.get(prop) };
    }
  });
}

// src/container/logger.ts
var LEVEL_ORDER = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100
};
function createLogger(level = "info") {
  const enabled = (l) => LEVEL_ORDER[l] >= LEVEL_ORDER[level];
  const stamp = () => (/* @__PURE__ */ new Date()).toISOString();
  return {
    debug: (...a) => enabled("debug") && console.debug(`[${stamp()}] DEBUG`, ...a),
    info: (...a) => enabled("info") && console.info(`[${stamp()}] INFO `, ...a),
    warn: (...a) => enabled("warn") && console.warn(`[${stamp()}] WARN `, ...a),
    error: (...a) => enabled("error") && console.error(`[${stamp()}] ERROR`, ...a)
  };
}

// src/env.ts
var import_node_fs = require("fs");
var import_node_path = require("path");
function candidates(mode) {
  const files = [".env.local", ".env"];
  if (mode) files.unshift(`.env.${mode}.local`, `.env.${mode}`);
  return mode === "test" ? files.filter((f) => !f.endsWith(".local")) : files;
}
function loadEnv(options2) {
  const mode = options2.mode ?? process.env.NODE_ENV ?? "";
  const files = options2.files ?? candidates(mode);
  const applied = [];
  for (const file of files) {
    const contents = read((0, import_node_path.join)(options2.rootDir, file));
    if (contents === null) continue;
    for (const [key, value] of Object.entries(parseEnv(contents))) {
      if (key in process.env) continue;
      process.env[key] = value;
      applied.push(key);
    }
  }
  return applied;
}
function read(path) {
  try {
    return (0, import_node_fs.readFileSync)(path, "utf8");
  } catch (err) {
    const code = err.code;
    if (code === "ENOENT" || code === "EISDIR") return null;
    throw err;
  }
}
var LINE = /^\s*(?:export\s+)?([\w.-]+)\s*(?::=|[:=])\s*(?:"((?:\\.|[^"])*)"|'([^']*)'|`([^`]*)`|([^#\r\n]*?))\s*(?:#.*)?$/;
function parseEnv(contents) {
  const out = {};
  const lines = contents.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const open = /^\s*(?:export\s+)?[\w.-]+\s*(?::=|[:=])\s*"(?:\\.|[^"\\])*$/;
    while (open.test(line) && i + 1 < lines.length) line += "\n" + lines[++i];
    const match = LINE.exec(line);
    if (!match) continue;
    const [, key, double, single, backtick, bare] = match;
    if (double !== void 0) out[key] = unescape(double);
    else out[key] = single ?? backtick ?? bare ?? "";
  }
  return out;
}
function unescape(value) {
  return value.replace(/\\([\\nrtbf"'`$])/g, (_, ch) => {
    switch (ch) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "	";
      case "b":
        return "\b";
      case "f":
        return "\f";
      default:
        return ch;
    }
  });
}

// src/http/body.ts
var DEFAULT_BODY_LIMIT = 1024 * 1024;
async function readRawBody(req, limit = DEFAULT_BODY_LIMIT) {
  const declared = req.headers["content-length"];
  if (declared && Number(declared) > limit) {
    throw error(413, { message: "Payload too large" });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > limit) throw error(413, { message: "Payload too large" });
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}
async function parseBody(req, limit = DEFAULT_BODY_LIMIT) {
  const method = req.method?.toUpperCase();
  if (method === "GET" || method === "HEAD") return void 0;
  const raw = await readRawBody(req, limit);
  if (raw.length === 0) return void 0;
  const type = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (!type || type === "application/json" || type.endsWith("+json")) {
    try {
      return JSON.parse(raw.toString("utf8"));
    } catch {
      throw error(400, { message: "Invalid JSON body" });
    }
  }
  if (type === "application/x-www-form-urlencoded") {
    return Object.fromEntries(new URLSearchParams(raw.toString("utf8")));
  }
  if (type.startsWith("text/")) {
    return raw.toString("utf8");
  }
  return raw;
}

// src/http/cookies.ts
var import_node_crypto2 = require("crypto");
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || name in out) continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}
function serializeCookie(name, value, opts = {}) {
  let str = `${name}=${encodeURIComponent(value)}`;
  if (opts.domain) str += `; Domain=${opts.domain}`;
  str += `; Path=${opts.path ?? "/"}`;
  if (opts.expires) str += `; Expires=${opts.expires.toUTCString()}`;
  if (opts.maxAge !== void 0) str += `; Max-Age=${Math.floor(opts.maxAge)}`;
  if (opts.httpOnly) str += "; HttpOnly";
  if (opts.secure) str += "; Secure";
  if (opts.partitioned) str += "; Partitioned";
  if (opts.sameSite) {
    const v = opts.sameSite;
    str += `; SameSite=${v.charAt(0).toUpperCase()}${v.slice(1)}`;
  }
  return str;
}
function sign(value, secret) {
  const mac = (0, import_node_crypto2.createHmac)("sha256", secret).update(value).digest("base64url");
  return `${value}.${mac}`;
}
function unsign(signed, secret) {
  const idx = signed.lastIndexOf(".");
  if (idx < 0) return null;
  const value = signed.slice(0, idx);
  const mac = signed.slice(idx + 1);
  const expected = (0, import_node_crypto2.createHmac)("sha256", secret).update(value).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  return (0, import_node_crypto2.timingSafeEqual)(a, b) ? value : null;
}

// src/http/request.ts
var CloveRequest = class {
  raw;
  method;
  path;
  query;
  /** Route parameters, e.g. `{ id: "1" }` for `api/users/[id].get.ts`. */
  params = {};
  #url;
  #cookies;
  #body;
  #bodyRead = false;
  #bodyLimit;
  constructor(raw, bodyLimit = DEFAULT_BODY_LIMIT) {
    this.raw = raw;
    this.method = (raw.method ?? "GET").toUpperCase();
    this.#bodyLimit = bodyLimit;
    const host = raw.headers.host ?? "localhost";
    const proto = raw.headers["x-forwarded-proto"] ?? "http";
    this.#url = new URL(raw.url ?? "/", `${proto}://${host}`);
    this.path = this.#url.pathname;
    this.query = Object.fromEntries(this.#url.searchParams);
  }
  get url() {
    return this.#url;
  }
  get headers() {
    return this.raw.headers;
  }
  header(name) {
    const v = this.raw.headers[name.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  }
  /** Parsed request cookies, keyed by name. */
  get cookie() {
    this.#cookies ??= parseCookies(this.raw.headers.cookie);
    return this.#cookies;
  }
  /** Alias of {@link cookie}, for readers who expect the plural. */
  get cookies() {
    return this.cookie;
  }
  /**
   * The parsed body. Populated by the pipeline before handlers run, so it is
   * safe to access synchronously as `req.body`.
   */
  // Typed `any` so handlers can read `req.body.field` without a cast, matching
  // the ergonomics of Express's `req.body`. The shape is validated per-route.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  get body() {
    return this.#body;
  }
  set body(value) {
    this.#body = value;
    this.#bodyRead = true;
  }
  /** Reads and parses the body if it has not been consumed yet. */
  async readBody() {
    if (this.#bodyRead) return this.#body;
    this.#bodyRead = true;
    this.#body = await parseBody(this.raw, this.#bodyLimit);
    return this.#body;
  }
  /** Reads the untouched body bytes. Only valid if the body was not parsed. */
  async rawBody() {
    return readRawBody(this.raw, this.#bodyLimit);
  }
  get ip() {
    const fwd = this.header("x-forwarded-for");
    if (fwd) return fwd.split(",")[0]?.trim();
    return this.raw.socket?.remoteAddress;
  }
};

// src/http/response.ts
var MIME_SHORTHAND = {
  json: "application/json; charset=utf-8",
  html: "text/html; charset=utf-8",
  text: "text/plain; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  bin: "application/octet-stream",
  octet: "application/octet-stream"
};
var CloveResponse = class {
  #raw;
  /** True once a body has been written through this wrapper or the raw stream. */
  #sent = false;
  /** True when the handler set a content type itself, whatever it was. */
  #typeExplicit = false;
  #buffered;
  #rawAccessed = false;
  #statusCode;
  #headers = /* @__PURE__ */ new Map();
  #body;
  constructor(raw, options2 = {}) {
    this.#raw = raw;
    this.#buffered = options2.buffered ?? false;
    this.#statusCode = raw.statusCode;
    if (this.#buffered) {
      for (const [name, value] of Object.entries(raw.getHeaders())) {
        if (value !== void 0) {
          this.#headers.set(name.toLowerCase(), cloneHeader(value));
        }
      }
    }
  }
  /**
   * The underlying Node response. Reading it opts out of buffering and caching,
   * because writes made through the raw stream cannot be replayed safely.
   */
  get raw() {
    if (this.#buffered && !this.#rawAccessed) {
      this.#rawAccessed = true;
      this.#flushHeaders();
      if (this.#sent && !this.#raw.writableEnded) this.#raw.end(this.#body);
    }
    return this.#raw;
  }
  /** False after the raw Node response has been accessed. */
  get replayable() {
    return this.#buffered && !this.#rawAccessed;
  }
  get sent() {
    if (this.#buffered && !this.#rawAccessed) return this.#sent;
    return this.#sent || this.#raw.writableEnded || this.#raw.headersSent;
  }
  /** Whether the handler chose the content type rather than inheriting it. */
  get typeIsExplicit() {
    return this.#typeExplicit;
  }
  get statusCode() {
    return this.#buffered && !this.#rawAccessed ? this.#statusCode : this.#raw.statusCode;
  }
  status(code) {
    if (this.#buffered && !this.#rawAccessed) this.#statusCode = code;
    else this.#raw.statusCode = code;
    return this;
  }
  /**
   * Sets the `Content-Type`. Accepts either a full MIME type or one of the
   * shorthands (`"html"`, `"json"`, `"text"`, ...).
   *
   * Setting a non-JSON type disables the built-in JSON middleware.
   */
  type(value) {
    const resolved = MIME_SHORTHAND[value] ?? value;
    this.header("content-type", resolved);
    this.#typeExplicit = true;
    return this;
  }
  /** The content type currently set on the response, if any. */
  get contentType() {
    const v = this.#buffered && !this.#rawAccessed ? this.#headers.get("content-type") : this.#raw.getHeader("content-type");
    return v === void 0 ? void 0 : String(v);
  }
  header(name, value) {
    if (this.#buffered && !this.#rawAccessed) {
      this.#headers.set(name.toLowerCase(), cloneHeader(value));
    } else {
      this.#raw.setHeader(name, value);
    }
    return this;
  }
  /** Alias of {@link header}, for readers coming from Express. */
  set(name, value) {
    return this.header(name, value);
  }
  removeHeader(name) {
    if (this.#buffered && !this.#rawAccessed) this.#headers.delete(name.toLowerCase());
    else this.#raw.removeHeader(name);
    return this;
  }
  getHeader(name) {
    if (this.#buffered && !this.#rawAccessed) {
      const value2 = this.#headers.get(name.toLowerCase());
      return value2 === void 0 ? void 0 : cloneHeader(value2);
    }
    const value = this.#raw.getHeader(name);
    return value === void 0 ? void 0 : value;
  }
  cookie(name, value, opts = {}) {
    const existing = this.getHeader("set-cookie");
    const serialized = serializeCookie(name, value, opts);
    const list = Array.isArray(existing) ? [...existing, serialized] : existing ? [String(existing), serialized] : [serialized];
    this.header("set-cookie", list);
    return this;
  }
  clearCookie(name, opts = {}) {
    return this.cookie(name, "", { ...opts, maxAge: 0, expires: /* @__PURE__ */ new Date(0) });
  }
  redirect(location, status = 302) {
    this.status(status).header("location", location);
    this.end();
    return this;
  }
  /**
   * Writes a body and ends the response. Objects are JSON-serialized; strings
   * and buffers are written as-is with a sensible default content type.
   */
  send(body) {
    if (this.sent) return this;
    if (body === void 0 || body === null) {
      this.end();
      return this;
    }
    if (Buffer.isBuffer(body)) {
      if (!this.contentType) this.type("bin");
      this.#sent = true;
      if (this.#buffered && !this.#rawAccessed) this.#body = Buffer.from(body);
      else this.#raw.end(body);
      return this;
    }
    if (typeof body === "string") {
      if (!this.contentType) this.type("html");
      this.#sent = true;
      if (this.#buffered && !this.#rawAccessed) this.#body = Buffer.from(body);
      else this.#raw.end(body);
      return this;
    }
    return this.json(body);
  }
  json(body) {
    if (this.sent) return this;
    if (!this.contentType) this.header("content-type", MIME_SHORTHAND.json);
    this.#sent = true;
    const encoded = Buffer.from(JSON.stringify(body));
    if (this.#buffered && !this.#rawAccessed) this.#body = encoded;
    else this.#raw.end(encoded);
    return this;
  }
  /** Ends the response with no body. */
  end() {
    if (this.sent) return this;
    this.#sent = true;
    if (!this.#buffered || this.#rawAccessed) this.#raw.end();
    return this;
  }
  /** Captures the response state immediately before terminal handler execution. */
  checkpoint() {
    return {
      statusCode: this.statusCode,
      headers: new Map(
        [...this.#headers].map(([name, value]) => [name, cloneHeader(value)])
      ),
      typeExplicit: this.#typeExplicit,
      sent: this.sent
    };
  }
  /** Returns only mutations made since a checkpoint, suitable for replay. */
  deltaSince(checkpoint) {
    const headers = [];
    for (const [name, value] of this.#headers) {
      if (!headersEqual(checkpoint.headers.get(name), value)) {
        headers.push([name, cloneHeader(value)]);
      }
    }
    const removedHeaders = [...checkpoint.headers.keys()].filter(
      (name) => !this.#headers.has(name)
    );
    return {
      ...this.statusCode !== checkpoint.statusCode ? { statusCode: this.statusCode } : {},
      headers,
      ...removedHeaders.length ? { removedHeaders } : {},
      ...this.#typeExplicit !== checkpoint.typeExplicit ? { typeExplicit: this.#typeExplicit } : {},
      ...!checkpoint.sent && this.#sent ? { sent: true, ...this.#body ? { body: Buffer.from(this.#body) } : {} } : {}
    };
  }
  /** Applies mutations captured from an earlier terminal handler execution. */
  applyDelta(delta) {
    if (!this.replayable) return;
    if (delta.statusCode !== void 0) this.#statusCode = delta.statusCode;
    for (const [name, value] of delta.headers) {
      this.#headers.set(name, cloneHeader(value));
    }
    for (const name of delta.removedHeaders ?? []) this.#headers.delete(name);
    if (delta.typeExplicit !== void 0) this.#typeExplicit = delta.typeExplicit;
    if (delta.sent) {
      this.#sent = true;
      this.#body = delta.body ? Buffer.from(delta.body) : void 0;
    }
  }
  /** The finalized buffered body, used for ETag generation. */
  bodyBuffer() {
    return this.#body ? Buffer.from(this.#body) : void 0;
  }
  /** Replaces a buffered response with an empty conditional response. */
  notModified() {
    if (!this.replayable) return;
    this.#statusCode = 304;
    this.#body = void 0;
    this.#sent = true;
    this.#headers.delete("content-length");
  }
  /** Writes a buffered response to the underlying Node response exactly once. */
  commit(options2 = {}) {
    if (!this.#buffered || this.#rawAccessed || this.#raw.writableEnded) return;
    this.#flushHeaders();
    this.#raw.end(options2.omitBody ? void 0 : this.#body);
  }
  #flushHeaders() {
    this.#raw.statusCode = this.#statusCode;
    for (const [name, value] of this.#headers) {
      this.#raw.setHeader(name, value);
    }
  }
};
function cloneHeader(value) {
  return Array.isArray(value) ? [...value] : value;
}
function headersEqual(a, b) {
  if (a === void 0) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return String(a) === String(b);
}

// src/mcp/runtime.ts
var import_node_async_hooks = require("async_hooks");
var import_node_crypto3 = require("crypto");

// src/mcp/content.ts
function toToolContent(result) {
  if (result === void 0 || result === null) return [];
  if (typeof result === "string") return [{ type: "text", text: result }];
  if (isContentBlock(result)) return [result];
  if (Array.isArray(result) && result.length > 0 && result.every(isContentBlock)) {
    return result;
  }
  return [{ type: "text", text: stringify(result) }];
}
function toResourceContents(result, uri, declaredMimeType) {
  if (result === void 0 || result === null) return [];
  const binary = asBinary(result);
  if (binary) {
    return [
      {
        uri,
        mimeType: declaredMimeType ?? "application/octet-stream",
        blob: binary.toString("base64")
      }
    ];
  }
  if (typeof result === "string") {
    return [{ uri, ...declaredMimeType ? { mimeType: declaredMimeType } : {}, text: result }];
  }
  if (typeof result === "object" && Array.isArray(result.contents)) {
    return result.contents.map(
      (entry) => ({ uri, ...entry })
    );
  }
  return [
    {
      uri,
      mimeType: declaredMimeType ?? "application/json",
      text: stringify(result)
    }
  ];
}
function toPromptMessages(result) {
  if (result === void 0 || result === null) return [];
  if (typeof result === "string") {
    return [{ role: "user", content: { type: "text", text: result } }];
  }
  const list = Array.isArray(result) ? result : [result];
  const messages = [];
  for (const entry of list) {
    if (typeof entry === "string") {
      messages.push({ role: "user", content: { type: "text", text: entry } });
      continue;
    }
    if (!isPromptMessage(entry)) {
      messages.push({ role: "user", content: { type: "text", text: stringify(entry) } });
      continue;
    }
    for (const content of toToolContent(entry.content)) {
      messages.push({ role: entry.role, content });
    }
  }
  return messages;
}
function isRecoverable(err) {
  return isHttpError(err) && err.status >= 400 && err.status < 500;
}
function errorText(err) {
  if (isHttpError(err)) {
    const body = err.body;
    if (typeof body === "string") return body;
    if (body && typeof body === "object" && "message" in body) {
      return String(body.message);
    }
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
function isContentBlock(value) {
  if (typeof value !== "object" || value === null) return false;
  const type = value.type;
  return type === "text" && typeof value.text === "string" || type === "image" && typeof value.data === "string";
}
function isPromptMessage(value) {
  if (typeof value !== "object" || value === null) return false;
  const role = value.role;
  return (role === "user" || role === "assistant") && "content" in value;
}
function asBinary(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return null;
}
function stringify(value) {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

// src/scanner/walk.ts
var import_promises = require("fs/promises");
var import_node_path2 = require("path");
var SOURCE_EXTENSIONS = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"];
var IGNORED_DIRS = /* @__PURE__ */ new Set(["node_modules", ".git", ".clove", "dist", "build"]);
async function walkDir(root) {
  const out = [];
  async function visit(dir) {
    let entries;
    try {
      entries = await (0, import_promises.readdir)(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code === "ENOENT") return;
      throw err;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = (0, import_node_path2.join)(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        await visit(full);
      } else if (entry.isFile() && isSourceFile(entry.name)) {
        out.push({ absolute: full, relative: (0, import_node_path2.relative)(root, full).split(import_node_path2.sep).join("/") });
      }
    }
  }
  await visit(root);
  return out.sort((a, b) => a.relative.localeCompare(b.relative));
}
function isSourceFile(name) {
  if (name.endsWith(".d.ts")) return false;
  if (/\.(test|spec)\.[cm]?[jt]s$/.test(name)) return false;
  return SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext));
}
function stripExtension(path) {
  for (const ext of SOURCE_EXTENSIONS) {
    if (path.endsWith(ext)) return path.slice(0, -ext.length);
  }
  return path;
}

// src/mcp/paths.ts
function deriveMcpName(relativePath) {
  const segments = stripExtension(relativePath).split("/").filter(Boolean);
  if (segments[segments.length - 1] === "index" && segments.length > 1) segments.pop();
  return segments.map((s, i) => i === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1)).join("");
}
function deriveResourceUri(relativePath) {
  const segments = stripExtension(relativePath).split("/").filter(Boolean);
  if (segments[segments.length - 1] === "index" && segments.length > 1) segments.pop();
  const [scheme2, ...rest] = segments;
  if (!scheme2) return "";
  return `${templateSegment(scheme2)}://${rest.map(templateSegment).join("/")}`;
}
function templateSegment(segment) {
  const match = /^\[\.{0,3}(.+)\]$/.exec(segment);
  return match ? `{${match[1]}}` : segment;
}
function uriTemplateVariables(uri) {
  return [...uri.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
}
function isUriTemplate(uri) {
  return uri.includes("{");
}

// src/mcp/runtime.ts
var MCP_SESSION_HEADER = "mcp-session-id";
var OAUTH_METADATA_PATH = "/.well-known/oauth-protected-resource";
var McpRuntime = class {
  path;
  #options;
  #sdk = null;
  #live = /* @__PURE__ */ new Map();
  /** The single connection used by stdio, which has no session ids. */
  #standalone = null;
  /**
   * Carries the request's principal from `handle()` into `#call`, without
   * threading it through the MCP SDK. Async-local so concurrent requests on
   * one session never read each other's identity.
   */
  #authStore = new import_node_async_hooks.AsyncLocalStorage();
  /** The metadata document, resolved (from a factory, if given) on first serve. */
  #resolvedMetadata = null;
  constructor(options2) {
    this.#options = { exposeErrors: false, ...options2 };
    this.path = options2.path ?? "/mcp";
  }
  get empty() {
    const { tools, resources, prompts } = this.#options.scan;
    return tools.length === 0 && resources.length === 0 && prompts.length === 0;
  }
  get counts() {
    const { tools, resources, prompts } = this.#options.scan;
    return { tools: tools.length, resources: resources.length, prompts: prompts.length };
  }
  /** True when this server enforces bearer-token authentication. */
  get secured() {
    return this.#options.auth != null;
  }
  /**
   * True when the path is one this runtime answers: the MCP endpoint itself,
   * or — when auth is configured — its protected-resource metadata. Lets the
   * host route those paths here and fall through to routes for everything else.
   */
  owns(path) {
    if (this.empty) return false;
    if (path === this.path) return true;
    return this.secured && isMetadataPath(path);
  }
  /**
   * Handles one MCP HTTP request. Returns false when the path does not match,
   * so the caller can fall through to routes.
   */
  async handle(req, res, body) {
    if (this.empty) return false;
    const url = new URL(req.url ?? "/", `${scheme(req)}://${req.headers.host ?? "localhost"}`);
    if (this.secured && isMetadataPath(url.pathname)) {
      await this.#serveMetadata(res, url);
      return true;
    }
    if (url.pathname !== this.path) return false;
    const sdk = await this.#load();
    let authInfo = null;
    if (this.#options.auth) {
      authInfo = await this.#authenticate(req, res, url);
      if (!authInfo) return true;
    }
    const existingId = headerValue(req, MCP_SESSION_HEADER);
    if (existingId) {
      const live2 = this.#live.get(existingId);
      if (!live2) {
        writeJsonRpcError(res, 404, -32001, "Unknown or expired MCP session");
        return true;
      }
      await live2.ready;
      if (live2.auth && authInfo && live2.auth.tenant !== authInfo.tenant) {
        writeJsonRpcError(res, 403, -32003, "This MCP session belongs to another tenant");
        return true;
      }
      await this.#authStore.run(authInfo, () => live2.transport.handleRequest(req, res, body));
      await this.#persist(live2);
      return true;
    }
    if (req.method !== "POST") {
      writeJsonRpcError(res, 400, -32e3, "Missing Mcp-Session-Id header");
      return true;
    }
    const transport = new sdk.StreamableHTTPServerTransport({
      sessionIdGenerator: () => (0, import_node_crypto3.randomUUID)(),
      onsessioninitialized: (sessionId) => {
        this.#live.set(sessionId, live);
        this.#options.logger.debug(`MCP session opened: ${sessionId}`);
        live.ready = (async () => {
          if (!this.#options.sessions.needed) return;
          const { container } = await this.#options.sessions.acquireById(sessionId);
          live.parent = container;
          live.sessionId = sessionId;
        })();
        return live.ready;
      },
      onsessionclosed: (sessionId) => {
        void this.#closeSession(sessionId);
      }
    });
    const live = {
      server: this.#buildServer(sdk, () => live.parent),
      transport,
      parent: this.#options.root,
      sessionId: null,
      auth: authInfo,
      ready: Promise.resolve()
    };
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) void this.#closeSession(id);
    };
    await live.server.connect(transport);
    await this.#authStore.run(authInfo, () => transport.handleRequest(req, res, body));
    await live.ready;
    await this.#persist(live);
    return true;
  }
  /**
   * Serves the project over stdio, for clients that launch the server as a
   * subprocess. Resolves when the client disconnects.
   */
  async serveStdio() {
    const sdk = await this.#load();
    const transport = new sdk.StdioServerTransport();
    const live = {
      server: this.#buildServer(sdk, () => this.#options.root),
      transport,
      parent: this.#options.root,
      sessionId: null,
      auth: null,
      ready: Promise.resolve()
    };
    this.#standalone = live;
    await live.server.connect(transport);
    await new Promise((resolve) => {
      transport.onclose = () => resolve();
    });
  }
  /** Builds an MCP server with every scanned tool, resource and prompt bound. */
  // Returns an untyped SDK `McpServer` instance; see the `Sdk` interface above.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #buildServer(sdk, parent) {
    const { scan, serverInfo } = this.#options;
    const server = new sdk.McpServer(
      serverInfo ?? { name: "clovejs", version: "0.1.1" },
      { capabilities: { logging: {} } }
    );
    for (const tool of scan.tools) {
      const shape = tool.shape;
      const run = (input, extra) => this.#call(parent(), tool.file, extra, async (ctx, args) => ({
        content: toToolContent(await tool.handler(input ?? {}, ctx, args))
      }), true);
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          ...tool.title ? { title: tool.title } : {},
          ...shape ? { inputSchema: shape } : {},
          ...annotationsOf(tool.meta)
        },
        // A tool without an input schema takes no arguments, so the SDK calls
        // back with `(extra)` alone rather than `(input, extra)`.
        shape ? (input, extra) => run(input, extra) : (extra) => run({}, extra)
      );
    }
    for (const res of scan.resources) {
      const target = isUriTemplate(res.uri) ? new sdk.ResourceTemplate(res.uri, { list: void 0 }) : res.uri;
      server.registerResource(
        res.name,
        target,
        {
          description: res.description,
          ...res.title ? { title: res.title } : {},
          ...res.mimeType ? { mimeType: res.mimeType } : {}
        },
        async (uri, a, b) => {
          const variables = isUriTemplate(res.uri) ? a : {};
          const extra = isUriTemplate(res.uri) ? b : a;
          return this.#call(parent(), res.file, extra, async (ctx, args) => ({
            contents: toResourceContents(
              await res.handler(stringParams(variables), ctx, { ...args, uri: uri.href }),
              uri.href,
              res.mimeType
            )
          }));
        }
      );
    }
    for (const p of scan.prompts) {
      const shape = p.shape;
      const run = (input, extra) => this.#call(parent(), p.file, extra, async (ctx, args) => ({
        messages: toPromptMessages(await p.handler(input ?? {}, ctx, args))
      }));
      server.registerPrompt(
        p.name,
        {
          description: p.description,
          ...p.title ? { title: p.title } : {},
          ...shape ? { argsSchema: shape } : {}
        },
        // As with tools, an argument-less prompt is called with `(extra)` only.
        shape ? (input, extra) => run(input, extra) : (extra) => run({}, extra)
      );
    }
    return server;
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
  async #call(parent, file, extra, run, soft = false) {
    const info = extra;
    const container = parent.createChild("request");
    const args = {
      ctx: container.ctx,
      sessionId: typeof info?.sessionId === "string" ? info.sessionId : null,
      auth: this.#authStore.getStore() ?? null,
      signal: info?.signal ?? new AbortController().signal,
      log: (level, message) => {
        void info?.sendNotification?.({
          method: "notifications/message",
          params: { level, data: message }
        });
      }
    };
    try {
      return await run(container.ctx, args);
    } catch (err) {
      const message = isRecoverable(err) ? errorText(err) : this.#reportInternal(err, file);
      if (soft) return { content: [{ type: "text", text: message }], isError: true };
      throw new Error(message, { cause: err });
    } finally {
      await container.dispose().catch((err) => this.#options.logger.error("Error disposing MCP request scope:", err));
    }
  }
  /** Logs an unexpected failure and returns the message the client may see. */
  #reportInternal(err, file) {
    this.#options.logger.error(`MCP handler failed (${file}):`, err);
    return this.#options.exposeErrors && err instanceof Error ? `Internal error: ${err.message}` : "Internal error";
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
  async #authenticate(req, res, url) {
    const token = bearerToken(req);
    try {
      return await this.#options.auth.authenticate({
        ctx: this.#options.root.ctx,
        req,
        token,
        resource: `${url.origin}${this.path}`
      });
    } catch (err) {
      if (!isHttpError(err)) {
        this.#reportInternal(err, this.#options.auth.file ?? "mcp/auth");
        writeJsonRpcError(res, 500, -32603, "Internal error");
        return null;
      }
      const status = err.status;
      const message = errorText(err);
      if (status === 401) {
        this.#challenge(res, url, "invalid_token", message);
      } else {
        writeJsonRpcError(res, status, -32003, message);
      }
      return null;
    }
  }
  /** Answers a request that lacks a usable token with an RFC 6750 challenge. */
  #challenge(res, url, code, description) {
    const metadata = `${url.origin}${OAUTH_METADATA_PATH}${this.path}`;
    const params = [
      `resource_metadata="${metadata}"`,
      `error="${code}"`,
      `error_description="${description.replace(/"/g, "'")}"`
    ].join(", ");
    res.writeHead(401, {
      "content-type": "application/json",
      "www-authenticate": `Bearer ${params}`
    });
    res.end(JSON.stringify({ error: code, error_description: description }));
  }
  /**
   * Resolves the auth metadata, invoking a factory against the root context on
   * first use and caching the result. A factory lets the document depend on
   * DI-resolved values that do not exist when `mcp/auth.ts` is imported.
   */
  async #metadata() {
    if (this.#resolvedMetadata) return this.#resolvedMetadata;
    const { metadata } = this.#options.auth;
    this.#resolvedMetadata = typeof metadata === "function" ? await metadata({ ctx: this.#options.root.ctx }) : metadata;
    return this.#resolvedMetadata;
  }
  /** Serves the RFC 9728 protected-resource metadata document. */
  async #serveMetadata(res, url) {
    let metadata;
    try {
      metadata = await this.#metadata();
    } catch (err) {
      this.#reportInternal(err, this.#options.auth.file ?? "mcp/auth");
      writeJsonRpcError(res, 500, -32603, "Internal error");
      return;
    }
    const { authorizationServers, scopesSupported, resourceName, ...rest } = metadata;
    const body = {
      resource: `${url.origin}${this.path}`,
      authorization_servers: authorizationServers,
      ...scopesSupported ? { scopes_supported: scopesSupported } : {},
      ...resourceName ? { resource_name: resourceName } : {},
      bearer_methods_supported: ["header"],
      ...rest
    };
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "public, max-age=3600"
    });
    res.end(JSON.stringify(body));
  }
  async #persist(live) {
    if (!live.sessionId) return;
    await this.#options.sessions.persist(live.sessionId, live.parent).catch((err) => this.#options.logger.error("Failed to persist MCP session:", err));
  }
  async #closeSession(sessionId) {
    const live = this.#live.get(sessionId);
    if (!live) return;
    this.#live.delete(sessionId);
    this.#options.logger.debug(`MCP session closed: ${sessionId}`);
    await live.server.close().catch(() => void 0);
    if (live.sessionId) {
      await this.#options.sessions.destroy(live.sessionId).catch(() => void 0);
    }
  }
  // --- Programmatic entry points (testing) ---------------------------------
  //
  // These run a tool, resource or prompt handler directly against a fresh
  // request-scoped container — the same lifecycle the transport drives, minus
  // the JSON-RPC wire. Unlike the transport paths, a thrown error propagates
  // untouched (an `HttpError` stays an `HttpError`) so a test can assert on it.
  /** Runs a tool by name and returns the handler's raw result. */
  async callTool(name, input = {}, opts = {}) {
    const tool = this.#options.scan.tools.find((t) => t.name === name);
    if (!tool) throw new Error(`No MCP tool named "${name}".`);
    const parsed = parseMcpInput(tool.input, input);
    return this.#testInvoke(opts, (ctx, args) => tool.handler(parsed, ctx, args));
  }
  /** Runs a prompt by name and returns the handler's raw result. */
  async getPrompt(name, input = {}, opts = {}) {
    const prompt = this.#options.scan.prompts.find((p) => p.name === name);
    if (!prompt) throw new Error(`No MCP prompt named "${name}".`);
    const parsed = parseMcpInput(prompt.input, input);
    return this.#testInvoke(opts, (ctx, args) => prompt.handler(parsed, ctx, args));
  }
  /** Reads a resource by URI, matching static URIs and templates alike. */
  async readResource(uri, opts = {}) {
    const matched = this.#matchResource(uri);
    if (!matched) throw new Error(`No MCP resource matches "${uri}".`);
    const { resource, params } = matched;
    const result = await this.#testInvoke(
      opts,
      (ctx, args) => resource.handler(params, ctx, { ...args, uri })
    );
    const contents = toResourceContents(result, uri, resource.mimeType);
    return {
      uri,
      mimeType: resource.mimeType,
      result,
      contents,
      text: contents.find((c) => c.text !== void 0)?.text
    };
  }
  /** Runs one handler in a throwaway request scope with test-supplied args. */
  async #testInvoke(opts, run) {
    const auth = await this.#testAuth(opts);
    const container = this.#options.root.createChild("request");
    const args = {
      ctx: container.ctx,
      sessionId: opts.sessionId ?? null,
      auth,
      signal: opts.signal ?? new AbortController().signal,
      log: () => {
      }
    };
    try {
      return await run(container.ctx, args);
    } finally {
      await container.dispose().catch((err) => this.#options.logger.error("Error disposing MCP request scope:", err));
    }
  }
  /** Runs the project's `authenticate` handler for a test token, if configured. */
  async #testAuth(opts) {
    if (!this.#options.auth || opts.token === void 0) return null;
    return this.#options.auth.authenticate({
      ctx: this.#options.root.ctx,
      req: { headers: { authorization: `Bearer ${opts.token}` } },
      token: opts.token,
      resource: `http://localhost${this.path}`
    });
  }
  /** Finds the resource whose URI or template matches, extracting variables. */
  #matchResource(uri) {
    for (const resource of this.#options.scan.resources) {
      if (!isUriTemplate(resource.uri)) {
        if (resource.uri === uri) return { resource, params: {} };
        continue;
      }
      const params = matchUriTemplate(resource.uri, uri);
      if (params) return { resource, params };
    }
    return null;
  }
  /** Closes every open connection. */
  async close() {
    const ids = [...this.#live.keys()];
    await Promise.all(ids.map((id) => this.#closeSession(id)));
    if (this.#standalone) {
      await this.#standalone.server.close().catch(() => void 0);
      this.#standalone = null;
    }
  }
  /**
   * Imports the MCP SDK on first use.
   *
   * It is an optional peer dependency: a project with no `mcp/` directory
   * never loads it, and never has to install it.
   */
  async #load() {
    if (this.#sdk) return this.#sdk;
    try {
      const [mcp, http, stdio] = await Promise.all([
        import("@modelcontextprotocol/sdk/server/mcp.js"),
        import("@modelcontextprotocol/sdk/server/streamableHttp.js"),
        import("@modelcontextprotocol/sdk/server/stdio.js")
      ]);
      this.#sdk = {
        McpServer: mcp.McpServer,
        ResourceTemplate: mcp.ResourceTemplate,
        StreamableHTTPServerTransport: http.StreamableHTTPServerTransport,
        StdioServerTransport: stdio.StdioServerTransport
      };
      return this.#sdk;
    } catch (err) {
      throw new CloveBootError(
        `This project has an mcp/ directory, which needs the MCP SDK and zod:

  npm install @modelcontextprotocol/sdk zod

They are optional peer dependencies, so projects without MCP tools do not carry them.

Underlying error: ${err.message}`
      );
    }
  }
};
function parseMcpInput(schema, input) {
  if (!schema) return input ?? {};
  if (typeof schema.parse === "function") {
    return schema.parse(input ?? {});
  }
  const raw = input ?? {};
  const out = {};
  for (const [key, field] of Object.entries(schema)) {
    out[key] = field.parse(raw[key]);
  }
  return out;
}
function matchUriTemplate(template, uri) {
  const names = uriTemplateVariables(template);
  const pattern = new RegExp(
    "^" + template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{[^}]+\\\}/g, "([^/]+)") + "$"
  );
  const match = pattern.exec(uri);
  if (!match) return null;
  const params = {};
  names.forEach((name, i) => {
    params[name] = decodeURIComponent(match[i + 1]);
  });
  return params;
}
function annotationsOf(meta) {
  const annotations = {};
  if (typeof meta.readOnly === "boolean") annotations.readOnlyHint = meta.readOnly;
  if (typeof meta.destructive === "boolean") annotations.destructiveHint = meta.destructive;
  if (typeof meta.idempotent === "boolean") annotations.idempotentHint = meta.idempotent;
  if (typeof meta.openWorld === "boolean") annotations.openWorldHint = meta.openWorld;
  return Object.keys(annotations).length ? { annotations } : {};
}
function stringParams(variables) {
  const out = {};
  for (const [key, value] of Object.entries(variables ?? {})) {
    out[key] = Array.isArray(value) ? value.join("/") : String(value);
  }
  return out;
}
function headerValue(req, name) {
  const raw = req.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}
function bearerToken(req) {
  const header = headerValue(req, "authorization");
  const match = header?.match(/^Bearer[ ]+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}
function isMetadataPath(path) {
  return path === OAUTH_METADATA_PATH || path.startsWith(`${OAUTH_METADATA_PATH}/`);
}
function scheme(req) {
  const forwarded = headerValue(req, "x-forwarded-proto")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  return req.socket.encrypted ? "https" : "http";
}
function writeJsonRpcError(res, status, code, message) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

// src/pipeline/json.ts
function jsonEnabled(route2, res) {
  if (route2.meta.json === false) return false;
  if (res.typeIsExplicit) {
    const type = res.contentType ?? "";
    return type.includes("json");
  }
  return true;
}
function applyJsonResult(result, route2, res, method) {
  if (res.sent) return;
  if (result === void 0) {
    res.status(res.statusCode === 200 ? 204 : res.statusCode).end();
    return;
  }
  if (result === null) {
    if (method === "GET") {
      throw error(404, { message: "Not Found" });
    }
    res.status(res.statusCode === 200 ? 204 : res.statusCode).end();
    return;
  }
  res.json(result);
}

// src/pipeline/view.ts
async function applyViewResult(result, res, ctx, engine2) {
  if (res.sent) return;
  if (!engine2) {
    throw new Error(
      `A handler returned view("${result.template}") but no view engine is registered. Add views.ts at your source root, default-exporting views({ render }).`
    );
  }
  const rendered = await engine2.render(result.template, result.data, ctx);
  if (res.sent) return;
  if (!res.contentType) res.type(engine2.contentType ?? "html");
  res.send(rendered);
}

// src/pipeline/index.ts
async function runPipeline(route2, req, res, container, options2) {
  const ctx = container.ctx;
  let handlerExecuted = false;
  let result;
  try {
    result = await composeChain(
      route2,
      req,
      res,
      ctx,
      options2.middlewares,
      async () => {
        handlerExecuted = true;
        const execute = () => Promise.resolve(route2.handler(req, res, ctx));
        return options2.cache ? options2.cache.execute(route2, req, res, ctx, execute) : execute();
      }
    );
    if (isViewResult(result)) {
      await applyViewResult(result, res, ctx, options2.views);
    } else if (jsonEnabled(route2, res)) {
      applyJsonResult(result, route2, res, req.method);
    } else if (!res.sent) {
      if (result !== void 0 && result !== null) res.send(result);
      else res.end();
    }
    return { result, handlerExecuted };
  } catch (err) {
    writeError(err, res, options2);
    return { result, error: err, handlerExecuted };
  }
}
function composeChain(route2, req, res, ctx, middlewares, executeRoute) {
  let index = -1;
  const dispatch = async (i) => {
    if (i <= index) {
      throw new Error(
        `Middleware "${middlewares[i - 1]?.name}" called handler.execute() more than once.`
      );
    }
    index = i;
    if (i === middlewares.length) {
      return await executeRoute();
    }
    const mw = middlewares[i];
    const args = {
      route: route2,
      req,
      res,
      ctx,
      handler: { execute: () => dispatch(i + 1) }
    };
    return await mw.fn(args);
  };
  return dispatch(0);
}
function writeError(err, res, options2) {
  if (res.sent) {
    options2.logger.error("Error thrown after the response was sent:", err);
    return;
  }
  if (isHttpError(err)) {
    res.status(err.status);
    if (!res.contentType || res.contentType.includes("json")) {
      res.json(err.body);
    } else {
      res.send(String(err.message));
    }
    return;
  }
  options2.logger.error("Unhandled error while serving request:", err);
  res.status(500);
  const body = { message: "Internal Server Error" };
  if (options2.exposeErrors && err instanceof Error) {
    body.error = err.message;
    body.stack = err.stack;
  }
  res.json(body);
}

// src/scanner/index.ts
var import_node_fs2 = require("fs");
var import_node_path3 = require("path");

// src/container/registry.ts
var Registry = class {
  #providers = /* @__PURE__ */ new Map();
  add(provider) {
    const existing = this.#providers.get(provider.key);
    if (existing && existing.kind !== "builtin") {
      throw new CloveBootError(
        `Duplicate context key "${provider.key}": two files both provide \`ctx.${provider.key}\`. Rename one of them.`,
        [existing.file, provider.file]
      );
    }
    this.#providers.set(provider.key, provider);
  }
  /**
   * Replaces (or adds) a provider unconditionally, bypassing the duplicate-key
   * guard `add` enforces.
   *
   * This is the seam the testing layer uses to swap `ctx.db` or `ctx.auth` for
   * a fake — the one thing a test needs that production forbids. It is not part
   * of the normal boot path: the scanner only ever calls `add`.
   */
  override(provider) {
    this.#providers.set(provider.key, provider);
  }
  get(key) {
    return this.#providers.get(key);
  }
  has(key) {
    return this.#providers.has(key);
  }
  keys() {
    return [...this.#providers.keys()];
  }
  all() {
    return [...this.#providers.values()];
  }
  byLifetime(lifetime) {
    return this.all().filter((p) => p.lifetime === lifetime);
  }
};

// src/mcp/schema.ts
function toRawShape(input, file) {
  if (input === null) return void 0;
  if (typeof input !== "object") {
    throw new CloveBootError(
      `\`input\` must be a zod schema or an object of zod schemas, but it is ${typeof input}.`,
      [file]
    );
  }
  const shape = input.shape;
  if (shape && typeof shape === "object") {
    return shape;
  }
  if (typeof input.parse === "function") {
    throw new CloveBootError(
      `\`input\` must be an object schema. Wrap the fields in z.object({...}) \u2014 a bare z.string() or z.array() cannot describe named tool arguments.`,
      [file]
    );
  }
  const entries = Object.entries(input);
  if (entries.length === 0) return void 0;
  for (const [key, value] of entries) {
    if (!value || typeof value.parse !== "function") {
      throw new CloveBootError(
        `\`input.${key}\` is not a zod schema. Every field of a bare input object must be one, for example \`{ ${key}: z.string() }\`.`,
        [file]
      );
    }
  }
  return input;
}
function assertPromptShape(shape, file) {
  if (!shape) return void 0;
  for (const [key, value] of Object.entries(shape)) {
    const typeName = zodTypeName(value);
    if (typeName && typeName !== "ZodString" && typeName !== "ZodOptional") {
      throw new CloveBootError(
        `Prompt argument "${key}" is a ${typeName}, but MCP transports prompt arguments as strings. Use z.string() and parse inside the handler.`,
        [file]
      );
    }
  }
  return shape;
}
function zodTypeName(schema) {
  const def = schema?._def;
  return typeof def?.typeName === "string" ? def.typeName : null;
}

// src/router/trie.ts
function createNode() {
  return { static: /* @__PURE__ */ new Map(), routes: /* @__PURE__ */ new Map() };
}
var RouterTrie = class {
  #root = createNode();
  add(route2) {
    const segments = splitPath(route2.path);
    let node = this.#root;
    for (const segment of segments) {
      const paramName = paramNameOf(segment);
      if (paramName !== null) {
        if (node.param && node.param.name !== paramName) {
          throw new CloveBootError(
            `Route parameter name conflict: the same path position is named "${node.param.name}" in one file and "${paramName}" in another. Rename one so they agree.`,
            [node.param.file, route2.file]
          );
        }
        node.param ??= { name: paramName, node: createNode(), file: route2.file };
        node = node.param.node;
      } else {
        let next = node.static.get(segment);
        if (!next) {
          next = createNode();
          node.static.set(segment, next);
        }
        node = next;
      }
    }
    const existing = node.routes.get(route2.method);
    if (existing) {
      throw new CloveBootError(
        `Duplicate route: ${route2.method} ${route2.path || "/"} is defined twice.`,
        [existing.file, route2.file]
      );
    }
    node.routes.set(route2.method, route2);
  }
  match(method, path) {
    const segments = splitPath(path);
    const params = {};
    const node = this.#walk(this.#root, segments, 0, params, method);
    if (!node) return null;
    const route2 = node.routes.get(method) ?? node.routes.get("ALL");
    if (!route2) return null;
    return { route: route2, params };
  }
  /** True when the path exists under some other method — used for 405s. */
  hasPath(path) {
    const params = {};
    const node = this.#walk(this.#root, splitPath(path), 0, params, null);
    return node !== null && node.routes.size > 0;
  }
  /**
   * Depth-first walk that backtracks: if the static branch matches the segment
   * but dead-ends further down, the param branch still gets a chance.
   */
  #walk(node, segments, index, params, method) {
    if (index === segments.length) {
      if (node.routes.size === 0) return null;
      if (method === null) return node;
      return node.routes.has(method) || node.routes.has("ALL") ? node : null;
    }
    const segment = segments[index];
    const staticChild = node.static.get(segment);
    if (staticChild) {
      const found = this.#walk(staticChild, segments, index + 1, params, method);
      if (found) return found;
    }
    if (node.param) {
      const found = this.#walk(node.param.node, segments, index + 1, params, method);
      if (found) {
        params[node.param.name] = safeDecode(segment);
        return found;
      }
    }
    return null;
  }
  /** Every registered route, for diagnostics and the dev-server route list. */
  list() {
    const out = [];
    const visit = (node) => {
      for (const route2 of node.routes.values()) out.push(route2);
      for (const child of node.static.values()) visit(child);
      if (node.param) visit(node.param.node);
    };
    visit(this.#root);
    return out.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  }
};
function splitPath(path) {
  const clean = path.split("?")[0];
  const parts = [];
  for (const segment of clean.split("/")) {
    if (segment !== "") parts.push(segment);
  }
  return parts;
}
function paramNameOf(segment) {
  if (segment.length > 2 && segment.startsWith("[") && segment.endsWith("]")) {
    return segment.slice(1, -1);
  }
  return null;
}
function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// src/scanner/loader.ts
var import_node_url = require("url");
function createNativeLoader() {
  const versions = /* @__PURE__ */ new Map();
  return {
    async load(absolutePath) {
      const version = versions.get(absolutePath);
      const url = (0, import_node_url.pathToFileURL)(absolutePath).href + (version ? `?v=${version}` : "");
      return await import(url);
    },
    invalidate(absolutePath) {
      versions.set(absolutePath, (versions.get(absolutePath) ?? 0) + 1);
    }
  };
}
async function createJitiLoader(rootDir, moduleCache = true) {
  const { createJiti } = await import("jiti");
  let jiti = createJiti(rootDir, {
    moduleCache,
    // The on-disk transform cache is keyed by path, so it can hand back stale
    // output when a file is rewritten quickly. Off whenever caching is off.
    fsCache: moduleCache,
    interopDefault: false
  });
  return {
    async load(absolutePath) {
      return await jiti.import(absolutePath);
    },
    invalidate() {
      jiti = createJiti(rootDir, {
        moduleCache,
        // The on-disk transform cache is keyed by path, so it can hand back stale
        // output when a file is rewritten quickly. Off whenever caching is off.
        fsCache: moduleCache,
        interopDefault: false
      });
    }
  };
}
var TS_EXTENSIONS = /\.[cm]?tsx?$/;
async function createLoader(rootDir, options2 = {}) {
  const moduleCache = options2.moduleCache ?? true;
  const native = createNativeLoader();
  let jiti;
  if (!moduleCache) native.invalidate("");
  const forFile = async (path) => {
    if (!TS_EXTENSIONS.test(path)) {
      if (!moduleCache) native.invalidate(path);
      return native;
    }
    jiti ??= await createJitiLoader(rootDir, moduleCache);
    return jiti;
  };
  return {
    async load(absolutePath) {
      return (await forFile(absolutePath)).load(absolutePath);
    },
    invalidate(absolutePath) {
      native.invalidate(absolutePath);
      jiti?.invalidate(absolutePath);
    }
  };
}
async function loadDefault(loader, absolutePath) {
  let mod;
  try {
    mod = await loader.load(absolutePath);
  } catch (err) {
    throw new CloveBootError(
      `Failed to load module: ${err.message}`,
      [absolutePath]
    );
  }
  const value = mod?.default ?? mod?.module?.default;
  if (value === void 0) {
    throw new CloveBootError(
      "File has no default export. Every file in a convention directory must default-export a definition (get/post/service/di/middleware/ws).",
      [absolutePath]
    );
  }
  return value;
}

// src/scanner/paths.ts
var METHODS = /* @__PURE__ */ new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "all"
]);
function deriveRoutePath(relativePath) {
  const withoutExt = stripExtension(relativePath);
  const segments = withoutExt.split("/").filter(Boolean);
  let method = null;
  const last = segments[segments.length - 1];
  if (last !== void 0) {
    if (METHODS.has(last.toLowerCase())) {
      method = normalizeMethod(last);
      segments.pop();
    } else {
      const dot = last.lastIndexOf(".");
      if (dot > 0) {
        const suffix = last.slice(dot + 1).toLowerCase();
        if (METHODS.has(suffix)) {
          method = normalizeMethod(suffix);
          segments[segments.length - 1] = last.slice(0, dot);
        }
      }
    }
  }
  const tail = segments[segments.length - 1];
  if (tail === "index") segments.pop();
  return { path: "/" + segments.join("/"), method };
}
function deriveSocketPath(relativePath) {
  const segments = stripExtension(relativePath).split("/").filter(Boolean);
  if (segments[segments.length - 1] === "index") segments.pop();
  return "/" + segments.join("/");
}
function normalizeMethod(name) {
  const upper = name.toUpperCase();
  return upper === "ALL" ? "ALL" : upper;
}
function parsePriority(relativePath) {
  const base = stripExtension(relativePath).split("/").pop() ?? "";
  const parts = base.split(".");
  if (parts.length < 2) return null;
  const numbers = [];
  for (let i = parts.length - 1; i >= 1; i--) {
    const part = parts[i];
    if (!/^\d+$/.test(part)) break;
    numbers.unshift(Number(part));
  }
  return numbers.length > 0 ? numbers : null;
}
function stripPriority(relativePath) {
  const withoutExt = stripExtension(relativePath);
  const parts = withoutExt.split(".");
  let end = parts.length;
  for (let i = parts.length - 1; i >= 1; i--) {
    if (!/^\d+$/.test(parts[i])) break;
    end = i;
  }
  return parts.slice(0, end).join(".");
}
function comparePriority(a, b) {
  if (a.priority && b.priority) {
    const len = Math.max(a.priority.length, b.priority.length);
    for (let i = 0; i < len; i++) {
      const av = a.priority[i];
      const bv = b.priority[i];
      if (av === void 0) return -1;
      if (bv === void 0) return 1;
      if (av !== bv) return av - bv;
    }
    return a.name.localeCompare(b.name);
  }
  if (a.priority) return -1;
  if (b.priority) return 1;
  return a.name.localeCompare(b.name);
}
function deriveContextKey(relativePath) {
  const segments = stripExtension(relativePath).split("/").filter(Boolean);
  if (segments[segments.length - 1] === "index" && segments.length > 1) segments.pop();
  return segments.map((s, i) => i === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1)).join("");
}

// src/scanner/index.ts
var DEFAULT_DIRS = {
  api: "api",
  web: "web",
  ws: "ws",
  di: "di",
  services: "services",
  middlewares: "middlewares",
  mcp: "mcp"
};
var MCP_KINDS = {
  tools: "mcpTool",
  resources: "mcpResource",
  prompts: "mcpPrompt"
};
async function scanProject(options2) {
  const { sourceDir, loader } = options2;
  const dirs = { ...DEFAULT_DIRS, ...options2.dirs };
  const files = [];
  const registry = new Registry();
  const routes = new RouterTrie();
  const sockets = new RouterTrie();
  const socketHandlers = /* @__PURE__ */ new Map();
  const middlewares = [];
  for (const kind of ["services", "di"]) {
    const dir = (0, import_node_path3.join)(sourceDir, dirs[kind]);
    for (const file of await walkDir(dir)) {
      files.push(file.absolute);
      const def = await loadDefault(loader, file.absolute);
      const actual = definitionKind(def);
      const key = deriveContextKey(file.relative);
      if (kind === "services") {
        if (actual !== "service") {
          throw new CloveBootError(
            `Files in ${dirs.services}/ must default-export service(...), but this one exports ${describe(actual)}.`,
            [file.absolute]
          );
        }
        registry.add({
          key,
          kind: "service",
          lifetime: "singleton",
          file: file.absolute,
          factory: def.factory,
          isFactory: true
        });
      } else {
        if (actual !== "di") {
          throw new CloveBootError(
            `Files in ${dirs.di}/ must default-export di(...), but this one exports ${describe(actual)}.`,
            [file.absolute]
          );
        }
        const d = def;
        if (!["singleton", "session", "request"].includes(d.lifetime)) {
          throw new CloveBootError(
            `Unknown lifetime "${d.lifetime}". Use "singleton", "session" or "request".`,
            [file.absolute]
          );
        }
        registry.add({
          key,
          kind: "di",
          lifetime: d.lifetime,
          file: file.absolute,
          isFactory: d.isFactory,
          ...d.isFactory ? { factory: d.value } : { value: d.value }
        });
      }
    }
  }
  await loadRoutes(loader, (0, import_node_path3.join)(sourceDir, dirs.api), dirs.api, dirs.api, routes, files);
  await loadRoutes(loader, (0, import_node_path3.join)(sourceDir, dirs.web), dirs.web, "", routes, files);
  const wsDir = (0, import_node_path3.join)(sourceDir, dirs.ws);
  for (const file of await walkDir(wsDir)) {
    files.push(file.absolute);
    const def = await loadDefault(loader, file.absolute);
    if (definitionKind(def) !== "ws") {
      throw new CloveBootError(
        `Files in ${dirs.ws}/ must default-export ws(...), but this one exports ${describe(definitionKind(def))}.`,
        [file.absolute]
      );
    }
    const path = (0, import_node_path3.join)("/", dirs.ws, deriveSocketPath(file.relative)).split("\\").join("/");
    const socket = {
      path,
      handler: def.handler,
      file: file.absolute
    };
    sockets.add({
      method: "GET",
      path,
      handler: () => void 0,
      meta: {},
      file: file.absolute
    });
    socketHandlers.set(path, socket);
  }
  const mcp = { tools: [], resources: [], prompts: [], auth: null };
  const mcpNames = /* @__PURE__ */ new Map();
  for (const ext of ["ts", "js", "mjs", "cjs"]) {
    const authFile = (0, import_node_path3.join)(sourceDir, dirs.mcp, `auth.${ext}`);
    if (!(0, import_node_fs2.existsSync)(authFile)) continue;
    files.push(authFile);
    const def = await loadDefault(loader, authFile);
    if (definitionKind(def) !== "mcpAuth") {
      throw new CloveBootError(
        `${dirs.mcp}/auth.${ext} must default-export mcpAuth(...), but it exports ${describe(definitionKind(def))}.`,
        [authFile]
      );
    }
    const d = def;
    mcp.auth = { metadata: d.metadata, authenticate: d.authenticate, file: authFile };
    break;
  }
  for (const [sub, expected] of Object.entries(MCP_KINDS)) {
    const dir = (0, import_node_path3.join)(sourceDir, dirs.mcp, sub);
    for (const file of await walkDir(dir)) {
      files.push(file.absolute);
      const def = await loadDefault(loader, file.absolute);
      const actual = definitionKind(def);
      if (actual !== expected) {
        const wrapper = expected.replace("mcp", "").toLowerCase();
        throw new CloveBootError(
          `Files in ${dirs.mcp}/${sub}/ must default-export ${wrapper}(...), but this one exports ${describe(actual)}.`,
          [file.absolute]
        );
      }
      if (sub === "resources") {
        const d = def;
        const uri = d.uri ?? deriveResourceUri(file.relative);
        const name2 = d.name ?? deriveMcpName(file.relative);
        claim(mcpNames, `resource:${uri}`, file.absolute, `resource URI "${uri}"`);
        mcp.resources.push({
          uri,
          name: name2,
          description: d.description,
          title: d.title,
          mimeType: d.mimeType,
          handler: d.handler,
          file: file.absolute
        });
        continue;
      }
      const name = def.name ?? deriveMcpName(file.relative);
      claim(mcpNames, `${sub}:${name}`, file.absolute, `${singular(sub)} name "${name}"`);
      if (sub === "tools") {
        const d = def;
        mcp.tools.push({
          name,
          description: d.description,
          title: d.title,
          input: d.input,
          // Normalised here rather than on first request, so a malformed
          // schema is a boot error naming the file, like every other one.
          shape: toRawShape(d.input, file.absolute),
          handler: d.handler,
          meta: Object.freeze({ ...d[META] }),
          file: file.absolute
        });
      } else {
        const d = def;
        mcp.prompts.push({
          name,
          description: d.description,
          title: d.title,
          input: d.input,
          shape: assertPromptShape(toRawShape(d.input, file.absolute), file.absolute),
          handler: d.handler,
          file: file.absolute
        });
      }
    }
  }
  const mwDir = (0, import_node_path3.join)(sourceDir, dirs.middlewares);
  for (const file of await walkDir(mwDir)) {
    files.push(file.absolute);
    const def = await loadDefault(loader, file.absolute);
    if (definitionKind(def) !== "middleware") {
      throw new CloveBootError(
        `Files in ${dirs.middlewares}/ must default-export middleware(...), but this one exports ${describe(definitionKind(def))}.`,
        [file.absolute]
      );
    }
    middlewares.push({
      name: stripPriority(file.relative),
      priority: parsePriority(file.relative),
      fn: def.fn,
      file: file.absolute
    });
  }
  middlewares.sort(comparePriority);
  let views2 = null;
  for (const ext of ["ts", "js", "mjs", "cjs"]) {
    const viewsFile = (0, import_node_path3.join)(sourceDir, `views.${ext}`);
    if (!(0, import_node_fs2.existsSync)(viewsFile)) continue;
    files.push(viewsFile);
    const def = await loadDefault(loader, viewsFile);
    if (definitionKind(def) !== "views") {
      throw new CloveBootError(
        `views.${ext} must default-export views(...), but it exports ${describe(definitionKind(def))}.`,
        [viewsFile]
      );
    }
    views2 = def.engine;
    break;
  }
  return { routes, middlewares, sockets, socketHandlers, mcp, registry, views: views2, files };
}
async function loadRoutes(loader, dir, label, mount, routes, files) {
  for (const file of await walkDir(dir)) {
    files.push(file.absolute);
    const def = await loadDefault(loader, file.absolute);
    if (definitionKind(def) !== "route") {
      throw new CloveBootError(
        `Files in ${label}/ must default-export a route handler wrapped in get(), post(), put(), patch(), del(), head(), options() or all(), but this one exports ${describe(definitionKind(def))}.`,
        [file.absolute]
      );
    }
    const route2 = def;
    const derived = deriveRoutePath(file.relative);
    if (derived.method !== null && derived.method !== route2.method) {
      throw new CloveBootError(
        `Method mismatch: the filename says ${derived.method} but the handler is wrapped in ${route2.method.toLowerCase()}(). Make them agree, or drop the method suffix from the filename.`,
        [file.absolute]
      );
    }
    if (route2[CACHE] && !["GET", "HEAD"].includes(route2.method)) {
      throw new CloveBootError(
        `Only GET and HEAD routes can be cached, but this route uses ${route2.method}. Use .invalidates(...) on mutation routes instead.`,
        [file.absolute]
      );
    }
    if (route2[CACHE]) {
      try {
        validateCachePolicy(route2[CACHE]);
      } catch (err) {
        throw new CloveBootError(
          err instanceof Error ? err.message : "Invalid route cache policy.",
          [file.absolute]
        );
      }
    }
    routes.add({
      method: route2.method,
      path: (0, import_node_path3.join)("/", mount, derived.path).split("\\").join("/"),
      handler: route2.handler,
      meta: Object.freeze({ ...route2[META] }),
      ...route2[CACHE] ? { cache: Object.freeze({ ...route2[CACHE] }) } : {},
      ...route2[INVALIDATES] ? { invalidates: route2[INVALIDATES] } : {},
      file: file.absolute
    });
  }
}
function describe(kind) {
  if (kind === null) return "a plain value (not an CloveJS definition)";
  return `${kind}(...)`;
}
function claim(taken, key, file, label) {
  const previous = taken.get(key);
  if (previous) {
    throw new CloveBootError(
      `Duplicate ${label}: two files both claim it. Rename one of them, or set an explicit name in the definition.`,
      [previous, file]
    );
  }
  taken.set(key, file);
}
function singular(sub) {
  return sub.endsWith("s") ? sub.slice(0, -1) : sub;
}
function resolveSourceDir(rootDir) {
  const src = (0, import_node_path3.join)(rootDir, "src");
  if ((0, import_node_fs2.existsSync)(src)) return src;
  return rootDir;
}

// src/session/index.ts
var import_node_crypto4 = require("crypto");

// src/session/store.ts
var MemorySessionStore = class {
  #entries = /* @__PURE__ */ new Map();
  #ttl;
  #onExpire;
  #timer;
  constructor(options2 = {}) {
    this.#ttl = options2.ttl ?? 24 * 60 * 60 * 1e3;
    this.#onExpire = options2.onExpire;
    this.#timer = setInterval(() => void this.#sweep(), 6e4);
    this.#timer.unref?.();
  }
  async get(id) {
    const entry = this.#entries.get(id);
    if (!entry) return void 0;
    if (entry.expiresAt <= Date.now()) {
      this.#entries.delete(id);
      await this.#onExpire?.(id);
      return void 0;
    }
    return entry.data;
  }
  async set(id, data) {
    this.#entries.set(id, { data, expiresAt: Date.now() + this.#ttl });
  }
  async touch(id) {
    const entry = this.#entries.get(id);
    if (entry) entry.expiresAt = Date.now() + this.#ttl;
  }
  async destroy(id) {
    this.#entries.delete(id);
  }
  async #sweep() {
    const now = Date.now();
    for (const [id, entry] of this.#entries) {
      if (entry.expiresAt <= now) {
        this.#entries.delete(id);
        await this.#onExpire?.(id);
      }
    }
  }
  /** Stops the sweep timer. Called on server shutdown. */
  close() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = void 0;
  }
  get size() {
    return this.#entries.size;
  }
};
function isSessionStore(value) {
  if (typeof value !== "object" || value === null) return false;
  const v = value;
  return typeof v.get === "function" && typeof v.set === "function" && typeof v.touch === "function" && typeof v.destroy === "function";
}

// src/session/index.ts
var SESSION_COOKIE = "clove.sid";
var SessionManager = class {
  store;
  cookieName;
  #root;
  #registry;
  #secret;
  #cookieOptions;
  #containers = /* @__PURE__ */ new Map();
  constructor(root, registry, options2) {
    this.#root = root;
    this.#registry = registry;
    this.#secret = options2.secret;
    this.cookieName = options2.cookieName ?? SESSION_COOKIE;
    this.#cookieOptions = {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      ...options2.cookie
    };
    this.store = options2.store ?? new MemorySessionStore({
      ttl: options2.ttl,
      onExpire: (id) => this.#disposeContainer(id)
    });
  }
  /** True when the project declares at least one session-scoped provider. */
  get needed() {
    return this.#registry.byLifetime("session").length > 0;
  }
  /**
   * Resolves the session container for a request, creating one (and issuing a
   * cookie) only when the request actually carries or needs a session.
   */
  async acquire(req, res) {
    const raw = req.cookie[this.cookieName];
    const existingId = raw ? unsign(raw, this.#secret) : null;
    if (existingId) {
      const cached = this.#containers.get(existingId);
      if (cached && !cached.disposed) {
        await this.store.touch(existingId);
        return { container: cached, id: existingId, isNew: false };
      }
      const stored = await this.store.get(existingId);
      if (stored) {
        const container2 = this.#root.createChild("session");
        for (const [key, value] of Object.entries(stored)) container2.set(key, value);
        this.#containers.set(existingId, container2);
        return { container: container2, id: existingId, isNew: false };
      }
    }
    const id = (0, import_node_crypto4.randomBytes)(24).toString("base64url");
    const container = this.#root.createChild("session");
    this.#containers.set(id, container);
    await this.store.set(id, {});
    res.cookie(this.cookieName, sign(id, this.#secret), this.#cookieOptions);
    return { container, id, isNew: true };
  }
  /**
   * Resolves the session container for an id supplied by the caller, rather
   * than read from a cookie.
   *
   * Transports that carry their own session identity use this — MCP, for
   * instance, identifies a session by the `Mcp-Session-Id` header. The id is
   * trusted as given: it is the transport's job to have minted and validated
   * it, exactly as the cookie path signs and verifies its own.
   */
  async acquireById(id) {
    const cached = this.#containers.get(id);
    if (cached && !cached.disposed) {
      await this.store.touch(id);
      return { container: cached, id, isNew: false };
    }
    const container = this.#root.createChild("session");
    const stored = await this.store.get(id);
    if (stored) {
      for (const [key, value] of Object.entries(stored)) container.set(key, value);
    } else {
      await this.store.set(id, {});
    }
    this.#containers.set(id, container);
    return { container, id, isNew: stored === null || stored === void 0 };
  }
  /** Writes the session container's session-scoped values back to the store. */
  async persist(id, container) {
    const data = {};
    for (const provider of this.#registry.byLifetime("session")) {
      if (container.isResolved(provider.key)) {
        data[provider.key] = container.get(provider.key);
      }
    }
    await this.store.set(id, data);
  }
  async destroy(id) {
    await this.store.destroy(id);
    await this.#disposeContainer(id);
  }
  async #disposeContainer(id) {
    const container = this.#containers.get(id);
    this.#containers.delete(id);
    if (container) await container.dispose();
  }
  /** Disposes every live session. Called during server shutdown. */
  async disposeAll() {
    const ids = [...this.#containers.keys()];
    await Promise.all(ids.map((id) => this.#disposeContainer(id)));
    if (this.store instanceof MemorySessionStore) this.store.close();
  }
};

// src/ws/index.ts
var import_ws = require("ws");
var WsRuntime = class {
  #wss;
  #options;
  #connections = /* @__PURE__ */ new Set();
  constructor(options2) {
    this.#options = options2;
    this.#wss = new import_ws.WebSocketServer({ noServer: true });
  }
  get empty() {
    return this.#options.handlers.size === 0;
  }
  /** Attaches the upgrade listener to an HTTP server. */
  attach(server) {
    if (this.empty) return;
    server.on("upgrade", (req, socket, head2) => {
      this.handleUpgrade(req, socket, head2);
    });
  }
  handleUpgrade(req, socket, head2) {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const match = this.#options.sockets.match("GET", url.pathname);
    const route2 = match ? this.#options.handlers.get(match.route.path) : void 0;
    if (!match || !route2) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    this.#wss.handleUpgrade(req, socket, head2, (ws2) => {
      void this.#open(ws2, req, route2, match.params);
    });
  }
  /**
   * Opens a connection over a caller-supplied socket, bypassing the HTTP
   * upgrade. Returns false when no `ws/` handler matches the path, so the
   * testing layer can turn that into a clear error. Not part of the serving
   * path — {@link handleUpgrade} is.
   */
  openTestConnection(path, socket) {
    const url = new URL(path, "http://localhost");
    const match = this.#options.sockets.match("GET", url.pathname);
    const route2 = match ? this.#options.handlers.get(match.route.path) : void 0;
    if (!match || !route2) return false;
    const raw = {
      method: "GET",
      url: path,
      headers: { host: "localhost" },
      socket: {}
    };
    void this.#open(socket, raw, route2, match.params);
    return true;
  }
  async #open(socket, raw, route2, params) {
    const container = this.#options.root.createChild("request");
    const entry = { socket, container };
    this.#connections.add(entry);
    const messageHandlers = [];
    const closeHandlers = [];
    const req = new CloveRequest(raw);
    req.params = params;
    const args = {
      ctx: container.ctx,
      req,
      params,
      onMessage: (fn) => void messageHandlers.push(fn),
      onClose: (fn) => void closeHandlers.push(fn),
      onDestroy: (fn) => container.registerDestroyHook(fn),
      send: (data) => {
        if (socket.readyState !== socket.OPEN) return;
        socket.send(
          typeof data === "string" || Buffer.isBuffer(data) ? data : JSON.stringify(data)
        );
      },
      close: (code, reason) => socket.close(code, reason)
    };
    socket.on("message", (data, isBinary) => {
      const msg = isBinary ? toBuffer(data) : toBuffer(data).toString("utf8");
      for (const fn of messageHandlers) {
        try {
          const r = fn(msg);
          if (r instanceof Promise) r.catch((err) => this.#onError(err));
        } catch (err) {
          this.#onError(err);
        }
      }
    });
    socket.on("close", () => {
      this.#connections.delete(entry);
      void (async () => {
        for (const fn of closeHandlers) {
          try {
            await fn();
          } catch (err) {
            this.#onError(err);
          }
        }
        try {
          await container.dispose();
        } catch (err) {
          this.#onError(err);
        }
      })();
    });
    socket.on("error", (err) => this.#onError(err));
    try {
      await route2.handler(args);
    } catch (err) {
      this.#onError(err);
      socket.close(1011, "Handler failed");
    }
  }
  #onError(err) {
    this.#options.logger.error("WebSocket error:", err);
  }
  /** Closes every open socket and disposes their scopes. */
  async close() {
    const entries = [...this.#connections];
    for (const { socket } of entries) socket.close(1001, "Server shutting down");
    await Promise.all(
      entries.map(({ container }) => container.dispose().catch(() => void 0))
    );
    this.#connections.clear();
    await new Promise((resolve) => this.#wss.close(() => resolve()));
  }
};
function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(String(data));
}

// src/app.ts
var CloveApp = class {
  registry;
  routes;
  root;
  logger;
  ws;
  mcp;
  sessions;
  cache;
  scan;
  #options;
  #closed = false;
  constructor(scan, root, logger, sessions, ws2, mcp, cache, options2) {
    this.scan = scan;
    this.registry = scan.registry;
    this.routes = scan.routes;
    this.root = root;
    this.logger = logger;
    this.sessions = sessions;
    this.ws = ws2;
    this.mcp = mcp;
    this.cache = cache;
    this.#options = options2;
  }
  /**
   * Handles one request. Returns false when no route matched, so an Express
   * host can fall through to its own stack.
   */
  async handle(rawReq, rawRes) {
    const req = new CloveRequest(rawReq, this.#options.bodyLimit);
    if (this.mcp.owns(req.path)) {
      const body = req.method === "POST" ? await req.readBody() : void 0;
      try {
        return await this.mcp.handle(rawReq, rawRes, body);
      } catch (err) {
        this.logger.error("MCP transport error:", err);
        if (!rawRes.headersSent) {
          const res2 = new CloveResponse(rawRes);
          writeError(err, res2, {
            exposeErrors: this.#options.exposeErrors,
            logger: this.logger
          });
        }
        return true;
      }
    }
    const match = this.routes.match(req.method, req.path);
    if (!match) return false;
    req.params = match.params;
    const res = new CloveResponse(rawRes, {
      buffered: Boolean(match.route.cache)
    });
    let sessionId;
    let sessionContainer;
    let requestContainer;
    let completion;
    try {
      const parent = this.sessions.needed ? await (async () => {
        const acquired = await this.sessions.acquire(req, res);
        sessionId = acquired.id;
        sessionContainer = acquired.container;
        return acquired.container;
      })() : this.root;
      requestContainer = parent.createChild("request");
      await req.readBody();
      completion = await runPipeline(match.route, req, res, requestContainer, {
        middlewares: this.scan.middlewares,
        exposeErrors: this.#options.exposeErrors,
        logger: this.logger,
        views: this.scan.views,
        cache: this.cache
      });
      await this.cache.complete(res, completion);
      if (completion.handlerExecuted) {
        this.cache.applyClientPolicy(match.route, req, res);
      }
      if (match.route.invalidates && completion.handlerExecuted && completion.error === void 0 && res.statusCode >= 200 && res.statusCode < 300) {
        await this.cache.invalidateRoute(match.route.invalidates, {
          route: match.route,
          req,
          res,
          ctx: requestContainer.ctx,
          result: completion.result
        }).catch((err) => this.logger.error("Route cache invalidation failed:", err));
      }
    } catch (err) {
      await this.cache.complete(res, {
        result: completion?.result,
        error: err,
        handlerExecuted: completion?.handlerExecuted ?? false
      }).catch(() => void 0);
      writeError(err, res, {
        exposeErrors: this.#options.exposeErrors,
        logger: this.logger
      });
    } finally {
      if (!res.sent) res.end();
      res.commit({ omitBody: req.method === "HEAD" });
      if (sessionId && sessionContainer) {
        await this.sessions.persist(sessionId, sessionContainer).catch((err) => this.logger.error("Failed to persist session:", err));
      }
      if (requestContainer) {
        await requestContainer.dispose().catch((err) => this.logger.error("Error disposing request scope:", err));
      }
    }
    return true;
  }
  /** A node `request` listener that 404s unmatched paths. */
  get listener() {
    return (rawReq, rawRes) => {
      void this.handle(rawReq, rawRes).then((handled) => {
        if (!handled && !rawRes.writableEnded) {
          const res = new CloveResponse(rawRes);
          const status = this.routes.hasPath(new URL(
            rawReq.url ?? "/",
            `http://${rawReq.headers.host ?? "localhost"}`
          ).pathname) ? 405 : 404;
          writeError(
            error(status, {
              message: status === 405 ? "Method Not Allowed" : "Not Found"
            }),
            res,
            { exposeErrors: this.#options.exposeErrors, logger: this.logger }
          );
        }
      });
    };
  }
  /** An Express-compatible middleware: unmatched requests call `next()`. */
  get middleware() {
    return (rawReq, rawRes, next) => {
      void this.handle(rawReq, rawRes).then(
        (handled) => {
          if (!handled) next();
        },
        (err) => next(err)
      );
    };
  }
  attachUpgrade(server) {
    this.ws.attach(server);
  }
  handleUpgrade(req, socket, head2) {
    this.ws.handleUpgrade(req, socket, head2);
  }
  /** Disposes sockets, sessions and the singleton scope, in that order. */
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    await this.mcp.close().catch((err) => this.logger.error("mcp close:", err));
    await this.ws.close().catch((err) => this.logger.error("ws close:", err));
    await this.sessions.disposeAll().catch((err) => this.logger.error("session cleanup:", err));
    await this.root.dispose();
  }
};
async function createApp(options2 = {}) {
  const rootDir = options2.rootDir ?? process.cwd();
  const loadedEnv = options2.env === false ? [] : loadEnv({
    rootDir,
    ...Array.isArray(options2.env) ? { files: options2.env } : {}
  });
  const sourceDir = options2.sourceDir ?? resolveSourceDir(rootDir);
  const isDev = process.env.NODE_ENV !== "production";
  const logger = createLogger(options2.logLevel ?? (isDev ? "debug" : "info"));
  if (loadedEnv.length > 0) {
    logger.debug(`Loaded ${loadedEnv.length} variable(s) from .env: ${loadedEnv.join(", ")}`);
  }
  const loader = await createLoader(rootDir, {
    moduleCache: options2.moduleCache ?? true
  });
  const scan = await scanProject({ sourceDir, loader });
  if (!scan.registry.has("logger")) {
    scan.registry.add({
      key: "logger",
      kind: "builtin",
      lifetime: "singleton",
      file: "<builtin>",
      value: logger,
      isFactory: false
    });
  }
  if (!scan.registry.has("cacheStore")) {
    scan.registry.add({
      key: "cacheStore",
      kind: "builtin",
      lifetime: "singleton",
      file: "<builtin>",
      value: new MemoryCacheStore(),
      isFactory: false
    });
  }
  if (scan.registry.has("cache")) {
    throw new CloveBootError(
      '`ctx.cache` is reserved by CloveJS. Rename the service or DI value that provides "cache".',
      [scan.registry.get("cache").file]
    );
  }
  scan.registry.add({
    key: "cache",
    kind: "builtin",
    lifetime: "singleton",
    file: "<builtin>",
    isFactory: true,
    factory: async (ctx) => {
      const store = await ctx.cacheStore;
      if (!isCacheStore(store)) {
        throw new TypeError(
          "services/cacheStore.ts must return an object with get, set, delete and invalidateTags methods."
        );
      }
      return new CacheRuntime(store, logger);
    }
  });
  if (options2.overrides) {
    for (const [key, value] of Object.entries(options2.overrides)) {
      const existing = scan.registry.get(key);
      const isFactory = typeof value === "function";
      scan.registry.override({
        key,
        kind: existing?.kind ?? "di",
        lifetime: existing?.lifetime ?? "singleton",
        file: "<override>",
        isFactory,
        ...isFactory ? { factory: value } : { value }
      });
    }
  }
  const root = new Container(scan.registry, "singleton");
  await root.ensure();
  const cache = root.get("cache");
  const secret = options2.sessionSecret ?? process.env.CLOVE_SECRET ?? null;
  if (!secret && scan.registry.byLifetime("session").length > 0) {
    logger.warn(
      "No session secret configured. Set CLOVE_SECRET (or pass sessionSecret) before deploying \u2014 sessions are signed with an ephemeral key, so they will not survive a restart."
    );
  }
  const userStore = scan.registry.has("sessionStore") ? root.get("sessionStore") : void 0;
  const sessions = new SessionManager(root, scan.registry, {
    secret: secret ?? randomSecret(),
    ttl: options2.sessionTtl,
    ...isSessionStore(userStore) ? { store: userStore } : {}
  });
  const ws2 = new WsRuntime({
    sockets: scan.sockets,
    handlers: scan.socketHandlers,
    root,
    logger
  });
  const mcp = new McpRuntime({
    scan: scan.mcp,
    root,
    logger,
    sessions,
    ...options2.mcpPath ? { path: options2.mcpPath } : {},
    ...options2.mcpServerInfo ? { serverInfo: options2.mcpServerInfo } : {},
    ...scan.mcp.auth ? { auth: scan.mcp.auth } : {},
    exposeErrors: options2.exposeErrors ?? isDev
  });
  return new CloveApp(scan, root, logger, sessions, ws2, mcp, cache, {
    bodyLimit: options2.bodyLimit ?? DEFAULT_BODY_LIMIT,
    exposeErrors: options2.exposeErrors ?? isDev
  });
}
function randomSecret() {
  return Buffer.from(
    globalThis.crypto.getRandomValues(new Uint8Array(32))
  ).toString("base64url");
}

// src/bootstrap.ts
async function bootstrap(options2 = {}) {
  const app = await createApp(options2);
  const port = options2.port ?? Number(process.env.PORT ?? 3e3);
  const host = options2.host ?? process.env.HOST ?? "localhost";
  const server = (0, import_node_http.createServer)(app.listener);
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
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
});
//# sourceMappingURL=index.cjs.map