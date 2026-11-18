import type { ToolResultContent } from "./protocol.ts";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { assertJsonValue } from "./catalog.js";

/** Callers explicitly choose plain text/images, ordinary JSON, or a trusted MCP envelope. */
export type TrustedResult =
  | { source: "content"; content: readonly ToolResultContent[]; isError: boolean }
  | { source: "mcp"; result: CallToolResult; isError: boolean }
  | { source: "json"; value: unknown; isError: boolean };

/** Provenance is explicit: ordinary JSON can never masquerade as an MCP envelope. */
export function encodeResult(input: TrustedResult): CallToolResult {
  let result: CallToolResult;
  switch (input.source) {
    case "content":
      result = {
        content: input.content.map(block => {
          switch (block.type) {
            case "text": return { type: "text" as const, text: block.text };
            case "image": return { type: "image" as const, data: block.data, mimeType: block.mimeType };
            default: throw new Error("Unsupported tool result content block; executed effects are not undone");
          }
        }),
        isError: input.isError,
      };
      break;
    case "mcp": {
      let content = input.result.content;
      const structured = input.result.structuredContent;
      if (structured !== undefined) {
        const alreadyRendered = input.result.content.some(block => {
          if (block.type !== "text") return false;
          try { return Bun.deepEquals(JSON.parse(block.text), structured); }
          catch { return false; }
        });
        // Explicitly approved AGY compatibility projection: preserve every original
        // block and structured field, adding one plain JSON text block only if absent.
        if (!alreadyRendered) content = [...content, { type: "text", text: JSON.stringify(structured) }];
      }
      // Make at most one envelope copy; only that copy can receive a host-error override.
      const errorOverride = input.isError && input.result.isError !== true;
      result = content !== input.result.content || errorOverride ? { ...input.result, content } : input.result;
      if (errorOverride) result.isError = true;
      break;
    }
    case "json":
      assertJsonValue(input.value);
      result = {
        content: [{ type: "text", text: JSON.stringify(input.value) }],
        ...(input.value !== null && typeof input.value === "object" && !Array.isArray(input.value)
          ? { structuredContent: input.value as Record<string, unknown> } : {}),
        isError: input.isError,
      };
      break;
    default:
      throw new Error("Missing trusted result provenance");
  }
  assertJsonValue(result);
  const checked = CallToolResultSchema.safeParse(result);
  if (!checked.success) throw new Error(`Unsupported MCP result: ${checked.error.message}; executed effects are not undone`);
  return checked.data;
}
