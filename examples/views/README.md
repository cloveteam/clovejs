# CloveJS — templates example

The smallest possible app that renders HTML. A handler returns
`view(name, data)`, and a template engine you register turns it into a page.
Clove ships no engine of its own — this example wires up **Handlebars**.

## Run it

From the repository root (this example is an npm workspace, so one install
covers it):

```bash
npm install
npm run dev -w clovejs-example-views
```

Then open `http://localhost:3000/` — or `http://localhost:3000/?name=Ada`.

## The three pieces

| File | Role |
| --- | --- |
| [`src/views.ts`](./src/views.ts) | Registers the engine. Its `render(name, data)` is the only Handlebars-specific code. |
| [`src/web/get.ts`](./src/web/get.ts) | A page handler returning `view("hello", { name })`. Files in `web/` mount at the root `/`, not under `/api`. |
| [`src/views/hello.hbs`](./src/views/hello.hbs) | The template. |

Swapping Handlebars for Eta, EJS, or a bare template literal is a change to
`src/views.ts` alone — no handler is touched.
