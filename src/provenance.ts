import type { ImageContent, TextContent, ToolResultMessage } from '@oh-my-pi/pi-ai';
import type { SourceInfo } from '@oh-my-pi/pi-coding-agent';
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrustedResult } from './results.ts';

/** Version-pinned comparison with OMP 18.13.1 mcp/tool-bridge.buildResult.
 * This is only a guard against reviving raw data that a host hook/pruner replaced;
 * outgoing MCP data comes from the trusted raw envelope, never this rendering.
 */
function hostProjection(result: CallToolResult): (TextContent | ImageContent)[] {
  const blocks: (TextContent | ImageContent)[] = [];
  let text = '';
  const flush = () => { if (text) blocks.push({ type: 'text', text }); text = ''; };
  const append = (value: string) => { text += text ? `\n\n${value}` : value; };
  for (const block of result.content) {
    if (block.type === 'text') append(block.text);
    else if (block.type === 'image') { flush(); blocks.push({ type: 'image', data: block.data, mimeType: block.mimeType }); }
    else if (block.type === 'resource') {
      const resource = block.resource;
      append('text' in resource && resource.text ? `[Resource: ${resource.uri}]\n${resource.text}` : `[Resource: ${resource.uri}]`);
    }
  }
  flush();
  if (!blocks.length) blocks.push({ type: 'text', text: '' });
  if (result.isError) {
    if (blocks[0]?.type === 'text') blocks[0] = { type: 'text', text: `Error: ${blocks[0].text}` };
    else blocks.unshift({ type: 'text', text: 'Error:' });
  }
  if (result.structuredContent !== undefined) {
    const alreadyRendered = result.content.some(block => {
      if (block.type !== 'text' || !block.text.trim()) return false;
      try { return Bun.deepEquals(JSON.parse(block.text), result.structuredContent); } catch { return false; }
    });
    if (!alreadyRendered) blocks.push({ type: 'text', text: `\`\`\`json\n${JSON.stringify(result.structuredContent, null, 2)}\n\`\`\`` });
  }
  return blocks;
}

/** Source classification comes from the host registry, never from result shape.
 * Filesystem extension origins are excluded even if named with an MCP prefix.
 */
export function encodeHostToolResult(result: ToolResultMessage, source: SourceInfo | undefined): TrustedResult {
  const native: TrustedResult = { source: 'content', content: result.content, isError: result.isError };
  if (source?.source !== 'mcp' || source.path !== `<mcp:${result.toolName}>`) return native;
  const details = result.details;
  if (details === null || typeof details !== 'object' || Array.isArray(details)) return native;
  const record = details as Record<string, unknown>;
  // Transport errors and host denials legitimately have no original MCP envelope.
  if (!Object.hasOwn(record, 'rawContent')) return native;
  if (typeof record.serverName !== 'string' || typeof record.mcpToolName !== 'string') throw new Error('Trusted host MCP result lost its origin identity');
  const parsed = CallToolResultSchema.safeParse({
    content: record.rawContent,
    ...(record.structuredContent !== undefined ? { structuredContent: record.structuredContent } : {}),
    ...(record.mcpMeta !== undefined ? { _meta: record.mcpMeta } : {}),
    ...(record.isError !== undefined ? { isError: record.isError } : {}),
  });
  if (!parsed.success) throw new Error('Trusted host MCP result is outside the supported result schema; effects may already exist');
  const visible = result.content.map(block => block.type === 'text'
    ? { type: 'text', text: block.text }
    : { type: 'image', data: block.data, mimeType: block.mimeType });
  // The final host result is authoritative. Hooks/spill/pruning may replace content
  // while retaining old details; never bypass that transformation with the old raw data.
  if (result.prunedAt !== undefined || !Bun.deepEquals(visible, hostProjection(parsed.data))) return native;
  return { source: 'mcp', result: parsed.data, isError: result.isError };
}
