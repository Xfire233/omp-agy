import { randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema, ListToolsRequestSchema, JSONRPCMessageSchema, JSONRPCRequestSchema,
  ErrorCode, McpError, type CallToolResult, type RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import { assertJsonValue, buildCatalog, type Catalog, type ToolDefinition } from "./catalog.js";
import { encodeResult, type TrustedResult } from "./results.js";
import { debugEvent, type DebugContext, type DebugObserver } from "./debug.ts";

const sseOpening = new TextEncoder().encode(": omp-agy\n\n");

export interface BridgeLimits {
  maxPending?: number;
  pendingLifetimeMs?: number;
  maxBodyBytes?: number;
  maxResultBytes?: number;
  maxConnections?: number;
  bodyTimeoutMs?: number;
}

export interface PendingCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface BridgeSnapshot {
  accepting: boolean;
  revoked: boolean;
  initialized: boolean;
  activeTurn: boolean;
  sessionCount: number;
  connections: number;
  pendingCount: number;
  queuedCount: number;
  dispatchedCount: number;
  deliveringCount: number;
  deliveredCount: number;
  catalogReadCount: number;
}

export interface Bridge {
  readonly url: string;
  readonly token: string;
  readonly aliases: string[];
  readonly catalog: Catalog;
  readonly pendingCount: number;
  readonly deliveredCount: number;
  snapshot(): BridgeSnapshot;
  beginTurn(): void;
  endTurn(): void;
  takeNext(): PendingCall | undefined;
  complete(id: string, result: TrustedResult): Promise<void>;
  revoke(reason: Error): Promise<void>;
}

interface Entry {
  call: PendingCall;
  rpcId: RequestId;
  state: "queued" | "dispatched" | "delivering";
  resolve: (result: CallToolResult) => void;
  reject: (error: Error) => void;
  delivery: Promise<Error | undefined>;
  settleDelivery: (error?: Error) => void;
  timer: Timer;
  detachAbort: () => void;
}

class HttpFailure extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function readBody(request: Request, maxBytes: number, timeoutMs: number): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)))) throw new HttpFailure(400, "Invalid Content-Length");
  if (declared !== null && Number(declared) > maxBytes) throw new HttpFailure(413, "Request body too large");
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => timeout.reject(new HttpFailure(408, "Request body timeout")), timeoutMs);
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), timeout.promise]);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new HttpFailure(413, "Request body too large");
      chunks.push(value);
    }
    if (!size) return undefined;
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const body: unknown = JSON.parse(text);
    assertJsonValue(body);
    return body;
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof HttpFailure) throw error;
    throw new HttpFailure(400, "Invalid JSON body");
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

