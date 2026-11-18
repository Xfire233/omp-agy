import { afterEach, describe, expect, spyOn, test, vi } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { LATEST_PROTOCOL_VERSION, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createBridge, type Bridge, type BridgeLimits } from "../src/bridge.js";
import type { ToolDefinition } from "../src/catalog.js";

const bridges = new Set<Bridge>();
const clients = new Set<Client>();
afterEach(async () => {
  await Promise.all([...bridges].map(bridge => bridge.revoke(new Error("Test disposal"))));
  await Promise.all([...clients].map(client => client.close()));
  vi.useRealTimers();
  bridges.clear();
  clients.clear();
});

const tools: ToolDefinition[] = [{
  name: "read", description: "Native OMP read identity",
  parameters: { type: "object", properties: { index: { type: "integer" } }, required: ["index"], additionalProperties: false },
}];

async function fixture(limits?: BridgeLimits, advertisedTools = tools) {
  const failures: Error[] = [];
  const watchers = new Set<() => void>();
  let activityCount = 0;
  const wake = () => { for (const watcher of [...watchers]) watcher(); };
  const bridge = await createBridge({
    hostname: "127.0.0.1", sourceAddress: "127.0.0.1", tools: advertisedTools, limits,
    onActivity() { activityCount++; wake(); },
    onFatal(error) { failures.push(error); wake(); },
  });
  bridges.add(bridge);
  async function wait(predicate: () => boolean) {
    if (predicate()) return;
    const deferred = Promise.withResolvers<void>();
    // A failure deadline only: success awaits actual HTTP/bridge activity, never a guessed sleep.
    const timer = setTimeout(() => deferred.reject(new Error("Bridge activity condition timed out")), 5_000);
    const check = () => { if (predicate()) deferred.resolve(); };
    watchers.add(check);
    check();
    try { await deferred.promise; }
    finally { clearTimeout(timer); watchers.delete(check); }
  }
  async function connect() {
    const client = new Client({ name: "omp-agy-behavior-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(bridge.url), {
      requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } },
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1, maxReconnectionDelay: 1, reconnectionDelayGrowFactor: 1 },
    });
    clients.add(client);
    await client.connect(transport);
    return { client, transport };
  }
  return { bridge, failures, wait, connect, get activityCount() { return activityCount; } };
}

async function rawRpc(bridge: Bridge, message: unknown, options: {
  authorization?: string | null; session?: string; headers?: Record<string, string>; path?: string;
} = {}) {
  const url = new URL(bridge.url);
  if (options.path) url.pathname = options.path;
  return await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json", Accept: "application/json, text/event-stream",
      ...(options.authorization === null ? {} : { Authorization: options.authorization ?? `Bearer ${bridge.token}` }),
      ...(options.session ? { "Mcp-Session-Id": options.session, "Mcp-Protocol-Version": LATEST_PROTOCOL_VERSION } : {}),
      ...options.headers,
    },
    body: JSON.stringify(message),
  });
}

function request(id: string | number, method: string, params: Record<string, unknown> = {}) {
  return { jsonrpc: "2.0", id, method, params };
}

// Keep the real SDK response and send behavior, but retain HTTP ownership until
// the test releases handleRequest. Abort events reach the bridge's installed
// listener, not a copied callback; this imposes ordering, not network incidence.
function holdHttpToolRequest(rpcId: string) {
  const entered = Promise.withResolvers<AbortSignal>();
  const sent = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const originalHandle = WebStandardStreamableHTTPServerTransport.prototype.handleRequest;
  const originalSend = WebStandardStreamableHTTPServerTransport.prototype.send;
  const handle = spyOn(WebStandardStreamableHTTPServerTransport.prototype, "handleRequest").mockImplementation(async function (this: WebStandardStreamableHTTPServerTransport, request, options) {
    const body = options?.parsedBody as { id?: unknown; method?: unknown } | undefined;
    const held = body?.id === rpcId && body.method === "tools/call";
    if (held) entered.resolve(request.signal);
    const response = await originalHandle.call(this, request, options);
    if (held) await release.promise;
    return response;
  });
  const send = spyOn(WebStandardStreamableHTTPServerTransport.prototype, "send").mockImplementation(async function (this: WebStandardStreamableHTTPServerTransport, message, options) {
    await originalSend.call(this, message, options);
    if ("id" in message && message.id === rpcId && ("result" in message || "error" in message)) sent.resolve();
  });
  return {
    entered: entered.promise, sent: sent.promise, release: () => release.resolve(),
    restore() { release.resolve(); handle.mockRestore(); send.mockRestore(); },
  };
}

