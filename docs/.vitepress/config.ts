import { defineConfig } from "vitepress"
import pkg from "../../package.json"

// GitHub Pages serves the site from a repository subpath. Override with
// DOCS_BASE=/ when deploying to a user/organisation page or a custom domain.
const base = process.env.DOCS_BASE ?? "/clovejs/"

export default defineConfig({
  base,
  lang: "en-US",
  title: "CloveJS",
  description:
    "A convention-driven Node.js HTTP framework. Routes, services, middlewares and injectables are discovered from the filesystem.",
  cleanUrls: true,
  lastUpdated: true,

  head: [
    ["link", { rel: "icon", href: `${base}favicon.svg`, type: "image/svg+xml" }],
    ["meta", { name: "theme-color", content: "#3f9d6f" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:title", content: "CloveJS — files in, routes out" }],
    [
      "meta",
      {
        property: "og:description",
        content:
          "A convention-driven Node.js HTTP framework with TypeScript and DI in the box.",
      },
    ],
  ],

  themeConfig: {
    logo: "/logo.svg",
    siteTitle: "CloveJS",

    nav: [
      { text: "Guide", link: "/guide/getting-started", activeMatch: "/guide/" },
      { text: "Reference", link: "/reference/cli", activeMatch: "/reference/" },
      { text: `v${pkg.version}`, link: "/reference/changelog" },
    ],

    sidebar: {
      "/guide/": [
        {
          text: "Introduction",
          items: [
            { text: "What is CloveJS?", link: "/guide/what-is-clovejs" },
            { text: "Getting started", link: "/guide/getting-started" },
            { text: "Project structure", link: "/guide/project-structure" },
            { text: "AI editors", link: "/guide/ai-editors" },
          ],
        },
        {
          text: "Routing",
          items: [
            { text: "Routes", link: "/guide/routes" },
            { text: "Route parameters", link: "/guide/route-parameters" },
            { text: "Route metadata", link: "/guide/route-metadata" },
            { text: "Request and response", link: "/guide/request-response" },
          ],
        },
        {
          text: "Dependency injection",
          items: [
            { text: "Services", link: "/guide/services" },
            { text: "Values and lifetimes", link: "/guide/dependency-injection" },
            { text: "Typed context", link: "/guide/typed-context" },
          ],
        },
        {
          text: "Request handling",
          items: [
            { text: "Middlewares", link: "/guide/middlewares" },
            { text: "The JSON middleware", link: "/guide/json-middleware" },
            { text: "Errors", link: "/guide/errors" },
          ],
        },
        {
          text: "Beyond HTTP",
          items: [
            { text: "WebSockets", link: "/guide/websockets" },
            { text: "MCP servers", link: "/guide/mcp" },
            { text: "Sessions", link: "/guide/sessions" },
          ],
        },
        {
          text: "Running it",
          items: [
            { text: "Bootstrap", link: "/guide/bootstrap" },
            { text: "Testing", link: "/guide/testing" },
            { text: "Express interop", link: "/guide/express-interop" },
            { text: "Deployment", link: "/guide/deployment" },
          ],
        },
      ],
      "/reference/": [
        {
          text: "Reference",
          items: [
            { text: "CLI", link: "/reference/cli" },
            { text: "Definitions", link: "/reference/definitions" },
            { text: "Configuration", link: "/reference/configuration" },
            { text: "CloveRequest", link: "/reference/clove-request" },
            { text: "CloveResponse", link: "/reference/clove-response" },
            { text: "Types", link: "/reference/types" },
            { text: "Changelog", link: "/reference/changelog" },
          ],
        },
      ],
    },

    outline: { level: [2, 3], label: "On this page" },

    socialLinks: [{ icon: "github", link: "https://github.com/cloveteam/clovejs" }],

    editLink: {
      pattern: "https://github.com/cloveteam/clovejs/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },

    search: { provider: "local" },

    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright © 2026 CloveJS contributors",
    },
  },

  markdown: {
    theme: { light: "github-light", dark: "github-dark" },
    lineNumbers: false,
  },

  sitemap: { hostname: "https://cloveteam.github.io/clovejs/" },
})
