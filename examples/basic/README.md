# CloveJS — basic example

A small notes API that exercises the core conventions in one runnable app:
routes and route parameters, the JSON middleware's status-code rules, the
three DI lifetimes, middleware ordering, sessions, and WebSockets.

## Run it

From the repository root (this example is an npm workspace, so one install
covers it):

```bash
npm install
npm run dev -w clovejs-example-basic
```

Or from this directory once the root install has run:

```bash
cd examples/basic
npm run dev
```

Visit `http://localhost:3000/api/hello`.

## What to look at

| File | Demonstrates |
| --- | --- |
| [`src/api/notes.get.ts`](./src/api/notes.get.ts) | Returning an array → `200` |
| [`src/api/notes.post.ts`](./src/api/notes.post.ts) | `error()`, and `res.status()` alongside a returned body |
| [`src/api/notes/[id].get.ts`](./src/api/notes/%5Bid%5D.get.ts) | Route parameters; `null` from a `GET` → `404` |
| [`src/api/notes/[id].delete.ts`](./src/api/notes/%5Bid%5D.delete.ts) | Returning nothing → `204` |
| [`src/api/login.post.ts`](./src/api/login.post.ts), [`src/api/me.get.ts`](./src/api/me.get.ts) | Sessions: assigning a session-scoped `di` value from a handler |
| [`src/di/config.ts`](./src/di/config.ts) | `singleton` lifetime |
| [`src/di/currentUser.ts`](./src/di/currentUser.ts) | `session` lifetime |
| [`src/di/requestId.ts`](./src/di/requestId.ts) | `request` lifetime, computed with a factory |
| [`src/middlewares/trace.0.ts`](./src/middlewares/trace.0.ts), [`src/middlewares/authorize.1.ts`](./src/middlewares/authorize.1.ts) | Numeric middleware ordering; code on both sides of `handler.execute()` |
| [`src/api/admin/stats.get.ts`](./src/api/admin/stats.get.ts) | Route metadata, read by a middleware |
| [`src/ws/echo.ts`](./src/ws/echo.ts) | WebSockets |

## `requests.http` — a Postman collection without Postman

[`requests.http`](./requests.http) is a plain text alternative to a
Postman/Insomnia collection: no app to install, no account, nothing synced to
a cloud. It's a format read natively by two tools you may already have:

- **JetBrains IDEs** (WebStorm, IntelliJ, …) — open the file and use the ▷
  gutter icon, or **Run ▸ HTTP Client**.
- **VS Code**, via the [REST Client
  extension](https://marketplace.visualstudio.com/items?itemName=humao.rest-client)
  (`humao.rest-client`) — a "Send Request" link appears above each block.

Both keep a cookie jar scoped to the file, so logging in partway through
carries the `clove.sid` session cookie into every request below it
automatically — nothing to copy out of a response by hand.

With the dev server running, open the file and step through it top to bottom.
It exercises the same flow as the curl walkthrough below: an anonymous
request, a `401` before logging in, logging in as `ada` (an admin) or `grace`
(not), the `admin/stats` route allowing one and rejecting the other, and a
note created, fetched and deleted along the way.

## Try the whole flow with curl

No editor plugin, no problem — the same flow, one command at a time:

```bash
# Public
curl localhost:3000/api/notes

# Guarded — 401 until you log in
curl localhost:3000/api/me

# Log in (credentials are ada/secret or grace/secret — see src/services/auth.ts)
curl -c cookies.txt -X POST localhost:3000/api/login \
  -H 'content-type: application/json' \
  -d '{"username":"ada","password":"secret"}'

# The clove.sid cookie now carries the session
curl -b cookies.txt localhost:3000/api/me

# ada is an admin; grace is not
curl -b cookies.txt localhost:3000/api/admin/stats
```

Full explanations live in the [guide](https://cloveteam.github.io/clovejs/).
