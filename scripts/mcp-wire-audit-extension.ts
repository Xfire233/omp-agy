import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { WebStandardStreamableHTTPServerTransport, type HandleRequestOptions } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { RequestId } from "@modelcontextprotocol/sdk/types.js";
import productionExtension from "../index.ts";

// Acceptance-only SINGLE OMP extension entry: -e scripts/mcp-wire-audit-extension.ts
// Replace index.ts for this audited launch; separate -e entries have isolated loader graphs.
// OMP_AGY_MCP_WIRE_AUDIT_FILE must name a unique absolute output JSONL path.
// No production envelope, response stream, authentication or execution is changed.
// SDK send() serializes this same message with JSON.stringify before it resolves.
const fixtureName = /^mcp__acceptance_results_(empty_structured|resource_image|expected_error|native_json)$/;
const maxTrackedCalls = 64;
const maxRecordBytes = 1_048_576;
const maxTraceBytes = 8_388_608;
const requestLifetimeMs = 120_000;
let installed = false;

interface CallIdentity { name: string; requestId: RequestId }
interface TrackedCall extends CallIdentity {
  transport: WebStandardStreamableHTTPServerTransport;
  timer: Timer;
}
interface AuditState {
  output: string;
  bytes: number;
  writeFailed: boolean;
  truncated: boolean;
  resultCount: number;
  incompleteCount: number;
  sendFailureCount: number;
  stopping: boolean;
  writes: Promise<void>;
  calls: WeakMap<WebStandardStreamableHTTPServerTransport, Map<RequestId, TrackedCall>>;
  active: Set<TrackedCall>;
}

/** Audit I/O is deliberately detached from transport success/failure and cannot throw into it. */
function enqueue(state: AuditState, entry: object): void {
  let line: string;
  try { line = `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`; }
  catch { state.writeFailed = true; return; }
  const bytes = Buffer.byteLength(line);
  if (bytes > maxRecordBytes || state.bytes + bytes > maxTraceBytes) { state.truncated = true; return; }
  state.bytes += bytes;
  state.writes = state.writes.then(async () => { await appendFile(state.output, line); }).catch(() => { state.writeFailed = true; });
}

function callIdentity(options: HandleRequestOptions | undefined): CallIdentity | undefined {
  const value = options?.parsedBody;
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const message = value as Record<string, unknown>;
  if (message.jsonrpc !== "2.0" || message.method !== "tools/call") return;
  if (typeof message.id !== "string" && !(typeof message.id === "number" && Number.isSafeInteger(message.id))) return;
  const params = message.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return;
  const name = (params as Record<string, unknown>).name;
  if (typeof name !== "string" || !fixtureName.test(name)) return;
  // Never inspect/retain arguments, Request headers, URL, token or prompt content.
  return { name, requestId: message.id as RequestId };
}

function remove(state: AuditState, call: TrackedCall): void {
  clearTimeout(call.timer);
  state.calls.get(call.transport)?.delete(call.requestId);
  state.active.delete(call);
}

