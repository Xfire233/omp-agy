import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge } from '../src/bridge.ts';

// Exercises the real HTTP/SDK boundary, not AGY or OMP. Host/CLI acceptance is separate.
const dir = await mkdtemp(join(tmpdir(), 'omp-agy-bridge-'));
const fatal: string[] = [];
let wake: (() => void) | undefined;
let epoch = 0;
const bridge = await createBridge({
  hostname: '127.0.0.1', sourceAddress: '127.0.0.1',
  tools: [{ name: 'read', description: 'Read an acceptance fixture', parameters: {
    type: 'object', properties: { index: { type: 'integer', minimum: 0, maximum: 44 } }, required: ['index'], additionalProperties: false,
  } }],
  onActivity() { epoch++; wake?.(); }, onFatal(error) { fatal.push(error.message); wake?.(); },
});
const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
const post = (body: unknown, extra: Record<string, string> = {}) => fetch(bridge.url, {
  method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
});
const client = new Client({ name: 'omp-agy-acceptance-sdk', version: '0.1.0' });
const transport = new StreamableHTTPClientTransport(new URL(bridge.url), {
  requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } },
  reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 0, initialReconnectionDelay: 0, reconnectionDelayGrowFactor: 1 },
});
const report: Record<string, unknown> = { surface: 'real Bun HTTP + MCP SDK, synthetic host consumer; NOT AGY/OMP acceptance', scenarios: [] };
try {
  const discovery = await fetch(new URL('/.well-known/oauth-protected-resource', bridge.url));
  assert.equal(discovery.status, 404);
  assert.equal(await discovery.text(), '');
  for (const auth of [undefined, 'Bearer incorrect', `Bearer ${bridge.token}`]) {
    const response = await post({ jsonrpc: '2.0', id: 'probe', method: 'server/discover' }, auth ? { Authorization: auth } : {});
    const body = await response.json() as { id: string; error: { code: number } };
    assert.equal(body.id, 'probe'); assert.equal(body.error.code, -32601);
    assert.equal(bridge.pendingCount, 0);
  }
  const unauth = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(unauth.status, 401);
  const badOrigin = await post({ jsonrpc: '2.0', id: 2, method: 'server/discover' }, { Origin: 'https://unexpected.invalid' });
  assert.equal(badOrigin.status, 403);
  await client.connect(transport);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(t => t.name), ['read']);
  await writeFile(join(dir, 'fixture.txt'), 'REAL_WINDOWS_FILE_CONTENT');

  for (const headDelayMs of [0, 1500]) {
    bridge.beginTurn();
    const start = performance.now();
    let peakPending = 0;
    const arrivals: Array<{ index: number; elapsedMs: number }> = [];
    const promises = Array.from({ length: 45 }, (_, index) => client.callTool({ name: 'read', arguments: { index } }, undefined, { timeout: 15000 }).then(result => {
      assert.deepEqual(result.content, [{ type: 'text', text: `${index}:REAL_WINDOWS_FILE_CONTENT` }]);
      arrivals.push({ index, elapsedMs: performance.now() - start });
      return result;
    }));
    // Attach failure handlers immediately while the host consumer drains requests.
    const results = Promise.all(promises); void results.catch(() => {});
    const readyDeadline = performance.now() + 5000;
    while (bridge.pendingCount !== 45 && performance.now() < readyDeadline) await Bun.sleep(5);
    assert.equal(bridge.pendingCount, 45, 'all 45 client calls must be pending before dispatch');
    peakPending = bridge.pendingCount;
    let dispatches = 0;
    const seen = new Set<number>();
    while (dispatches < 45) {
      const observed = epoch;
      const call = bridge.takeNext();
      if (!call) {
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        const timeout = setTimeout(() => { wake = undefined; reject(new Error('pending dispatch stalled')); }, 5000);
        wake = () => { clearTimeout(timeout); wake = undefined; resolve(); };
        if (epoch !== observed) wake();
        await promise;
        continue;
      }
      assert.equal(bridge.takeNext(), undefined, 'only one host dispatch may be outstanding');
      const index = call.arguments.index as number;
      assert(!seen.has(index)); seen.add(index);
      if (dispatches === 0 && headDelayMs) await Bun.sleep(headDelayMs);
      const text = await readFile(join(dir, 'fixture.txt'), 'utf8');
      await bridge.complete(call.id, { source: 'content', content: [{ type: 'text', text: `${index}:${text}` }], isError: false });
      dispatches++;
    }
    await results;
    bridge.endTurn();
    assert.equal(bridge.pendingCount, 0); assert.equal(seen.size, 45);
    assert.deepEqual(fatal, []);
    (report.scenarios as unknown[]).push({ kind: headDelayMs ? '45-read-delayed-first-host-result' : '45-read', headDelayMs, dispatches, peakPending, totalMs: performance.now() - start, arrivals });
  }
  report.authentication = 'discovery +/-auth, actual request auth and Origin gates observed';
  report.result = 'passed';
} finally {
  await bridge.revoke(new Error('acceptance complete'));
  await client.close();
  await rm(dir, { recursive: true, force: true });
}
console.log(JSON.stringify(report, null, 2));