/** One authenticated SDK transport and immutable catalog per CLI activation. No executor lives here. */
export async function createBridge(options: {
  hostname: string;
  sourceAddress: string;
  tools: readonly ToolDefinition[];
  onActivity: () => void;
  onFatal: (error: Error) => void;
  limits?: BridgeLimits;
  debug?: DebugObserver;
  debugContext?: () => DebugContext;
}): Promise<Bridge> {
  if (!isIP(options.hostname) || ["0.0.0.0", "::"].includes(options.hostname)) throw new Error("Bridge must bind a specific interface IP address");
  if (!isIP(options.sourceAddress)) throw new Error("Bridge requires the current runner source IP address");
  const limits = {
    maxPending: 128, pendingLifetimeMs: 2 * 60 * 60 * 1000,
    maxBodyBytes: 4 * 1024 * 1024, maxResultBytes: 16 * 1024 * 1024,
    maxConnections: 256, bodyTimeoutMs: 15_000, ...options.limits,
  };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) throw new Error(`Invalid bridge limit: ${key}`);
  }
  if (limits.maxPending < 64) throw new Error("Bridge maxPending must be at least 64 (45-call pressure plus control headroom)");
  const catalog: Catalog = buildCatalog(options.tools);
  const token = randomBytes(32).toString("base64url");
  const authorization = Buffer.from(`Bearer ${token}`);
  const activationId = randomBytes(16).toString("hex");
  let counter = 0;
  let activeTurn = false;
  let initialized = false;
  let revoked = false;
  let delivered = 0;
  let catalogReads = 0;
  let connections = 0;
  let dispatched: Entry | undefined;
  let stopping: Promise<void> | undefined;
  const pending = new Map<string, Entry>();
  const rpcPending = new Map<RequestId, Entry>();
  const incomingIds = new Set<RequestId>();
  const queue: Entry[] = [];
  const mcp = new Server({ name: "omp-agy-bridge", version: "1.0.0" }, { capabilities: { tools: {} } });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomBytes(24).toString("base64url"),
    onsessioninitialized: () => { initialized = true; options.onActivity(); },
    onsessionclosed: () => { fatal(new Error("CLI closed the MCP session")); },
    enableJsonResponse: false,
    keepAliveMs: 15_000,
    maxRequestBodySize: limits.maxBodyBytes,
  });

  function fatal(error: Error): void {
    if (revoked) return;
    // revoke marks capability unusable synchronously, before any callback can dispatch again.
    void revoke(error).catch(() => {});
    options.onFatal(error);
  }

  function remove(entry: Entry): void {
    clearTimeout(entry.timer);
    entry.detachAbort();
    pending.delete(entry.call.id);
    rpcPending.delete(entry.rpcId);
    if (dispatched === entry) dispatched = undefined;
  }

  // Handler resolution alone is insufficient: the SDK must have accepted the final response
  // into its HTTP transport before the next tool may be handed off.
  const send = transport.send.bind(transport);
  transport.send = async (message, sendOptions) => {
    const response = "id" in message && ("result" in message || "error" in message);
    const entry = response && message.id !== undefined ? rpcPending.get(message.id) : undefined;
    try {
      await send(message, sendOptions);
      debugEvent(options.debug, "mcp.out", message, () => ({ ...options.debugContext?.(), mcpSessionId: transport.sessionId, ...(response ? { requestId: message.id } : {}), ...(entry ? { toolCallId: entry.call.id } : {}) }));
      // A real send can finish after revoke has already settled and removed its
      // entry. Only the still-owned request may commit successful delivery.
      if (entry && !revoked && pending.get(entry.call.id) === entry) {
        if (entry.state !== "delivering" || "error" in message) {
          const error = new Error("MCP tool result handler failed before successful delivery");
          entry.settleDelivery(error);
          fatal(error);
        } else {
          remove(entry);
          delivered++;
          debugEvent(options.debug, "mcp.result.delivered", { delivered: true }, () => ({ ...options.debugContext?.(), mcpSessionId: transport.sessionId, requestId: entry.rpcId, toolCallId: entry.call.id }));
          entry.settleDelivery();
          options.onActivity();
        }
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      entry?.settleDelivery(failure);
      fatal(new Error("MCP response delivery failed"));
      throw failure;
    }
  };
  mcp.setRequestHandler(ListToolsRequestSchema, request => {
    if (request.params?.cursor !== undefined) throw new McpError(ErrorCode.InvalidParams, "This immutable catalog has no continuation cursor");
    catalogReads++;
    options.onActivity();
    return { tools: [...catalog.tools] };
  });
  mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (revoked) throw new McpError(ErrorCode.InternalError, "Bridge activation has been revoked");
    if (!activeTurn) {
      fatal(new Error("Authenticated tool request arrived while the activation was idle; activation cannot be reused"));
      throw new McpError(ErrorCode.InvalidRequest, "No active execution turn");
    }
    if (request.params.task !== undefined) throw new McpError(ErrorCode.InvalidParams, "Task-augmented MCP execution is not supported by this bridge");
    const name = catalog.resolve(request.params.name);
    if (name === undefined) throw new McpError(ErrorCode.InvalidParams, "Unknown bridge tool");
    const args = request.params.arguments ?? {};
    try { catalog.validate(request.params.name, args); }
    catch (error) { throw new McpError(ErrorCode.InvalidParams, error instanceof Error ? error.message : "Invalid tool arguments"); }
    if (pending.size >= limits.maxPending) throw new McpError(ErrorCode.InternalError, "Bridge tool queue capacity exceeded; no tool was dispatched");
    if (rpcPending.has(extra.requestId)) throw new McpError(ErrorCode.InvalidRequest, "Duplicate live request ID");
    if (extra.signal.aborted) throw new McpError(ErrorCode.InvalidRequest, "Tool request was cancelled before dispatch");
    const result = Promise.withResolvers<CallToolResult>();
    const delivery = Promise.withResolvers<Error | undefined>();
    const id = `omp_agy_${activationId}_${++counter}`;
    const onAbort = () => { fatal(new Error("CLI cancelled a pending bridge tool request; dispatched effects may already have occurred")); };
    const entry: Entry = {
      call: { id, name, arguments: structuredClone(args) }, rpcId: extra.requestId,
      state: "queued", resolve: result.resolve, reject: result.reject,
      delivery: delivery.promise, settleDelivery: error => delivery.resolve(error),
      timer: setTimeout(() => fatal(new Error("Bridge tool pending lifetime exceeded; no automatic retry is permitted")), limits.pendingLifetimeMs),
      detachAbort: () => extra.signal.removeEventListener("abort", onAbort),
    };
    extra.signal.addEventListener("abort", onAbort, { once: true });
    pending.set(id, entry);
    rpcPending.set(extra.requestId, entry);
    queue.push(entry);
    debugEvent(options.debug, "mcp.call.queued", request, () => ({ ...options.debugContext?.(), mcpSessionId: transport.sessionId, requestId: extra.requestId, toolCallId: id }));
    options.onActivity();
    return await result.promise;
  });
  mcp.onclose = () => { if (!revoked) fatal(new Error("MCP transport closed unexpectedly")); };
  await mcp.connect(transport);

  const server = Bun.serve({
    hostname: options.hostname, port: 0, idleTimeout: 0,
    maxRequestBodySize: limits.maxBodyBytes,
    async fetch(request, httpServer) {
      if (revoked) return new Response("Activation revoked", { status: 410 });
      const url = new URL(request.url);
      const address = httpServer.requestIP(request)?.address.replace(/^::ffff:/, "");
      const expectedSource = options.sourceAddress.replace(/^::ffff:/, "");
      if (address !== expectedSource) return new Response("Forbidden source", { status: 403 });
      if (request.headers.get("host") !== new URL(endpoint).host) return new Response("Forbidden Host", { status: 403 });
      if (request.headers.has("origin")) return new Response("Browser Origin is not permitted", { status: 403 });
      if (url.search || url.hash) return new Response("Not found", { status: 404 });
      const discovery = url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp";
      if (url.pathname !== "/mcp" && !discovery) return new Response("Not found", { status: 404 });
      if (discovery && request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
      if (!discovery && !["GET", "POST", "DELETE"].includes(request.method)) return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST, DELETE" } });
      if (connections >= limits.maxConnections) return new Response("Bridge connection capacity exceeded", { status: 503 });
      connections++;
      let requestId: RequestId | undefined;
      let abort: (() => void) | undefined;
      let streaming = false;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        if (requestId !== undefined) incomingIds.delete(requestId);
        if (abort) request.signal.removeEventListener("abort", abort);
        connections--;
      };
      try {
        const body = await readBody(request, limits.maxBodyBytes, limits.bodyTimeoutMs);
        if (request.method !== "POST" && (body !== undefined || Number(request.headers.get("content-length") ?? 0) > 0)) throw new HttpFailure(400, "Body not allowed for this method");
        if (discovery) return new Response(null, { status: 404 });
        if (request.method === "POST" && !request.headers.get("content-type")?.split(";")[0]?.trim().match(/^application\/json$/i)) throw new HttpFailure(415, "Content-Type must be application/json");
        const parsed = request.method === "POST" ? JSONRPCRequestSchema.safeParse(body) : undefined;
        if (!initialized && parsed?.success && parsed.data.method === "server/discover") {
          return Response.json({ jsonrpc: "2.0", id: parsed.data.id, error: { code: -32601, message: "Method not found" } });
        }
        const provided = Buffer.from(request.headers.get("authorization") ?? "");
        if (provided.byteLength !== authorization.byteLength || !timingSafeEqual(provided, authorization)) {
          return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
        }
        if (request.method === "POST") {
          if (!JSONRPCMessageSchema.safeParse(body).success) throw new HttpFailure(400, "Invalid MCP JSON-RPC message");
          if (parsed?.success) {
            const candidateId = parsed.data.id;
            if (incomingIds.has(candidateId)) throw new HttpFailure(409, "Duplicate live request ID");
            incomingIds.add(candidateId);
            requestId = candidateId;
            if (parsed.data.method === "tools/call") {
              abort = () => {
                if (requestId !== undefined && rpcPending.has(requestId)) fatal(new Error("CLI HTTP connection aborted during a bridge tool request; effects may be unknown"));
              };
              request.signal.addEventListener("abort", abort, { once: true });
              if (request.signal.aborted) throw new HttpFailure(400, "Request already aborted");
            }
          }
        }
        debugEvent(options.debug, "mcp.in", body, () => ({ ...options.debugContext?.(), mcpSessionId: transport.sessionId, ...(requestId !== undefined ? { requestId } : {}) }));
        const response = await transport.handleRequest(request, { parsedBody: body });
        if (!response.body || !response.headers.get("content-type")?.startsWith("text/event-stream")) return response;
        // Own the HTTP stream lifetime too: a returned SSE Response is not a completed
        // request. Connection/ID limits and abort ownership survive until EOF/cancel.
        const reader = response.body.getReader();
        streaming = true;
        return new Response(new ReadableStream<Uint8Array>({
          // Flush HTTP headers even when the first SDK event waits on caller tool work.
          start(controller) { controller.enqueue(sseOpening); },
          async pull(controller) {
            try {
              const item = await reader.read();
              if (item.done) { release(); controller.close(); }
              else controller.enqueue(item.value);
            } catch (error) {
              release();
              controller.error(error);
              if (requestId !== undefined && rpcPending.has(requestId)) fatal(new Error("MCP result stream failed with pending bridge work"));
            }
          },
          async cancel(reason) {
            if (requestId !== undefined && rpcPending.has(requestId)) fatal(new Error("CLI disconnected with pending bridge work; effects may be unknown"));
            release();
            await reader.cancel(reason);
          },
        }), { status: response.status, headers: response.headers });
      } catch (error) {
        if (error instanceof HttpFailure) return new Response(error.message, { status: error.status });
        fatal(new Error("Authenticated MCP transport request failed"));
        return new Response("MCP transport failure", { status: 500 });
      } finally {
        if (!streaming) release();
      }
    },
  });
  const endpoint = `http://${isIP(options.hostname) === 6 ? `[${options.hostname}]` : options.hostname}:${server.port}/mcp`;

  function revoke(reason: Error): Promise<void> {
    if (stopping) return stopping;
    revoked = true;
    activeTurn = false;
    options.onActivity();
    for (const entry of pending.values()) {
      entry.reject(new McpError(ErrorCode.InternalError, reason.message));
      entry.settleDelivery(reason);
      clearTimeout(entry.timer);
      entry.detachAbort();
    }
    pending.clear();
    rpcPending.clear();
    queue.length = 0;
    dispatched = undefined;
    stopping = (async () => {
      try { await mcp.close(); }
      finally { await server.stop(true); }
    })();
    return stopping;
  }

  return {
    url: endpoint, token, aliases: [...catalog.aliases], catalog,
    get pendingCount() { return pending.size; },
    get deliveredCount() { return delivered; },
    snapshot() {
      return {
        accepting: !revoked, revoked, initialized, activeTurn,
        sessionCount: initialized && !revoked ? 1 : 0,
        connections, pendingCount: pending.size, queuedCount: queue.length,
        dispatchedCount: dispatched?.state === "dispatched" ? 1 : 0,
        deliveringCount: dispatched?.state === "delivering" ? 1 : 0,
        deliveredCount: delivered, catalogReadCount: catalogReads,
      };
    },
    beginTurn() {
      if (revoked) throw new Error("Bridge activation has been revoked");
      if (activeTurn || pending.size) throw new Error("Previous bridge turn is still active");
      activeTurn = true;
    },
    endTurn() {
      if (revoked) throw new Error("Bridge activation has been revoked");
      if (!activeTurn) throw new Error("No active bridge turn");
      if (pending.size || dispatched) throw new Error("Cannot end a turn with queued, dispatched, or delivering MCP work");
      activeTurn = false;
    },
    takeNext() {
      if (revoked || !activeTurn || dispatched) return undefined;
      const entry = queue.shift();
      if (!entry) return undefined;
      entry.state = "dispatched";
      dispatched = entry;
      debugEvent(options.debug, "mcp.call.dispatched", entry.call, () => ({ ...options.debugContext?.(), mcpSessionId: transport.sessionId, requestId: entry.rpcId, toolCallId: entry.call.id }));
      return structuredClone(entry.call);
    },
    async complete(id, result) {
      const entry = pending.get(id);
      if (!entry || entry !== dispatched || entry.state !== "dispatched") throw new Error("Unknown, queued, or already completed bridge tool call ID");
      let encoded: CallToolResult;
      try {
        encoded = encodeResult(result);
        if (Buffer.byteLength(JSON.stringify(encoded), "utf8") > limits.maxResultBytes) throw new Error("Tool executed, but its result exceeds the bridge result size limit");
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        fatal(new Error(`Tool result encoding failed after execution: ${failure.message}`));
        throw failure;
      }
      entry.state = "delivering";
      debugEvent(options.debug, "mcp.result.ready", encoded, () => ({ ...options.debugContext?.(), mcpSessionId: transport.sessionId, requestId: entry.rpcId, toolCallId: entry.call.id }));
      entry.resolve(encoded);
      const failure = await entry.delivery;
      if (failure) throw failure;
    },
    revoke,
  };
}