describe("SDK MCP discovery and authentication boundary", () => {
  test("only the exact preinitialize discovery probe is anonymous, preserves legal IDs, and leaves MCP state untouched", async () => {
    const f = await fixture();
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const url = new URL(f.bridge.url); url.pathname = path;
      const response = await fetch(url);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("");
      expect((await fetch(url, { method: "POST" })).status).toBe(405);
    }
    for (const id of [0, 17, "probe", ""]) {
      for (const authorization of [null, `Bearer ${f.bridge.token}`, "Bearer wrong"]) {
        const response = await rawRpc(f.bridge, request(id, "server/discover"), { authorization });
        expect(response.status).toBe(200);
        expect(response.headers.get("mcp-session-id")).toBeNull();
        expect(await response.json()).toEqual({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
      }
    }
    expect(f.bridge.pendingCount).toBe(0);
    expect(f.bridge.deliveredCount).toBe(0);
    expect(f.failures).toEqual([]);
    expect((await rawRpc(f.bridge, request(1, "server/discover-more"), { authorization: null })).status).toBe(401);
    expect((await rawRpc(f.bridge, request(2, "tools/list"), { authorization: null })).status).toBe(401);
    expect((await rawRpc(f.bridge, request(3, "initialize", { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" } }), { authorization: null })).status).toBe(401);
    const { client, transport } = await f.connect();
    expect((await client.listTools()).tools[0]!.name).toBe("read");
    expect((await rawRpc(f.bridge, request(4, "server/discover"), { authorization: null })).status).toBe(401);
    expect((await rawRpc(f.bridge, request(5, "tools/list"), { session: transport.sessionId, authorization: "Bearer wrong" })).status).toBe(401);
    expect((await client.listTools()).tools).toHaveLength(1);
    expect(f.failures).toEqual([]);
  });

  test("rejects wrong Host, Origin, path, method, media type and body without killing activation", async () => {
    const f = await fixture({ maxBodyBytes: 1024 });
    expect((await rawRpc(f.bridge, request("probe", "server/discover"), { authorization: null, headers: { Host: "evil.invalid" } })).status).toBe(403);
    expect((await rawRpc(f.bridge, request("probe", "server/discover"), { authorization: null, headers: { Origin: "http://evil.invalid" } })).status).toBe(403);
    expect((await rawRpc(f.bridge, request("probe", "server/discover"), { authorization: null, path: "/mcp/" })).status).toBe(404);
    expect((await rawRpc(f.bridge, request("probe", "server/discover"), { authorization: null, headers: { "Content-Type": "text/plain" } })).status).toBe(415);
    expect((await fetch(f.bridge.url, { method: "PUT" })).status).toBe(405);
    expect((await fetch(f.bridge.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "not-json" })).status).toBe(400);
    expect((await fetch(f.bridge.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: " ".repeat(1025) })).status).toBe(413);
    expect((await rawRpc(f.bridge, { jsonrpc: "2.0", id: 1, method: "server/discover", params: [] }, { authorization: null })).status).toBe(401);
    expect(f.failures).toEqual([]);
    const { client } = await f.connect();
    expect((await client.listTools()).tools).toHaveLength(1);
    expect(f.bridge.pendingCount).toBe(0);
  });

  test("enforces source address, specific interface binding, and fresh activation capabilities", async () => {
    await expect(createBridge({ hostname: "0.0.0.0", sourceAddress: "127.0.0.1", tools, onActivity() {}, onFatal() {} })).rejects.toThrow("specific interface");
    const restricted = await createBridge({ hostname: "127.0.0.1", sourceAddress: "127.0.0.2", tools, onActivity() {}, onFatal() {} });
    bridges.add(restricted);
    expect((await rawRpc(restricted, request("probe", "server/discover"), { authorization: null })).status).toBe(403);
    const first = await fixture();
    const second = await fixture();
    expect(first.bridge.token).not.toBe(second.bridge.token);
    expect((await rawRpc(second.bridge, request(1, "tools/list"), { authorization: `Bearer ${first.bridge.token}` })).status).toBe(401);
    await first.bridge.revoke(new Error("Capability removed"));
    expect(() => first.bridge.beginTurn()).toThrow("revoked");
    expect(first.bridge.takeNext()).toBeUndefined();
  });
});

describe("serial OMP pending handoff", () => {
  test("dispatches one received call, awaits SDK response delivery, then releases the next", async () => {
    const f = await fixture();
    const { client } = await f.connect();
    f.bridge.beginTurn();
    const firstResult = client.callTool({ name: "read", arguments: { index: 1 } });
    await f.wait(() => f.bridge.pendingCount === 1);
    const first = f.bridge.takeNext()!;
    expect(first.name).toBe("read");
    expect(first.arguments).toEqual({ index: 1 });
    expect(f.bridge.takeNext()).toBeUndefined();
    const secondResult = client.callTool({ name: "read", arguments: { index: 2 } });
    await f.wait(() => f.bridge.pendingCount === 2);
    expect(() => f.bridge.endTurn()).toThrow("MCP work");
    await expect(f.bridge.complete("wrong-id", { source: "content", content: [], isError: false })).rejects.toThrow("Unknown");
    expect(f.bridge.pendingCount).toBe(2);
    const completion = f.bridge.complete(first.id, { source: "content", content: [{ type: "text", text: "first" }], isError: false });
    expect(f.bridge.takeNext()).toBeUndefined();
    await completion;
    expect((await firstResult).content).toEqual([{ type: "text", text: "first" }]);
    const second = f.bridge.takeNext()!;
    expect(second.arguments).toEqual({ index: 2 });
    await expect(f.bridge.complete(first.id, { source: "content", content: [], isError: false })).rejects.toThrow("Unknown");
    expect(f.bridge.pendingCount).toBe(1);
    await f.bridge.complete(second.id, { source: "content", content: [], isError: true });
    expect((await secondResult).isError).toBe(true);
    expect(f.bridge.pendingCount).toBe(0);
    expect(f.bridge.deliveredCount).toBe(2);
    f.bridge.endTurn();
    f.bridge.beginTurn();
    f.bridge.endTurn();
    expect(f.failures).toEqual([]);
  });

  test("queues 45 concurrent reads behind a held first call without business batching or replay", async () => {
    const f = await fixture();
    const { client } = await f.connect();
    f.bridge.beginTurn();
    const results = Array.from({ length: 45 }, (_, index) => client.callTool({ name: "read", arguments: { index } }));
    await f.wait(() => f.bridge.pendingCount === 45);
    const seen = new Set<number>();
    const ids = new Set<string>();
    for (let remaining = 45; remaining > 0; remaining--) {
      expect(f.bridge.pendingCount).toBe(remaining);
      const call = f.bridge.takeNext()!;
      expect(call).toBeDefined();
      expect(f.bridge.takeNext()).toBeUndefined();
      seen.add(call.arguments.index as number);
      expect(ids.has(call.id)).toBe(false);
      ids.add(call.id);
      await f.bridge.complete(call.id, { source: "json", value: { index: call.arguments.index }, isError: false });
    }
    const returned = await Promise.all(results);
    returned.forEach((result, index) => expect(result.structuredContent).toEqual({ index }));
    expect(seen.size).toBe(45);
    expect(f.bridge.deliveredCount).toBe(45);
    f.bridge.endTurn();
    expect(f.failures).toEqual([]);
  });

  test("rejects queue overflow honestly while keeping all legitimate pending requests", async () => {
    const f = await fixture({ maxPending: 64 });
    const { client } = await f.connect();
    f.bridge.beginTurn();
    const results = Array.from({ length: 64 }, (_, index) => client.callTool({ name: "read", arguments: { index } }));
    await f.wait(() => f.bridge.pendingCount === 64);
    await expect(client.callTool({ name: "read", arguments: { index: 64 } })).rejects.toThrow("capacity exceeded");
    expect(f.bridge.pendingCount).toBe(64);
    for (let index = 0; index < 64; index++) {
      const call = f.bridge.takeNext()!;
      await f.bridge.complete(call.id, { source: "content", content: [], isError: false });
    }
    await Promise.all(results);
    expect(f.bridge.deliveredCount).toBe(64);
    expect(f.failures).toEqual([]);
    f.bridge.endTurn();
  });

  test("rejects numeric/schema violations before dispatch but keeps strings exact and legal requests usable", async () => {
    const f = await fixture();
    const { client } = await f.connect();
    f.bridge.beginTurn();
    await expect(client.callTool({ name: "read", arguments: { index: 9_007_199_254_740_992 } })).rejects.toThrow("Unsafe integer");
    await expect(client.callTool({ name: "read", arguments: { index: "12" } })).rejects.toThrow("Invalid arguments");
    await expect(client.callTool({ name: "missing", arguments: { index: 1 } })).rejects.toThrow("Unknown bridge tool");
    expect(f.bridge.pendingCount).toBe(0);
    const result = client.callTool({ name: "read", arguments: { index: 12 } });
    await f.wait(() => f.bridge.pendingCount === 1);
    const call = f.bridge.takeNext()!;
    await f.bridge.complete(call.id, { source: "content", content: [{ type: "image", data: "YWJj", mimeType: "image/png" }], isError: false });
    expect((await result).content).toEqual([{ type: "image", data: "YWJj", mimeType: "image/png" }]);
    f.bridge.endTurn();
    expect(f.failures).toEqual([]);
  });

  test("duplicate HTTP IDs cannot consume or overwrite a legitimate wait", async () => {
    const f = await fixture();
    const { client, transport } = await f.connect();
    f.bridge.beginTurn();
    const first = await rawRpc(f.bridge, request("same", "tools/call", { name: "read", arguments: { index: 0 } }), { session: transport.sessionId });
    const body = first.text();
    await f.wait(() => f.bridge.pendingCount === 1);
    for (let repeat = 0; repeat < 2; repeat++) {
      expect((await rawRpc(f.bridge, request("same", "tools/call", { name: "read", arguments: { index: 1 } }), { session: transport.sessionId })).status).toBe(409);
    }
    const call = f.bridge.takeNext()!;
    expect(call.arguments).toEqual({ index: 0 });
    await f.bridge.complete(call.id, { source: "content", content: [{ type: "text", text: "original" }], isError: false });
    expect(await body).toContain('"text":"original"');
    expect(f.bridge.deliveredCount).toBe(1);
    expect((await client.listTools()).tools).toHaveLength(1);
    f.bridge.endTurn();
    expect(f.failures).toEqual([]);
  });
});

describe("activation termination and finite bounds", () => {
  test("idle late requests invalidate reuse and cannot dispatch OMP work", async () => {
    const f = await fixture();
    const { client } = await f.connect();
    const result = client.callTool({ name: "read", arguments: { index: 1 } });
    const observed = result.catch(error => error);
    await f.wait(() => f.failures.length === 1);
    expect(f.failures[0]!.message).toContain("idle");
    expect(f.bridge.takeNext()).toBeUndefined();
    expect(() => f.bridge.beginTurn()).toThrow("revoked");
    await f.bridge.revoke(new Error("Already revoked"));
    await client.close();
    await observed;
  });

  test("finite pending lifetime cancels waits and forbids automatic replay", async () => {
    vi.useFakeTimers();
    const f = await fixture({ pendingLifetimeMs: 50 });
    const { client } = await f.connect();
    f.bridge.beginTurn();
    const observed = client.callTool({ name: "read", arguments: { index: 0 } }).catch(error => error);
    await f.wait(() => f.bridge.pendingCount === 1);
    const call = f.bridge.takeNext()!;
    vi.advanceTimersByTime(50);
    await f.wait(() => f.failures.length === 1);
    expect(f.failures[0]!.message).toContain("pending lifetime");
    expect(f.bridge.pendingCount).toBe(0);
    expect(f.bridge.takeNext()).toBeUndefined();
    await expect(f.bridge.complete(call.id, { source: "content", content: [], isError: false })).rejects.toThrow("Unknown");
    await client.close();
    await observed;
  });

  test("result encoding/size failure reports executed effects and revokes instead of inventing success", async () => {
    const f = await fixture({ maxResultBytes: 64 });
    const { client } = await f.connect();
    f.bridge.beginTurn();
    const observed = client.callTool({ name: "read", arguments: { index: 0 } }).catch(error => error);
    await f.wait(() => f.bridge.pendingCount === 1);
    const call = f.bridge.takeNext()!;
    await expect(f.bridge.complete(call.id, { source: "content", content: [{ type: "text", text: "x".repeat(65) }], isError: false })).rejects.toThrow("result size limit");
    expect(f.failures[0]!.message).toContain("after execution");
    expect(f.bridge.deliveredCount).toBe(0);
    await client.close();
    await observed;
  });

  test("revocation clears queued/dispatched capability but does not claim to cancel host effects", async () => {
    const f = await fixture();
    const { client } = await f.connect();
    f.bridge.beginTurn();
    const observed = client.callTool({ name: "read", arguments: { index: 1 } }).catch(error => error);
    await f.wait(() => f.bridge.pendingCount === 1);
    const call = f.bridge.takeNext()!;
    await f.bridge.revoke(new Error("Host cancelled; tool effects may already exist"));
    expect(f.bridge.pendingCount).toBe(0);
    expect(f.bridge.deliveredCount).toBe(0);
    expect(f.bridge.takeNext()).toBeUndefined();
    await expect(f.bridge.complete(call.id, { source: "content", content: [], isError: false })).rejects.toThrow("Unknown");
    await client.close();
    await observed;
  });
});

describe("HTTP resource and cancellation races", () => {
  test("bounds long-lived SSE connections while retaining the existing connection", async () => {
    const f = await fixture({ maxConnections: 1 });
    // Raw initialize has no automatically opened GET stream, unlike the SDK Client.
    const initialized = await rawRpc(f.bridge, request("init", "initialize", {
      protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "bounds", version: "1" },
    }));
    const session = initialized.headers.get("mcp-session-id")!;
    await initialized.text();
    const controller = new AbortController();
    const stream = await fetch(f.bridge.url, {
      headers: { Authorization: `Bearer ${f.bridge.token}`, Accept: "text/event-stream", "Mcp-Session-Id": session, "Mcp-Protocol-Version": LATEST_PROTOCOL_VERSION },
      signal: controller.signal,
    });
    expect(stream.status).toBe(200);
    expect((await rawRpc(f.bridge, request("overflow", "tools/list"), { session })).status).toBe(503);
    expect(f.failures).toEqual([]);
    controller.abort();
    await stream.body?.cancel().catch(() => {});
  });

  test("rejects non-finite decoded JSON without a preparse numeric lexer", async () => {
    const f = await fixture();
    const response = await fetch(f.bridge.url, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${f.bridge.token}` },
      body: '{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"n":1e400}}',
    });
    expect(response.status).toBe(400);
    expect(f.bridge.pendingCount).toBe(0);
    expect(f.failures).toEqual([]);
    const { client } = await f.connect();
    expect((await client.listTools()).tools).toHaveLength(1);
  });

  test("revocation during result handoff cannot turn a cancelled activation successful", async () => {
    const f = await fixture();
    const { client } = await f.connect();
    f.bridge.beginTurn();
    const observed = client.callTool({ name: "read", arguments: { index: 0 } }).catch(error => error);
    await f.wait(() => f.bridge.pendingCount === 1);
    const call = f.bridge.takeNext()!;
    const completion = f.bridge.complete(call.id, { source: "content", content: [{ type: "text", text: "actual effects" }], isError: false });
    const cancelled = completion.catch(error => error);
    await f.bridge.revoke(new Error("Turn cancelled during delivery; actual tool effects retained in OMP"));
    expect(await cancelled).toBeInstanceOf(Error);
    expect(f.bridge.deliveredCount).toBe(0);
    expect(f.bridge.takeNext()).toBeUndefined();
    await client.close();
    await observed;
  });

  test("real SDK send fulfilled before revoke cannot commit delivered bookkeeping afterward", async () => {
    const rpcId = "revoke-after-real-send";
    const reason = new Error("Host revoked after the real send fulfilled");
    const originalSend = WebStandardStreamableHTTPServerTransport.prototype.send;
    let actualSendFulfilled = false;
    let revokeAfterSend: () => void;
    const send = spyOn(WebStandardStreamableHTTPServerTransport.prototype, "send").mockImplementation(async function (this: WebStandardStreamableHTTPServerTransport, message, options) {
      await originalSend.call(this, message, options);
      if ("id" in message && message.id === rpcId && "result" in message) {
        actualSendFulfilled = true;
        // The host revoke runs before the bridge's await-send continuation,
        // without replacing, delaying, or fabricating the SDK send result.
        queueMicrotask(() => revokeAfterSend());
      }
    });
    try {
      const f = await fixture();
      const { transport } = await f.connect();
      let stopping: Promise<void> | undefined;
      let activityAfterRevoke: number | undefined;
      revokeAfterSend = () => {
        stopping = f.bridge.revoke(reason);
        activityAfterRevoke = f.activityCount;
      };
      f.bridge.beginTurn();
      const observed = rawRpc(f.bridge, request(rpcId, "tools/call", { name: "read", arguments: { index: 0 } }), { session: transport.sessionId })
        .then(response => response.text()).catch(error => error);
      await f.wait(() => f.bridge.pendingCount === 1);
      const call = f.bridge.takeNext()!;
      const completion = f.bridge.complete(call.id, { source: "content", content: [{ type: "text", text: "actual effects" }], isError: false }).catch(error => error);
      expect(await completion).toBe(reason);
      await stopping;
      expect(actualSendFulfilled).toBe(true);
      expect(f.bridge.snapshot()).toMatchObject({ accepting: false, revoked: true, pendingCount: 0, queuedCount: 0, dispatchedCount: 0, deliveringCount: 0, deliveredCount: 0 });
      expect(f.bridge.takeNext()).toBeUndefined();
      expect(() => f.bridge.beginTurn()).toThrow("revoked");
      expect(activityAfterRevoke).toBe(f.activityCount);
      expect(f.failures).toEqual([]);
      await observed;
    } finally { send.mockRestore(); }
  });

  test.each(["completed", "rejected", "pending"] as const)("HTTP abort is fatal only for its own still-pending request: %s", async state => {
    const rpcId = `http-abort-${state}`;
    const held = holdHttpToolRequest(rpcId);
    try {
      const f = await fixture();
      const initialized = await rawRpc(f.bridge, request("init", "initialize", {
        protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "abort-ownership", version: "1" },
      }));
      const session = initialized.headers.get("mcp-session-id")!;
      await initialized.text();
      f.bridge.beginTurn();
      const observed = rawRpc(f.bridge, request(rpcId, "tools/call", { name: state === "rejected" ? "missing" : "read", arguments: { index: 0 } }), { session })
        .then(response => response.text()).catch(error => error instanceof Error ? error : new Error(String(error)));
      const signal = await held.entered;
      if (state === "rejected") {
        await held.sent;
      } else {
        await f.wait(() => f.bridge.pendingCount === 1);
        const call = f.bridge.takeNext()!;
        if (state === "completed") await f.bridge.complete(call.id, { source: "content", content: [{ type: "text", text: "actual result" }], isError: false });
      }
      // handleRequest has not returned, so release() cannot have detached abort.
      expect(f.bridge.snapshot().connections).toBe(1);
      expect(f.bridge.pendingCount).toBe(state === "pending" ? 1 : 0);
      let otherBody: Promise<string | Error> | undefined;
      if (state !== "pending") {
        const other = await rawRpc(f.bridge, request("unrelated-pending", "tools/call", { name: "read", arguments: { index: 1 } }), { session });
        otherBody = other.text().catch(error => error instanceof Error ? error : new Error(String(error)));
        await f.wait(() => f.bridge.pendingCount === 1);
      }
      signal.dispatchEvent(new Event("abort"));
      if (state === "pending") {
        expect(f.failures).toHaveLength(1);
        expect(f.failures[0]!.message).toContain("HTTP connection aborted");
        expect(f.bridge.snapshot()).toMatchObject({ revoked: true, pendingCount: 0, deliveredCount: 0 });
        expect(f.bridge.takeNext()).toBeUndefined();
        expect(() => f.bridge.beginTurn()).toThrow("revoked");
      } else {
        expect(f.failures).toEqual([]);
        expect(f.bridge.snapshot()).toMatchObject({ revoked: false, pendingCount: 1, deliveredCount: state === "completed" ? 1 : 0 });
        const other = f.bridge.takeNext()!;
        expect(other.arguments).toEqual({ index: 1 });
        await f.bridge.complete(other.id, { source: "content", content: [{ type: "text", text: "unrelated result" }], isError: false });
        expect(await otherBody).toContain("unrelated result");
      }
      held.release();
      if (state === "pending") await f.bridge.revoke(new Error("Already cancelled"));
      const body = await observed;
      if (state !== "pending") {
        expect(typeof body).toBe("string");
        expect(body).toContain(state === "completed" ? "actual result" : "Unknown bridge tool");
        f.bridge.endTurn();
        const catalog = await rawRpc(f.bridge, request("still-live", "tools/list"), { session });
        expect(await catalog.text()).toContain('"name":"read"');
        expect(f.failures).toEqual([]);
      }
    } finally { held.restore(); }
  });
});

test("snapshot exposes only bounded redacted lifecycle counters before and after revoke", async () => {
  const f = await fixture();
  expect(f.bridge.snapshot()).toEqual({
    accepting: true, revoked: false, initialized: false, activeTurn: false,
    sessionCount: 0, connections: 0, pendingCount: 0, queuedCount: 0,
    dispatchedCount: 0, deliveringCount: 0, deliveredCount: 0, catalogReadCount: 0,
  });
  const { client } = await f.connect();
  expect(f.bridge.snapshot().initialized).toBe(true);
  expect(f.bridge.snapshot().sessionCount).toBe(1);
  await client.listTools();
  expect(f.bridge.snapshot().catalogReadCount).toBe(1);
  f.bridge.beginTurn();
  const result = client.callTool({ name: "read", arguments: { index: 1 } });
  await f.wait(() => f.bridge.pendingCount === 1);
  expect(f.bridge.snapshot().queuedCount).toBe(1);
  const call = f.bridge.takeNext()!;
  expect(f.bridge.snapshot().dispatchedCount).toBe(1);
  const completion = f.bridge.complete(call.id, { source: "content", content: [], isError: false });
  expect(f.bridge.snapshot().deliveringCount).toBe(1);
  await completion;
  await result;
  expect(f.bridge.snapshot().pendingCount).toBe(0);
  expect(f.bridge.snapshot().deliveredCount).toBe(1);
  f.bridge.endTurn();
  await f.bridge.revoke(new Error("Snapshot disposal"));
  const stopped = f.bridge.snapshot();
  expect(stopped.accepting).toBe(false);
  expect(stopped.revoked).toBe(true);
  expect(stopped.activeTurn).toBe(false);
  expect(stopped.sessionCount).toBe(0);
  for (const value of Object.values(stopped)) expect(["boolean", "number"]).toContain(typeof value);
  expect(JSON.stringify(stopped)).not.toContain(f.bridge.token);
  expect(JSON.stringify(stopped)).not.toContain(f.bridge.url);
});

test("real SDK handoff preserves trusted envelopes and applies only the approved JSON text projection", async () => {
  const f = await fixture();
  const { client } = await f.connect();
  f.bridge.beginTurn();
  const resource = { type: "resource" as const, resource: { uri: "fixture://resource", mimeType: "text/plain", text: "RESOURCE_MARKER" } };
  const image = { type: "image" as const, data: "YWJj", mimeType: "image/png" };
  const cases: { original: CallToolResult; hostError: boolean; expected: CallToolResult }[] = [
    {
      original: { content: [], structuredContent: { marker: "STRUCTURED_MARKER", exactId: "900719925474099312345678901234567890" }, _meta: { handle: "empty-structured" } },
      hostError: false,
      expected: { content: [{ type: "text", text: '{"marker":"STRUCTURED_MARKER","exactId":"900719925474099312345678901234567890"}' }], structuredContent: { marker: "STRUCTURED_MARKER", exactId: "900719925474099312345678901234567890" }, _meta: { handle: "empty-structured" } },
    },
    {
      original: { content: [resource, image], structuredContent: { exactId: "900719925474099312345678901234567890" }, _meta: { handle: "resource-image" } },
      hostError: false,
      expected: { content: [resource, image, { type: "text", text: '{"exactId":"900719925474099312345678901234567890"}' }], structuredContent: { exactId: "900719925474099312345678901234567890" }, _meta: { handle: "resource-image" } },
    },
    {
      original: { content: [{ type: "text", text: "ERROR_MARKER" }], structuredContent: { exactId: "900719925474099312345678901234567890" }, isError: false },
      hostError: true,
      expected: { content: [{ type: "text", text: "ERROR_MARKER" }, { type: "text", text: '{"exactId":"900719925474099312345678901234567890"}' }], structuredContent: { exactId: "900719925474099312345678901234567890" }, isError: true },
    },
    {
      original: { content: [{ type: "text", text: ' {"marker":"ALREADY_JSON","id":"900719925474099312345678901234567890"} ' }], structuredContent: { id: "900719925474099312345678901234567890", marker: "ALREADY_JSON" }, isError: false },
      hostError: false,
      expected: { content: [{ type: "text", text: ' {"marker":"ALREADY_JSON","id":"900719925474099312345678901234567890"} ' }], structuredContent: { id: "900719925474099312345678901234567890", marker: "ALREADY_JSON" }, isError: false },
    },
  ];
  for (const [index, item] of cases.entries()) {
    const before = JSON.stringify(item.original);
    const returned = client.callTool({ name: "read", arguments: { index } });
    await f.wait(() => f.bridge.pendingCount === 1);
    const call = f.bridge.takeNext()!;
    await f.bridge.complete(call.id, { source: "mcp", result: item.original, isError: item.hostError });
    expect(await returned).toEqual(item.expected);
    expect(JSON.stringify(item.original)).toBe(before);
  }
  expect(f.bridge.pendingCount).toBe(0);
  expect(f.bridge.deliveredCount).toBe(4);
  f.bridge.endTurn();
  expect(f.failures).toEqual([]);
});
