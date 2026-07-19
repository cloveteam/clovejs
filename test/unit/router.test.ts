import { describe, expect, it } from "vitest"
import { RouterTrie } from "../../src/router/trie.js"
import { CloveBootError } from "../../src/errors.js"
import type { HttpMethod, Route } from "../../src/types.js"

function route(method: HttpMethod | "ALL", path: string, file = `${path}.ts`): Route {
  return { method, path, file, handler: () => undefined, meta: {} }
}

describe("RouterTrie", () => {
  it("matches static paths", () => {
    const trie = new RouterTrie()
    trie.add(route("GET", "/api/v1/users"))
    expect(trie.match("GET", "/api/v1/users")?.route.path).toBe("/api/v1/users")
    expect(trie.match("GET", "/api/v1/other")).toBeNull()
  })

  it("extracts route parameters", () => {
    const trie = new RouterTrie()
    trie.add(route("GET", "/api/v1/users/[id]"))
    const match = trie.match("GET", "/api/v1/users/42")
    expect(match?.params).toEqual({ id: "42" })
  })

  it("extracts multiple parameters", () => {
    const trie = new RouterTrie()
    trie.add(route("GET", "/api/v1/users/[userId]/books/[bookId]"))
    const match = trie.match("GET", "/api/v1/users/7/books/9")
    expect(match?.params).toEqual({ userId: "7", bookId: "9" })
  })

  it("prefers a static segment over a parameter", () => {
    const trie = new RouterTrie()
    trie.add(route("GET", "/users/[id]", "users/[id].get.ts"))
    trie.add(route("GET", "/users/me", "users/me.get.ts"))
    expect(trie.match("GET", "/users/me")?.route.file).toBe("users/me.get.ts")
    expect(trie.match("GET", "/users/123")?.route.file).toBe("users/[id].get.ts")
  })

  it("backtracks to the parameter branch when the static branch dead-ends", () => {
    const trie = new RouterTrie()
    trie.add(route("GET", "/users/me", "me.ts"))
    trie.add(route("GET", "/users/[id]/books", "books.ts"))
    // "me" matches the static branch first, which has no /books child.
    const match = trie.match("GET", "/users/me/books")
    expect(match?.route.file).toBe("books.ts")
    expect(match?.params).toEqual({ id: "me" })
  })

  it("separates methods at the same path", () => {
    const trie = new RouterTrie()
    trie.add(route("GET", "/users"))
    trie.add(route("POST", "/users"))
    expect(trie.match("GET", "/users")?.route.method).toBe("GET")
    expect(trie.match("POST", "/users")?.route.method).toBe("POST")
    expect(trie.match("DELETE", "/users")).toBeNull()
  })

  it("falls back to an ALL route", () => {
    const trie = new RouterTrie()
    trie.add(route("ALL", "/any"))
    expect(trie.match("GET", "/any")?.route.method).toBe("ALL")
    expect(trie.match("PATCH", "/any")?.route.method).toBe("ALL")
  })

  it("prefers an exact method over ALL", () => {
    const trie = new RouterTrie()
    trie.add(route("ALL", "/thing", "all.ts"))
    trie.add(route("GET", "/thing", "get.ts"))
    expect(trie.match("GET", "/thing")?.route.file).toBe("get.ts")
    expect(trie.match("POST", "/thing")?.route.file).toBe("all.ts")
  })

  it("decodes percent-encoded parameters", () => {
    const trie = new RouterTrie()
    trie.add(route("GET", "/files/[name]"))
    expect(trie.match("GET", "/files/a%20b")?.params).toEqual({ name: "a b" })
  })

  it("treats trailing slashes as equivalent", () => {
    const trie = new RouterTrie()
    trie.add(route("GET", "/users"))
    expect(trie.match("GET", "/users/")).not.toBeNull()
  })

  it("rejects duplicate routes and names both files", () => {
    const trie = new RouterTrie()
    trie.add(route("GET", "/users", "api/users.get.ts"))
    expect(() => trie.add(route("GET", "/users", "api/users/get.ts"))).toThrow(
      CloveBootError,
    )
    try {
      trie.add(route("GET", "/users", "api/users/get.ts"))
    } catch (err) {
      expect((err as Error).message).toContain("api/users.get.ts")
      expect((err as Error).message).toContain("api/users/get.ts")
    }
  })

  it("rejects mismatched parameter names at the same position", () => {
    const trie = new RouterTrie()
    trie.add(route("GET", "/users/[id]", "a.ts"))
    expect(() => trie.add(route("GET", "/users/[userId]/books", "b.ts"))).toThrow(
      /parameter name conflict/i,
    )
  })

  it("reports whether a path exists under any method", () => {
    const trie = new RouterTrie()
    trie.add(route("GET", "/users"))
    expect(trie.hasPath("/users")).toBe(true)
    expect(trie.hasPath("/nope")).toBe(false)
  })

  it("lists registered routes", () => {
    const trie = new RouterTrie()
    trie.add(route("GET", "/b"))
    trie.add(route("GET", "/a"))
    expect(trie.list().map((r) => r.path)).toEqual(["/a", "/b"])
  })
})
