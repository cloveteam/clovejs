import { describe, expect, it } from "vitest"
import {
  comparePriority,
  deriveContextKey,
  deriveRoutePath,
  deriveSocketPath,
  parsePriority,
  stripPriority,
} from "../../src/scanner/paths.js"

describe("deriveRoutePath", () => {
  it("resolves every rule listed in the concept document", () => {
    expect(deriveRoutePath("v1/users.get.ts")).toEqual({
      path: "/v1/users",
      method: "GET",
    })
    expect(deriveRoutePath("v1/users/get.ts")).toEqual({
      path: "/v1/users",
      method: "GET",
    })
    expect(deriveRoutePath("v1/users/[id].get.ts")).toEqual({
      path: "/v1/users/[id]",
      method: "GET",
    })
    expect(deriveRoutePath("v1/users/[id]/get.ts")).toEqual({
      path: "/v1/users/[id]",
      method: "GET",
    })
    expect(deriveRoutePath("v1/users/[id]/books.get.ts")).toEqual({
      path: "/v1/users/[id]/books",
      method: "GET",
    })
    expect(deriveRoutePath("v1/users/[userId]/books/[bookId].get.ts")).toEqual({
      path: "/v1/users/[userId]/books/[bookId]",
      method: "GET",
    })
    expect(deriveRoutePath("v1/users/[userId]/books/[bookId]/get.ts")).toEqual({
      path: "/v1/users/[userId]/books/[bookId]",
      method: "GET",
    })
    expect(deriveRoutePath("v1/login.post.ts")).toEqual({
      path: "/v1/login",
      method: "POST",
    })
  })

  it("returns a null method when the filename omits the suffix", () => {
    expect(deriveRoutePath("v1/health.ts")).toEqual({
      path: "/v1/health",
      method: null,
    })
  })

  it("drops an index segment", () => {
    expect(deriveRoutePath("v1/users/index.get.ts").path).toBe("/v1/users")
  })

  it("does not mistake a dotted filename for a method suffix", () => {
    expect(deriveRoutePath("v1/well-known.config.ts")).toEqual({
      path: "/v1/well-known.config",
      method: null,
    })
  })

  it("handles javascript sources identically", () => {
    expect(deriveRoutePath("v1/users/[id].get.js")).toEqual({
      path: "/v1/users/[id]",
      method: "GET",
    })
  })
})

describe("deriveSocketPath", () => {
  it("maps ws files without method handling", () => {
    expect(deriveSocketPath("echo.ts")).toBe("/echo")
    expect(deriveSocketPath("rooms/[roomId].ts")).toBe("/rooms/[roomId]")
    expect(deriveSocketPath("chat/index.ts")).toBe("/chat")
  })
})

describe("parsePriority", () => {
  it("reads single and nested priorities", () => {
    expect(parsePriority("authenticate.1.ts")).toEqual([1])
    expect(parsePriority("audit.1.2.ts")).toEqual([1, 2])
    expect(parsePriority("first.0.ts")).toEqual([0])
    expect(parsePriority("authorize.ts")).toBeNull()
  })

  it("ignores non-numeric dotted segments", () => {
    expect(parsePriority("my.middleware.ts")).toBeNull()
  })

  it("strips the priority to recover the name", () => {
    expect(stripPriority("authenticate.1.ts")).toBe("authenticate")
    expect(stripPriority("audit.1.2.ts")).toBe("audit")
    expect(stripPriority("authorize.ts")).toBe("authorize")
  })
})

describe("comparePriority", () => {
  const sort = (names: string[]) =>
    names
      .map((name) => ({ name: stripPriority(name), priority: parsePriority(name) }))
      .sort(comparePriority)
      .map((m) => m.name)

  it("runs lower numbers first and unnumbered last", () => {
    expect(sort(["zebra.ts", "authorize.ts", "authenticate.1.ts", "cors.0.ts"])).toEqual([
      "cors",
      "authenticate",
      "authorize",
      "zebra",
    ])
  })

  it("slots sub-priorities between whole numbers", () => {
    expect(sort(["b.2.ts", "a.1.ts", "between.1.2.ts"])).toEqual([
      "a",
      "between",
      "b",
    ])
  })
})

describe("deriveContextKey", () => {
  it("uses the filename", () => {
    expect(deriveContextKey("auth.ts")).toBe("auth")
    expect(deriveContextKey("user.ts")).toBe("user")
  })

  it("camelCases nested paths", () => {
    expect(deriveContextKey("db/pool.ts")).toBe("dbPool")
  })

  it("collapses index files to their directory", () => {
    expect(deriveContextKey("mailer/index.ts")).toBe("mailer")
  })
})
