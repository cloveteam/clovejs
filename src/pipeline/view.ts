import type { CloveResponse } from "../http/response.js"
import type { RuntimeCtx, ViewEngine, ViewResult } from "../types.js"

/**
 * Renders a `view()` result through the registered engine and writes it.
 *
 * Runs before the JSON step: a handler that returns `view(...)` opts into HTML
 * (or whatever the engine declares) rather than JSON serialization. Render
 * errors and a missing engine both throw, so the pipeline's `catch` renders
 * them as it does any other failure.
 */
export async function applyViewResult(
  result: ViewResult,
  res: CloveResponse,
  ctx: RuntimeCtx,
  engine: ViewEngine | null,
): Promise<void> {
  if (res.sent) return

  if (!engine) {
    throw new Error(
      `A handler returned view("${result.template}") but no view engine is ` +
        `registered. Add views.ts at your source root, default-exporting ` +
        `views({ render }).`,
    )
  }

  const rendered = await engine.render(result.template, result.data, ctx)
  if (res.sent) return
  if (!res.contentType) res.type(engine.contentType ?? "html")
  res.send(rendered)
}
