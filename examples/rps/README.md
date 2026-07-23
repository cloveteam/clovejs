# CloveJS — RPS benchmark

This example compares a minimal CloveJS app with an equivalent Express app.
Each server exposes exactly one route:

```text
GET /api -> {"message":"Hello, world!"}
```

The CloveJS implementation has one API route and no services, middleware, web
routes, WebSockets, or MCP handlers. `express.js` is the equivalent standalone
Express implementation.

## Run the comparison

From the repository root:

```bash
npm run benchmark -w clovejs-example-rps -- --connections 100 --duration 10
```

Or from this directory:

```bash
npm run benchmark -- --connections 100 --duration 10
```

Short flags are also accepted:

```bash
npm run benchmark -- -c 250 -d 20
```

Use `--target clove` or `--target express` to benchmark only one server.

The script builds the CloveJS app before measuring, launches each server in a
fresh production-mode Node.js process, verifies its response, applies the load,
and stops it before moving to the next server. Both servers use the same
loopback interface, request path, load generator, and persistent connection
count.

The reported metrics are:

- **Heat-up:** elapsed time from spawning the server process to receiving its
  first valid `200` response. CloveJS route discovery is included; compilation
  is not.
- **Average RPS:** successful responses divided by total load-test time.
- **Peak RPS:** the highest successful-response rate in a one-second sample.
- **Peak at:** the end time of the peak sample, which makes warm-up behavior
  under load visible.

Run benchmarks on an otherwise idle machine and repeat them several times.
The load generator and both servers share the same CPU, so absolute results
depend on the host and should primarily be used for like-for-like comparisons.
