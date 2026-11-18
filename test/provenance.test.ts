import { expect, test } from 'bun:test';
import type { ToolResultMessage } from '@oh-my-pi/pi-ai';
import type { SourceInfo } from '@oh-my-pi/pi-coding-agent';
import { encodeHostToolResult } from '../src/provenance.ts';
import { encodeResult } from '../src/results.ts';

const source: SourceInfo = { source: 'mcp', path: '<mcp:mcp__fixture_value>', scope: 'temporary', origin: 'top-level' };
const result = (content: ToolResultMessage['content'], details: unknown, isError = false): ToolResultMessage => ({
  role: 'toolResult', toolCallId: 'fixture', toolName: 'mcp__fixture_value', content, details, isError, timestamp: 1,
});
const details = (rawContent: unknown[], extra: Record<string, unknown> = {}) => ({ serverName: 'fixture', mcpToolName: 'value', rawContent, ...extra });

test('trusted empty MCP content receives only the authorized structured JSON text mirror', () => {
  const message = result([{ type: 'text', text: '' }, { type: 'text', text: '```json\n{\n  "id": "9007199254740993"\n}\n```' }],
    details([], { structuredContent: { id: '9007199254740993' }, mcpMeta: { handle: 'reference-only' } }));
  expect(encodeResult(encodeHostToolResult(message, source))).toEqual({ content: [{ type: 'text', text: '{"id":"9007199254740993"}' }], structuredContent: { id: '9007199254740993' }, _meta: { handle: 'reference-only' } });
});

test('ordinary or extension-shaped details cannot become an MCP envelope', () => {
  const message = result([{ type: 'text', text: '' }], details([]));
  for (const origin of [undefined, { ...source, source: 'extension' }, { ...source, path: 'extension.ts' }]) {
    expect(encodeResult(encodeHostToolResult(message, origin)).content).toEqual([{ type: 'text', text: '' }]);
  }
});

test('host hook replacement and pruning win over retained raw MCP details', () => {
  const message = result([{ type: 'text', text: 'HOST_DENIED' }], details([{ type: 'text', text: 'sensitive original' }], { structuredContent: { secret: 'retained original details' } }), true);
  expect(encodeResult(encodeHostToolResult(message, source))).toEqual({ content: [{ type: 'text', text: 'HOST_DENIED' }], isError: true });
  const pruned = result([{ type: 'text', text: '' }], details([], { structuredContent: { secret: 'retained pruned details' } }));
  pruned.prunedAt = 2;
  expect(encodeHostToolResult(pruned, source).source).toBe('content');
  expect(encodeResult(encodeHostToolResult(pruned, source))).toEqual({ content: [{ type: 'text', text: '' }], isError: false });
});

test('trusted embedded resources and host errors retain their distinct semantics', () => {
  const resource = { type: 'resource' as const, resource: { uri: 'fixture://asset', mimeType: 'text/plain', text: 'resource payload' } };
  const message = result([{ type: 'text', text: '[Resource: fixture://asset]\nresource payload' }], details([resource], { isError: false }), true);
  const encoded = encodeResult(encodeHostToolResult(message, source));
  expect(encoded.content).toEqual([resource]);
  expect(encoded.isError).toBe(true);
});

test('unsupported trusted payload fails explicitly instead of hiding prior effects', () => {
  const message = result([], details([{ type: 'unknown-future-block' }]));
  expect(() => encodeHostToolResult(message, source)).toThrow('outside the supported result schema');
});
