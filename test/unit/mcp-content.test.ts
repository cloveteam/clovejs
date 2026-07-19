import { describe, expect, it } from "vitest"
import {
  errorText,
  isRecoverable,
  toPromptMessages,
  toResourceContents,
  toToolContent,
} from "../../src/mcp/content.js"
import { error } from "../../src/errors.js"

describe("toToolContent", () => {
  it("wraps a string in a text block", () => {
    expect(toToolContent("hello")).toEqual([{ type: "text", text: "hello" }])
  })

  it("serialises objects and arrays as JSON, like the JSON middleware", () => {
    expect(toToolContent({ a: 1 })).toEqual([{ type: "text", text: '{\n  "a": 1\n}' }])
  })

  it("returns nothing for undefined and null", () => {
    expect(toToolContent(undefined)).toEqual([])
    expect(toToolContent(null)).toEqual([])
  })

  it("passes explicit content blocks through untouched", () => {
    const block = { type: "text" as const, text: "raw" }
    expect(toToolContent(block)).toEqual([block])
    expect(toToolContent([block, block])).toEqual([block, block])
  })

  it("treats an array of plain objects as data, not content", () => {
    expect(toToolContent([{ id: 1 }])).toEqual([
      { type: "text", text: '[\n  {\n    "id": 1\n  }\n]' },
    ])
  })
})

describe("toResourceContents", () => {
  it("uses the declared mime type for text", () => {
    expect(toResourceContents("# Title", "notes://1", "text/markdown")).toEqual([
      { uri: "notes://1", mimeType: "text/markdown", text: "# Title" },
    ])
  })

  it("defaults objects to application/json", () => {
    const [entry] = toResourceContents({ a: 1 }, "config://app", null)
    expect(entry).toMatchObject({ uri: "config://app", mimeType: "application/json" })
  })

  it("base64-encodes binary payloads as blobs", () => {
    const [entry] = toResourceContents(Buffer.from("hi"), "files://a", "image/png")
    expect(entry).toEqual({
      uri: "files://a",
      mimeType: "image/png",
      blob: Buffer.from("hi").toString("base64"),
    })
  })

  it("accepts a Uint8Array", () => {
    const [entry] = toResourceContents(new Uint8Array([104, 105]), "files://a", null)
    expect(entry?.blob).toBe(Buffer.from("hi").toString("base64"))
  })
})

describe("toPromptMessages", () => {
  it("treats a bare string as a user message", () => {
    expect(toPromptMessages("Summarize this")).toEqual([
      { role: "user", content: { type: "text", text: "Summarize this" } },
    ])
  })

  it("keeps explicit roles", () => {
    expect(toPromptMessages([{ role: "assistant", content: "Sure" }])).toEqual([
      { role: "assistant", content: { type: "text", text: "Sure" } },
    ])
  })

  it("fans a multi-block message out into one message per block", () => {
    const messages = toPromptMessages({
      role: "user",
      content: [
        { type: "text", text: "one" },
        { type: "text", text: "two" },
      ],
    })
    expect(messages).toEqual([
      { role: "user", content: { type: "text", text: "one" } },
      { role: "user", content: { type: "text", text: "two" } },
    ])
  })
})

describe("error classification", () => {
  it("treats 4xx as recoverable, so the model can correct itself", () => {
    expect(isRecoverable(error(404, { message: "gone" }))).toBe(true)
    expect(isRecoverable(error(400))).toBe(true)
  })

  it("treats 5xx and plain errors as protocol failures", () => {
    expect(isRecoverable(error(500))).toBe(false)
    expect(isRecoverable(new Error("boom"))).toBe(false)
  })

  it("reads the message out of an error body", () => {
    expect(errorText(error(404, { message: "No such note" }))).toBe("No such note")
    expect(errorText(error(400, "plain string"))).toBe("plain string")
    expect(errorText(new Error("boom"))).toBe("boom")
  })
})
