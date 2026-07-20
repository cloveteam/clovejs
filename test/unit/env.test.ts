import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadEnv, parseEnv } from "../../src/env.js"

describe("parseEnv", () => {
  it("reads plain assignments", () => {
    expect(parseEnv("A=1\nB=two\n")).toEqual({ A: "1", B: "two" })
  })

  it("ignores blank lines and comments", () => {
    expect(parseEnv("# note\n\nA=1 # trailing\n")).toEqual({ A: "1" })
  })

  it("keeps a # inside a quoted value", () => {
    expect(parseEnv('A="a#b"\n')).toEqual({ A: "a#b" })
  })

  it("accepts the export prefix and a colon separator", () => {
    expect(parseEnv("export A=1\nB: 2\n")).toEqual({ A: "1", B: "2" })
  })

  it("trims unquoted values but preserves quoted whitespace", () => {
    expect(parseEnv('A=  spaced  \nB="  padded  "\n')).toEqual({
      A: "spaced",
      B: "  padded  ",
    })
  })

  it("expands escapes only inside double quotes", () => {
    expect(parseEnv('A="a\\nb"\nB=\'a\\nb\'\n')).toEqual({ A: "a\nb", B: "a\\nb" })
  })

  it("reads a double-quoted value spanning multiple lines", () => {
    expect(parseEnv('KEY="line1\nline2"\nNEXT=ok\n')).toEqual({
      KEY: "line1\nline2",
      NEXT: "ok",
    })
  })

  it("strips CR from a CRLF file", () => {
    expect(parseEnv("A=1\r\nB=2\r\n")).toEqual({ A: "1", B: "2" })
  })

  it("treats an empty value as an empty string", () => {
    expect(parseEnv("A=\n")).toEqual({ A: "" })
  })
})

describe("loadEnv", () => {
  let dir: string
  let saved: NodeJS.ProcessEnv

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "clove-env-"))
    saved = { ...process.env }
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    process.env = saved
  })

  const write = (name: string, body: string) => writeFileSync(join(dir, name), body)

  it("returns nothing when there is no .env file", () => {
    expect(loadEnv({ rootDir: dir, mode: "" })).toEqual([])
  })

  it("applies values from .env", () => {
    write(".env", "CLOVE_TEST_A=from-file\n")
    expect(loadEnv({ rootDir: dir, mode: "" })).toEqual(["CLOVE_TEST_A"])
    expect(process.env.CLOVE_TEST_A).toBe("from-file")
  })

  it("never overrides a variable already in the environment", () => {
    process.env.CLOVE_TEST_B = "from-shell"
    write(".env", "CLOVE_TEST_B=from-file\n")
    expect(loadEnv({ rootDir: dir, mode: "" })).toEqual([])
    expect(process.env.CLOVE_TEST_B).toBe("from-shell")
  })

  it("prefers the mode-specific file over the plain one", () => {
    write(".env", "CLOVE_TEST_C=base\n")
    write(".env.production", "CLOVE_TEST_C=prod\n")
    loadEnv({ rootDir: dir, mode: "production" })
    expect(process.env.CLOVE_TEST_C).toBe("prod")
  })

  it("prefers .env.local over .env", () => {
    write(".env", "CLOVE_TEST_D=base\n")
    write(".env.local", "CLOVE_TEST_D=local\n")
    loadEnv({ rootDir: dir, mode: "" })
    expect(process.env.CLOVE_TEST_D).toBe("local")
  })

  it("skips .local files in test mode so runs are reproducible", () => {
    write(".env", "CLOVE_TEST_E=base\n")
    write(".env.local", "CLOVE_TEST_E=local\n")
    loadEnv({ rootDir: dir, mode: "test" })
    expect(process.env.CLOVE_TEST_E).toBe("base")
  })

  it("merges keys across files instead of stopping at the first hit", () => {
    write(".env", "CLOVE_TEST_F=base\nCLOVE_TEST_G=base\n")
    write(".env.local", "CLOVE_TEST_F=local\n")
    loadEnv({ rootDir: dir, mode: "" })
    expect(process.env.CLOVE_TEST_F).toBe("local")
    expect(process.env.CLOVE_TEST_G).toBe("base")
  })

  it("loads an explicit file list instead of the cascade", () => {
    write(".env", "CLOVE_TEST_H=cascade\n")
    write("custom.env", "CLOVE_TEST_H=custom\n")
    loadEnv({ rootDir: dir, files: ["custom.env"] })
    expect(process.env.CLOVE_TEST_H).toBe("custom")
  })
})
