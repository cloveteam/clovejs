import type { Container } from "../container/container.js"
import type { CacheRuntime, PipelineCompletion } from "../cache/runtime.js"
import type { Logger } from "../container/logger.js"
import { isHttpError } from "../errors.js"
import type { CloveRequest } from "../http/request.js"
import type { CloveResponse } from "../http/response.js"
import type { LoadedMiddleware } from "../scanner/index.js"
import { isViewResult, type MiddlewareArgs, type Route, type RuntimeCtx, type ViewEngine } from "../types.js"
import { applyJsonResult, jsonEnabled } from "./json.js"
import { applyViewResult } from "./view.js"

export interface PipelineOptions {
  middlewares: LoadedMiddleware[]
  /** Include stack traces in 500 responses. */
  exposeErrors: boolean
  logger: Logger
  /** The registered template engine, or null when the project has none. */
  views: ViewEngine | null
  cache?: CacheRuntime
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
): Promise<PipelineCompletion> {
  const ctx = container.ctx as RuntimeCtx
  let handlerExecuted = false
  let result: unknown

  try {
    result = await composeChain(
      route,
      req,
      res,
      ctx,
      options.middlewares,
      async () => {
        handlerExecuted = true
        const execute = () => Promise.resolve(route.handler(req, res, ctx))
        return options.cache
          ? options.cache.execute(route, req, res, ctx, execute)
          : execute()
      },
    )
    if (isViewResult(result)) {
      await applyViewResult(result, res, ctx, options.views)
    } else if (jsonEnabled(route, res)) {
      applyJsonResult(result, route, res, req.method)
    } else if (!res.sent) {
      // The route opted out of JSON handling but wrote nothing; close it out.
      if (result !== undefined && result !== null) res.send(result)
      else res.end()
    }
    return { result, handlerExecuted }
  } catch (err) {
    writeError(err, res, options)
    return { result, error: err, handlerExecuted }
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
  executeRoute: () => Promise<unknown>,
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
      return await executeRoute()
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
