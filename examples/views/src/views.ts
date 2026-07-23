import { readFileSync } from "node:fs"
import { join } from "node:path"
import Handlebars from "handlebars"
import { views } from "clovejs"

// The one seam Clove asks for: turn a template name + data into HTML. Everything
// Handlebars-specific stays here — swapping to Eta or EJS touches no handler.
const viewsDir = join(process.cwd(), "src", "views")

export default views({
  render(name, data) {
    const source = readFileSync(join(viewsDir, `${name}.hbs`), "utf8")
    return Handlebars.compile(source)(data)
  },
})
