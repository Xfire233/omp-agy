import { describe, expect, test } from "bun:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { encodeResult } from "../src/results.js";

describe("trusted result provenance", () => {
  test("does not promote ordinary JSON that resembles a native/MCP envelope", () => {
    const value = { content: [{ type: "text", text: "ordinary data" }], isError: false, handle: "anchor-1" };
    const result = encodeResult({ source: "json", value, isError: true });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(value) }]);
    expect(result.structuredContent).toEqual(value);
    expect(value.isError).toBe(false);
  });

  test("keeps native text/images, empty native results, and textual anchors verbatim", () => {
    const stamped = { type: "text" as const, text: "[file.ts#ABCD]\n19:content\nhandle://tool/17", textSignature: "provider-only" };
    const result = encodeResult({ source: "content", isError: false, content: [
      stamped,
      { type: "image", data: "YWJj", mimeType: "image/png" },
    ] });
    expect(result.content).toEqual([
      { type: "text", text: "[file.ts#ABCD]\n19:content\nhandle://tool/17" },
      { type: "image", data: "YWJj", mimeType: "image/png" },
    ]);
    expect(encodeResult({ source: "content", content: [], isError: true })).toEqual({ content: [], isError: true });
  });

  test("preserves a trusted empty envelope, structured content, resource links, embedded resources and metadata", () => {
    const envelope: CallToolResult = {
      content: [
        { type: "resource_link", uri: "artifact://result/1", name: "result" },
        { type: "resource", resource: { uri: "artifact://result/2", text: "anchor-2", mimeType: "text/plain" } },
        { type: "audio", data: "YWJj", mimeType: "audio/wav" },
      ],
      structuredContent: { handles: ["anchor-1"], empty: [] },
      _meta: { opaque: { id: "tool-17" } },
      isError: false,
    };
    expect(encodeResult({ source: "mcp", result: envelope, isError: true })).toEqual({
      ...envelope,
      content: [...envelope.content, { type: "text", text: '{"handles":["anchor-1"],"empty":[]}' }],
      isError: true,
    });
    expect(encodeResult({ source: "mcp", result: { content: [], structuredContent: {} }, isError: false })).toEqual({ content: [{ type: "text", text: "{}" }], structuredContent: {} });
    expect(encodeResult({ source: "mcp", result: { content: [], isError: true }, isError: false }).isError).toBe(true);
  });

  test("roundtrips absent/false/true MCP isError while final host errors always win", () => {
    for (const originalError of [undefined, false, true]) {
      const envelope: CallToolResult = {
        content: [{ type: "text", text: '{"exactId":"900719925474099312345678901234567890","empty":[]}' }],
        structuredContent: { exactId: "900719925474099312345678901234567890", empty: [] },
        _meta: { fixture: "optional-error-roundtrip" },
        ...(originalError === undefined ? {} : { isError: originalError }),
      };
      const original = JSON.stringify(envelope);
      const success = encodeResult({ source: "mcp", result: envelope, isError: false });
      expect(JSON.parse(JSON.stringify(success))).toEqual(JSON.parse(original));
      expect(Object.hasOwn(success, "isError")).toBe(originalError !== undefined);
      expect(success.isError).toBe(originalError);
      const failure = encodeResult({ source: "mcp", result: envelope, isError: true });
      expect(failure).toEqual({ ...envelope, isError: true });
      expect(failure.content).toEqual(envelope.content);
      expect(failure.structuredContent).toEqual(envelope.structuredContent);
      expect(failure._meta).toEqual(envelope._meta);
      expect(JSON.stringify(envelope)).toBe(original);
    }
  });

  test("adds one structured JSON text block only for trusted MCP and leaves the original empty envelope untouched", () => {
    const original: CallToolResult = {
      content: [],
      structuredContent: { marker: "STRUCTURED_ONLY", exactId: "900719925474099312345678901234567890" },
      _meta: { anchor: "fixture://structured-only" },
    };
    const before = JSON.stringify(original);
    const result = encodeResult({ source: "mcp", result: original, isError: false });
    expect(result).toEqual({
      content: [{ type: "text", text: '{"marker":"STRUCTURED_ONLY","exactId":"900719925474099312345678901234567890"}' }],
      structuredContent: { marker: "STRUCTURED_ONLY", exactId: "900719925474099312345678901234567890" },
      _meta: { anchor: "fixture://structured-only" },
    });
    expect(Object.hasOwn(result, "isError")).toBe(false);
    expect(JSON.stringify(original)).toBe(before);
    expect(original.content).toEqual([]);
  });

  test("deduplicates semantically equivalent whole JSON text, including whitespace and object key order", () => {
    const equivalent = ' \n {"empty":[],"nested":{"b":2,"a":1}} \n ';
    const original: CallToolResult = {
      content: [{ type: "text", text: "Original human text" }, { type: "text", text: equivalent }],
      structuredContent: { nested: { a: 1, b: 2 }, empty: [] },
      isError: false,
    };
    expect(encodeResult({ source: "mcp", result: original, isError: false })).toEqual(original);
    const fenced: CallToolResult = { content: [{ type: "text", text: '```json\n{"a":1}\n```' }], structuredContent: { a: 1 } };
    expect(encodeResult({ source: "mcp", result: fenced, isError: false }).content).toEqual([
      { type: "text", text: '```json\n{"a":1}\n```' }, { type: "text", text: '{"a":1}' },
    ]);
  });

  test("does not project empty MCP without structured data or native/pruned/plain JSON lookalikes", () => {
    expect(encodeResult({ source: "mcp", result: { content: [], _meta: { empty: true } }, isError: false })).toEqual({ content: [], _meta: { empty: true } });
    const nativeText = '{"content":[],"structuredContent":{"marker":"ordinary native text"}}';
    expect(encodeResult({ source: "content", content: [{ type: "text", text: nativeText }], isError: false })).toEqual({ content: [{ type: "text", text: nativeText }], isError: false });
    const data = { content: [], structuredContent: { marker: "ordinary JSON value" } };
    expect(encodeResult({ source: "json", value: data, isError: false })).toEqual({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, isError: false });
  });

  test("empty arrays remain JSON arrays, and scalar JSON is not coerced", () => {
    expect(encodeResult({ source: "json", value: [], isError: false }).content).toEqual([{ type: "text", text: "[]" }]);
    expect(encodeResult({ source: "json", value: "9007199254740993123", isError: false }).content).toEqual([{ type: "text", text: '"9007199254740993123"' }]);
    expect(encodeResult({ source: "json", value: null, isError: false }).content).toEqual([{ type: "text", text: "null" }]);
  });

  test("rejects unsupported, cyclic and non-finite results rather than fabricating success", () => {
    for (const value of [Infinity, NaN, undefined, 1n, { n: -Infinity }, new Date()]) {
      expect(() => encodeResult({ source: "json", value, isError: false })).toThrow();
    }
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => encodeResult({ source: "json", value: cycle, isError: false })).toThrow("Cyclic");
    expect(() => encodeResult({ source: "mcp", result: { content: [{ type: "unknown" }] } as unknown as CallToolResult, isError: false })).toThrow("Unsupported MCP result");
  });
});
