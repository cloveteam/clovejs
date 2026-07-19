import { describe, expect, it } from "vitest"
import {
  deriveMcpName,
  deriveResourceUri,
  isUriTemplate,
  uriTemplateVariables,
} from "../../src/mcp/paths.js"

describe("deriveMcpName", () => {
  it("uses the filename", () => {
    expect(deriveMcpName("searchNotes.ts")).toBe("searchNotes")
  })

  it("flattens nested files with camelCase, matching ctx keys", () => {
    expect(deriveMcpName("notes/search.ts")).toBe("notesSearch")
    expect(deriveMcpName("admin/users/ban.ts")).toBe("adminUsersBan")
  })

  it("drops a trailing index segment", () => {
    expect(deriveMcpName("notes/index.ts")).toBe("notes")
  })

  it("keeps a top-level index as its own name", () => {
    expect(deriveMcpName("index.ts")).toBe("index")
  })

  it("handles every source extension", () => {
    expect(deriveMcpName("search.mjs")).toBe("search")
    expect(deriveMcpName("search.cts")).toBe("search")
  })
})

describe("deriveResourceUri", () => {
  it("makes the first segment the scheme", () => {
    expect(deriveResourceUri("config/app.ts")).toBe("config://app")
  })

  it("turns [param] segments into {param} variables", () => {
    expect(deriveResourceUri("notes/[id].ts")).toBe("notes://{id}")
    expect(deriveResourceUri("db/users/[id]/tags.ts")).toBe("db://users/{id}/tags")
  })

  it("collapses a catch-all segment to a single variable", () => {
    expect(deriveResourceUri("files/[...path].ts")).toBe("files://{path}")
  })

  it("yields a bare scheme for a single segment", () => {
    expect(deriveResourceUri("config.ts")).toBe("config://")
  })

  it("drops a trailing index segment", () => {
    expect(deriveResourceUri("config/index.ts")).toBe("config://")
  })
})

describe("uri templates", () => {
  it("detects templates", () => {
    expect(isUriTemplate("notes://{id}")).toBe(true)
    expect(isUriTemplate("config://app")).toBe(false)
  })

  it("lists variables in order", () => {
    expect(uriTemplateVariables("db://users/{userId}/books/{bookId}")).toEqual([
      "userId",
      "bookId",
    ])
    expect(uriTemplateVariables("config://app")).toEqual([])
  })
})
