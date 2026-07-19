import type { Container } from "../container/container.js"
import type { Logger } from "../container/logger.js"
import { isHttpError } from "../errors.js"
import type { CloveRequest } from "../http/request.js"
import type { CloveResponse } from "../http/response.js"
import type { LoadedMiddleware } from "../scanner/index.js"
import type { MiddlewareArgs, Route, RuntimeCtx } from "../types.js"
import { applyJsonResult, jsonEnabled } from "./json.js"

export interface PipelineOptions {
  middlewares: LoadedMiddleware[]
  /** Include stack traces in 500 responses. */
  exposeErrors: boolean
  logger: Logger
}

/**
 * Runs a matched route through the middleware chain and writes the response.
 *
 * Middlewares wrap the handler onion-style: code before `handler.execute()`
 * runs on the way in, code after it on the way out. A middleware that returns
 * without calling `execute()` short-circuits the ones below it.
 */
export async function runPipeline(
  route: Route,
  req: CloveRequest,
  res: CloveResponse,
  container: Container,
  options: PipelineOptions,
): Promise<void> {
  const ctx = container.ctx as RuntimeCtx

  try {
    const result = await composeChain(route, req, res, ctx, options.middlewares)
    if (jsonEnabled(route, res)) {
      applyJsonResult(result, route, res, req.method)
    } else if (!res.sent) {
      // The route opted out of JSON handling but wrote nothing; close it out.
      if (result !== undefined && result !== null) res.send(result)
      else res.end()
    }
  } catch (err) {
    writeError(err, res, options)
  }
}

/**
 * Builds the onion. The innermost link is the route handler itself; each
 * middleware receives a `handler.execute()` that advances to the next link.
 */
function composeChain(
  route: Route,
  req: CloveRequest,
  res: CloveResponse,
  ctx: RuntimeCtx,
  middlewares: LoadedMiddleware[],
): Promise<unknown> {
  let index = -1

  const dispatch = async (i: number): Promise<unknown> => {
    if (i <= index) {
      throw new Error(
        `Middleware "${middlewares[i - 1]?.name}" called handler.execute() more than once.`,
      )
    }
    index = i

    if (i === middlewares.length) {
      return await route.handler(req, res, ctx)
    }

    const mw = middlewares[i]!
    const args: MiddlewareArgs = {
      route,
      req,
      res,
      ctx,
      handler: { execute: () => dispatch(i + 1) },
    }
    return await mw.fn(args)
  }

  return dispatch(0)
}

/** Renders a thrown value into an HTTP response. */
export function writeError(
  err: unknown,
  res: CloveResponse,
  options: Pick<PipelineOptions, "exposeErrors" | "logger">,
): void {
  if (res.sent) {
    options.logger.error("Error thrown after the response was sent:", err)
    return
  }

  if (isHttpError(err)) {
    res.status(err.status)
    if (!res.contentType || res.contentType.includes("json")) {
      res.json(err.body)
    } else {
      res.send(String(err.message))
    }
    return
  }

  options.logger.error("Unhandled error while serving request:", err)
  res.status(500)
  const body: Record<string, unknown> = { message: "Internal Server Error" }
  if (options.exposeErrors && err instanceof Error) {
    body.error = err.message
    body.stack = err.stack
  }
  res.json(body)
}

export { applyJsonResult, jsonEnabled } from "./json.js"
