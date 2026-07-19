// src/types.ts
var KIND = /* @__PURE__ */ Symbol.for("clovejs.kind");
var META = /* @__PURE__ */ Symbol.for("clovejs.meta");
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
import { createServer } from "http";

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
import { createHmac, timingSafeEqual } from "crypto";
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
  const mac = createHmac("sha256", secret).update(value).digest("base64url");
  return `${value}.${mac}`;
}
function unsign(signed, secret) {
  const idx = signed.lastIndexOf(".");
  if (idx < 0) return null;
  const value = signed.slice(0, idx);
  const mac = signed.slice(idx + 1);
  const expected = createHmac("sha256", secret).update(value).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  return timingSafeEqual(a, b) ? value : null;
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
  raw;
  /** True once a body has been written through this wrapper or the raw stream. */
  #sent = false;
  /** True when the handler set a content type itself, whatever it was. */
  #typeExplicit = false;
  constructor(raw) {
    this.raw = raw;
  }
  get sent() {
    return this.#sent || this.raw.writableEnded || this.raw.headersSent;
  }
  /** Whether the handler chose the content type rather than inheriting it. */
  get typeIsExplicit() {
    return this.#typeExplicit;
  }
  get statusCode() {
    return this.raw.statusCode;
  }
  status(code) {
    this.raw.statusCode = code;
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
    this.raw.setHeader("content-type", resolved);
    this.#typeExplicit = true;
    return this;
  }
  /** The content type currently set on the response, if any. */
  get contentType() {
    const v = this.raw.getHeader("content-type");
    return v === void 0 ? void 0 : String(v);
  }
  header(name, value) {
    this.raw.setHeader(name, value);
    return this;
  }
  /** Alias of {@link header}, for readers coming from Express. */
  set(name, value) {
    return this.header(name, value);
  }
  cookie(name, value, opts = {}) {
    const existing = this.raw.getHeader("set-cookie");
    const serialized = serializeCookie(name, value, opts);
    const list = Array.isArray(existing) ? [...existing, serialized] : existing ? [String(existing), serialized] : [serialized];
    this.raw.setHeader("set-cookie", list);
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
      this.raw.end(body);
      return this;
    }
    if (typeof body === "string") {
      if (!this.contentType) this.type("html");
      this.#sent = true;
      this.raw.end(body);
      return this;
    }
    return this.json(body);
  }
  json(body) {
    if (this.sent) return this;
    if (!this.contentType) this.raw.setHeader("content-type", MIME_SHORTHAND.json);
    this.#sent = true;
    this.raw.end(JSON.stringify(body));
    return this;
  }
  /** Ends the response with no body. */
  end() {
    if (this.sent) return this;
    this.#sent = true;
    this.raw.end();
    return this;
  }
};

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