export default async function mcpWireAudit(pi: ExtensionAPI): Promise<void> {
  if (installed) { await productionExtension(pi); return; }
  const output = process.env.OMP_AGY_MCP_WIRE_AUDIT_FILE;
  if (!output || !isAbsolute(output)) throw new Error("MCP wire audit requires a unique absolute OMP_AGY_MCP_WIRE_AUDIT_FILE");
  await mkdir(dirname(output), { recursive: true });
  // Refuse overwriting an earlier audit artifact.
  await writeFile(output, "", { flag: "wx" });
  const state: AuditState = {
    output, bytes: 0, writeFailed: false, truncated: false, resultCount: 0,
    incompleteCount: 0, sendFailureCount: 0, stopping: false, writes: Promise.resolve(),
    calls: new WeakMap(), active: new Set(),
  };
  const status = (completed: boolean, writesDrained: boolean, pendingAtShutdown: number) => ({
    completed, writesDrained, writeFailed: state.writeFailed, truncated: state.truncated,
    resultCount: state.resultCount, incompleteCount: state.incompleteCount,
    sendFailureCount: state.sendFailureCount, pendingAtShutdown,
  });
  await writeFile(`${output}.status.json`, `${JSON.stringify(status(false, true, 0))}\n`, { flag: "wx" });
  const prototype = WebStandardStreamableHTTPServerTransport.prototype;
  const handleRequest = prototype.handleRequest;
  const send = prototype.send;
  prototype.handleRequest = async function (request, options) {
    const identity = callIdentity(options);
    let tracked: TrackedCall | undefined;
    if (identity && !state.stopping) {
      let calls = state.calls.get(this);
      if (!calls) state.calls.set(this, calls = new Map());
      if (state.active.size >= maxTrackedCalls || calls.has(identity.requestId)) {
        state.incompleteCount++;
        enqueue(state, { kind: "audit_incomplete", method: "tools/call", ...identity, reason: "tracking_capacity_or_duplicate_id" });
      } else {
        const call: TrackedCall = {
          ...identity, transport: this,
          timer: setTimeout(() => {
            remove(state, call);
            state.incompleteCount++;
            enqueue(state, { kind: "audit_incomplete", method: "tools/call", ...identity, reason: "response_deadline" });
          }, requestLifetimeMs),
        };
        call.timer.unref();
        tracked = call;
        calls.set(call.requestId, call);
        state.active.add(call);
      }
    }
    try {
      const response = await handleRequest.call(this, request, options);
      if (tracked && response.status >= 400 && state.active.has(tracked)) {
        remove(state, tracked);
        state.incompleteCount++;
        enqueue(state, { kind: "audit_incomplete", method: "tools/call", name: tracked.name, requestId: tracked.requestId, reason: "http_rejected", status: response.status });
      }
      return response;
    } catch (error) {
      if (tracked && state.active.has(tracked)) {
        remove(state, tracked);
        state.incompleteCount++;
        enqueue(state, { kind: "audit_incomplete", method: "tools/call", name: tracked.name, requestId: tracked.requestId, reason: "request_delegate_failed" });
      }
      throw error;
    }
  };
  prototype.send = async function (message, options) {
    const response = "id" in message && ("result" in message || "error" in message);
    const tracked = response && message.id !== undefined ? state.calls.get(this)?.get(message.id) : undefined;
    try {
      // Preserve the original send's fulfillment/rejection. Audit writes never participate
      // in this promise, and a failed send is never recorded as a delivered envelope.
      await send.call(this, message, options);
    } catch (error) {
      if (tracked) {
        remove(state, tracked);
        state.sendFailureCount++;
        state.incompleteCount++;
        enqueue(state, { kind: "audit_incomplete", method: "tools/call", name: tracked.name, requestId: tracked.requestId, reason: "send_delegate_failed" });
      }
      throw error;
    }
    if (!tracked || state.stopping) return;
    remove(state, tracked);
    if (!response || !("result" in message)) {
      state.incompleteCount++;
      enqueue(state, { kind: "audit_incomplete", method: "tools/call", name: tracked.name, requestId: tracked.requestId, reason: "jsonrpc_error_instead_of_result" });
      return;
    }
    state.resultCount++;
    // enqueue immediately serializes an immutable snapshot of the actual SDK message.
    // Fixture envelopes are controlled test data, not arbitrary tools/prompts/headers.
    enqueue(state, {
      kind: "agy_facing_wire_result", method: "tools/call", name: tracked.name,
      requestId: tracked.requestId,
      message: { jsonrpc: message.jsonrpc, id: message.id, result: message.result },
    });
  };
  installed = true;
  pi.on("session_shutdown", async () => {
    state.stopping = true;
    const pendingAtShutdown = state.active.size;
    for (const call of [...state.active]) {
      remove(state, call);
      state.incompleteCount++;
      enqueue(state, { kind: "audit_incomplete", method: "tools/call", name: call.name, requestId: call.requestId, reason: "shutdown_before_response" });
    }
    const deadline = Promise.withResolvers<boolean>();
    const timer = setTimeout(() => deadline.resolve(false), 2_000);
    let writesDrained = false;
    try { writesDrained = await Promise.race([state.writes.then(() => true), deadline.promise]); }
    finally { clearTimeout(timer); }
    try { await writeFile(`${output}.status.json`, `${JSON.stringify(status(true, writesDrained, pendingAtShutdown))}\n`); }
    catch { state.writeFailed = true; /* Missing completed status makes the audit fail, not production cleanup. */ }
  });
  // SDK hooks and the real extension's imports share this one loader graph. Every
  // factory invocation still registers the real extension, including OMP children.
  await productionExtension(pi);
}
