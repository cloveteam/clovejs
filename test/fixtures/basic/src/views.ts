import { views } from "clovejs"

// A dependency-free stand-in engine: named templates with `{{key}}`
// interpolation. Real projects wrap Eta / EJS / Handlebars in `render`
// instead — the seam is identical.
const templates: Record<string, string> = {
  greeting: "<h1>Hello, {{name}}!</h1><p>served by {{url}}</p>",
}

export default views({
  render(template, data, ctx) {
    const src = templates[template]
    if (src === undefined) throw new Error(`Unknown template: ${template}`)
    // `ctx` lets the adapter fold in globals — here, the app's base URL.
    const scope: Record<string, unknown> = {
      ...(data as Record<string, unknown>),
      url: ctx.config.url,
    }
    return src.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => String(scope[key] ?? ""))
  },
})