// src/pipeline/index.ts
async function runPipeline(route2, req, res, container, options2) {
  const ctx = container.ctx;
  try {
    const result = await composeChain(route2, req, res, ctx, options2.middlewares);
    if (jsonEnabled(route2, res)) {
      applyJsonResult(result, route2, res, req.method);
    } else if (!res.sent) {
      if (result !== void 0 && result !== null) res.send(result);
      else res.end();
    }
  } catch (err) {
    writeError(err, res, options2);
  }
}
function composeChain(route2, req, res, ctx, middlewares) {
  let index = -1;
  const dispatch = async (i) => {
    if (i <= index) {
      throw new Error(
        `Middleware "${middlewares[i - 1]?.name}" called handler.execute() more than once.`
      );
    }
    index = i;
    if (i === middlewares.length) {
      return await route2.handler(req, res, ctx);
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
import { existsSync } from "fs";
import { join as join2 } from "path";

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
import { pathToFileURL } from "url";
function createNativeLoader() {
  const versions = /* @__PURE__ */ new Map();
  return {
    async load(absolutePath) {
      const version = versions.get(absolutePath);
      const url = pathToFileURL(absolutePath).href + (version ? `?v=${version}` : "");
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

// src/scanner/walk.ts
import { readdir } from "fs/promises";
import { join, relative, sep } from "path";
var SOURCE_EXTENSIONS = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"];
var IGNORED_DIRS = /* @__PURE__ */ new Set(["node_modules", ".git", ".clove", "dist", "build"]);
async function walkDir(root) {
  const out = [];
  async function visit(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code === "ENOENT") return;
      throw err;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        await visit(full);
      } else if (entry.isFile() && isSourceFile(entry.name)) {
        out.push({ absolute: full, relative: relative(root, full).split(sep).join("/") });
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
  ws: "ws",
  di: "di",
  services: "services",
  middlewares: "middlewares"
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
    const dir = join2(sourceDir, dirs[kind]);
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
  const apiDir = join2(sourceDir, dirs.api);
  for (const file of await walkDir(apiDir)) {
    files.push(file.absolute);
    const def = await loadDefault(loader, file.absolute);
    if (definitionKind(def) !== "route") {
      throw new CloveBootError(
        `Files in ${dirs.api}/ must default-export a route handler wrapped in get(), post(), put(), patch(), del(), head(), options() or all(), but this one exports ${describe(definitionKind(def))}.`,
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
    const registered = {
      method: route2.method,
      path: join2("/", dirs.api, derived.path).split("\\").join("/"),
      handler: route2.handler,
      meta: Object.freeze({ ...route2[META] }),
      file: file.absolute
    };
    routes.add(registered);
  }
  const wsDir = join2(sourceDir, dirs.ws);
  for (const file of await walkDir(wsDir)) {
    files.push(file.absolute);
    const def = await loadDefault(loader, file.absolute);
    if (definitionKind(def) !== "ws") {
      throw new CloveBootError(
        `Files in ${dirs.ws}/ must default-export ws(...), but this one exports ${describe(definitionKind(def))}.`,
        [file.absolute]
      );
    }
    const path = join2("/", dirs.ws, deriveSocketPath(file.relative)).split("\\").join("/");
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
  const mwDir = join2(sourceDir, dirs.middlewares);
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
  return { routes, middlewares, sockets, socketHandlers, registry, files };
}
function describe(kind) {
  if (kind === null) return "a plain value (not an CloveJS definition)";
  return `${kind}(...)`;
}
function resolveSourceDir(rootDir) {
  const src = join2(rootDir, "src");
  if (existsSync(src)) return src;
  return rootDir;
}

// src/session/index.ts
import { randomBytes } from "crypto";

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
    const id = randomBytes(24).toString("base64url");
    const container = this.#root.createChild("session");
    this.#containers.set(id, container);
    await this.store.set(id, {});
    res.cookie(this.cookieName, sign(id, this.#secret), this.#cookieOptions);
    return { container, id, isNew: true };
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
import { WebSocketServer } from "ws";
var WsRuntime = class {
  #wss;
  #options;
  #connections = /* @__PURE__ */ new Set();
  constructor(options2) {
    this.#options = options2;
    this.#wss = new WebSocketServer({ noServer: true });
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
  sessions;
  scan;
  #options;
  #closed = false;
  constructor(scan, root, logger, sessions, ws2, options2) {
    this.scan = scan;
    this.registry = scan.registry;
    this.routes = scan.routes;
    this.root = root;
    this.logger = logger;
    this.sessions = sessions;
    this.ws = ws2;
    this.#options = options2;
  }
  /**
   * Handles one request. Returns false when no route matched, so an Express
   * host can fall through to its own stack.
   */
  async handle(rawReq, rawRes) {
    const req = new CloveRequest(rawReq, this.#options.bodyLimit);
    const res = new CloveResponse(rawRes);
    const match = this.routes.match(req.method, req.path);
    if (!match) return false;
    req.params = match.params;
    let sessionId;
    let sessionContainer;
    let requestContainer;
    try {
      const parent = this.sessions.needed ? await (async () => {
        const acquired = await this.sessions.acquire(req, res);
        sessionId = acquired.id;
        sessionContainer = acquired.container;
        return acquired.container;
      })() : this.root;
      requestContainer = parent.createChild("request");
      await req.readBody();
      await runPipeline(match.route, req, res, requestContainer, {
        middlewares: this.scan.middlewares,
        exposeErrors: this.#options.exposeErrors,
        logger: this.logger
      });
    } catch (err) {
      writeError(err, res, {
        exposeErrors: this.#options.exposeErrors,
        logger: this.logger
      });
    } finally {
      if (!res.sent) res.end();
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
    await this.ws.close().catch((err) => this.logger.error("ws close:", err));
    await this.sessions.disposeAll().catch((err) => this.logger.error("session cleanup:", err));
    await this.root.dispose();
  }
};
async function createApp(options2 = {}) {
  const rootDir = options2.rootDir ?? process.cwd();
  const sourceDir = options2.sourceDir ?? resolveSourceDir(rootDir);
  const isDev = process.env.NODE_ENV !== "production";
  const logger = createLogger(options2.logLevel ?? (isDev ? "debug" : "info"));
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
  const root = new Container(scan.registry, "singleton");
  await root.ensure();
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
  return new CloveApp(scan, root, logger, sessions, ws2, {
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
  app.logger.info(
    `CloveJS listening on ${url} \u2014 ${routeCount} route${routeCount === 1 ? "" : "s"}` + (socketCount ? `, ${socketCount} socket${socketCount === 1 ? "" : "s"}` : "")
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
  middleware,
  options,
  patch,
  post,
  put,
  service,
  ws
};
//# sourceMappingURL=index.js.map