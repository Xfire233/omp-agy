import assert from "node:assert/strict";
import * as acp from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AssistantMessage, Context, Model, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai";
import { createBridge, type PendingCall } from "../../src/bridge.ts";
import { readConfig } from "../../src/config.ts";
import { SessionController } from "../../src/controller.ts";
import { ProviderRuntime, type SteeringQuarantineRecord } from "../../src/provider.ts";

export const initial: UserMessage = { role: "user", content: "controlled boundary owner", timestamp: 0 };
export const boundary: UserMessage = { role: "user", content: "steering while the original read is parked", timestamp: 1 };
const tools = [{ name: "read", description: "Controlled OMP read", parameters: {
  type: "object", properties: { index: { type: "integer" } }, required: ["index"], additionalProperties: false,
} }];
const model: Model = { id: "controlled-boundary-model", name: "Controlled no-generation boundary", identity: { class: "unknown" }, compat: undefined,
  api: "omp-agy-acp", provider: "omp-agy", baseUrl: "acp://fixture", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 400000, maxTokens: 8192 };
export const sessionId = "boundary-steering-host";
export const confirmationMs = 60_000;

interface Flight {
  promise: Promise<acp.PromptResponse>;
  resolve(response: acp.PromptResponse): void;
  reject(reason?: unknown): void;
  prompt: acp.ContentBlock[];
}
interface BootstrapSeam {
  connection: acp.ClientConnection;
  configOptions: acp.SessionConfigOption[];
  update(notification: acp.SessionNotification): void;
}

/** A failure watchdog, not a success delay. This integration uses live HTTP/ACP
 * streams and SDK timers: fake global time would also change transport behavior.
 * Success awaits actual activity; the watchdog proves the 60s receipt timer did not rescue us. */
export async function bounded<T>(work: Promise<T>, label: string): Promise<T> {
  const expired = Promise.withResolvers<never>();
  const timer = setTimeout(() => expired.reject(new Error(`${label} did not finish before the receipt confirmation window`)), 2_000);
  try { return await Promise.race([work, expired.promise]); }
  finally { clearTimeout(timer); }
}

/** Shared by the regression and standalone smoke. Only bootstrap/process ownership
 * is substituted. ACP framing, controller/provider and authenticated HTTP MCP are real. */
export function createBoundaryFixture() {
  const runtime = new ProviderRuntime({ ...readConfig({}), steeringConfirmationMs: confirmationMs });
  const records: SteeringQuarantineRecord[] = [];
  runtime.onUncertainSteering = record => { records.push(record); };
  const opened = Promise.withResolvers<SessionController>();
  const received = [Promise.withResolvers<Flight>(), Promise.withResolvers<Flight>()];
  const flights: Flight[] = [];
  const rpcResults: Promise<unknown>[] = [];
  const completedIds: string[] = [];
  const dispatched: PendingCall[] = [];
  let openings = 0;
  let controller: SessionController | undefined;
  let peer: acp.AgentConnection | undefined;
  let client: Client | undefined;
  let sawNextQueuedAfterDelivery = false;
  const originalOpen = SessionController.open;
  SessionController.open = async (settings, catalog, callbacks = {}) => {
    openings++;
    controller = Reflect.construct(SessionController, [settings, callbacks]) as SessionController;
    const live = controller;
    const seam = live as unknown as BootstrapSeam;
    live.sessionId = "controlled-boundary-acp";
    live.bridge = await createBridge({
      hostname: "127.0.0.1", sourceAddress: "127.0.0.1", tools: catalog,
      onActivity() {
        const state = live.bridge?.snapshot();
        if (state?.deliveredCount === 1 && state.queuedCount > 0) sawNextQueuedAfterDelivery = true;
        live.wake();
      },
      onFatal(error) { void live.fail(error); },
    });
    // Observe actual methods, forwarding unchanged arguments and their real results.
    const complete = live.bridge.complete.bind(live.bridge);
    live.bridge.complete = async (id, result) => { completedIds.push(id); await complete(id, result); };
    const takeNext = live.bridge.takeNext.bind(live.bridge);
    live.bridge.takeNext = () => { const call = takeNext(); if (call) dispatched.push(call); return call; };
    const toAgent = new TransformStream<Uint8Array, Uint8Array>();
    const toClient = new TransformStream<Uint8Array, Uint8Array>();
    peer = acp.agent({ name: "controlled-boundary-peer" })
      .onRequest(acp.methods.agent.session.prompt, ({ params }) => {
        const flight: Flight = { ...Promise.withResolvers<acp.PromptResponse>(), prompt: params.prompt };
        flights.push(flight);
        received[flights.length - 1]?.resolve(flight);
        return flight.promise;
      })
      .onNotification(acp.methods.agent.session.cancel, () => {
        for (const flight of flights) flight.resolve({ stopReason: "cancelled" });
      })
      .connect(acp.ndJsonStream(toClient.writable, toAgent.readable));
    seam.connection = acp.client({ name: "controlled-boundary-host" })
      .onNotification(acp.methods.client.session.update, ({ params }) => seam.update(params))
      .connect(acp.ndJsonStream(toAgent.writable, toClient.readable));
    seam.configOptions = [{ id: "model", category: "model", name: "Model", type: "select", currentValue: model.id,
      options: [{ value: model.id, name: model.name }] }];
    live.models = [{ id: model.id, name: model.name }];
    live.selectedModel = model.id;
    live.runner = { evidence: { version: "1.5.10", workers: [] }, async stop() {
      return { status: "stopped", generation: "no-generation", workers: [], errors: [] };
    } } as unknown as SessionController["runner"];
    client = new Client({ name: "boundary-mcp-peer", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(live.bridge.url), {
      requestInit: { headers: { Authorization: `Bearer ${live.bridge.token}` } },
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1, maxReconnectionDelay: 1, reconnectionDelayGrowFactor: 1 },
    }));
    await client.listTools();
    live.phase = "idle";
    opened.resolve(live);
    return live;
  };
  async function waitFor(predicate: (live: SessionController) => boolean) {
    const deadline = new AbortController();
    try {
      await bounded((async () => {
        const live = await opened.promise;
        for (;;) {
          const version = live.version;
          if (predicate(live)) return;
          deadline.signal.throwIfAborted();
          await live.wait(version, deadline.signal);
        }
      })(), "Controller activity");
    } finally { deadline.abort(); }
  }
  function call(index: number) {
    const result = client!.callTool({ name: "read", arguments: { index } });
    // Observe revocation without converting the caller's real result into success.
    rpcResults.push(result.then(value => ({ value }), error => ({ error })));
    return result;
  }
  function toolResult(response: AssistantMessage, text: string): ToolResultMessage {
    const call = response.content.find(block => block.type === "toolCall");
    assert(call?.type === "toolCall", "Provider did not dispatch the expected real MCP call");
    return { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text }], isError: false, timestamp: 2 };
  }
  function stream(messages: Context["messages"], signal?: AbortSignal) {
    return runtime.stream(model, { messages, tools }, { sessionId, signal }).result();
  }
  async function start(signal?: AbortSignal) {
    const firstResponse = stream([initial]);
    await bounded(received[0]!.promise, "Owner ACP prompt");
    const original = call(1);
    const first = await bounded(firstResponse, "Original MCP handoff");
    assert.equal(first.stopReason, "toolUse");
    assert.deepEqual(dispatched.map(call => call.arguments), [{ index: 1 }]);
    const result = toolResult(first, "original actual OMP result");
    const history = [initial, first, result, boundary];
    const continuation = stream(history, signal);
    const candidate = await bounded(received[1]!.promise, "Boundary ACP prompt");
    await waitFor(live => live.bridge.deliveredCount === 1);
    assert.deepEqual((await bounded(original, "Original HTTP result")).content, result.content);
    assert.equal(controller!.hasCandidate, true);
    assert.deepEqual(completedIds, [result.toolCallId]);
    return { history, continuation, candidate, result };
  }
  return {
    runtime, records, flights, completedIds, dispatched, start, stream, call, waitFor, toolResult,
    get openings() { return openings; },
    get controller() { return controller!; },
    get peer() { return peer!; },
    get sawNextQueuedAfterDelivery() { return sawNextQueuedAfterDelivery; },
    async close() {
      try {
        await runtime.stop("Boundary steering fixture cleanup");
        // Also dispose a partially initialized fixture if opening failed.
        await controller?.stop(new Error("Boundary steering bootstrap cleanup"));
        for (const flight of flights) flight.resolve({ stopReason: "cancelled" });
        peer?.close();
        await client?.close();
        await Promise.all(rpcResults);
      } finally { SessionController.open = originalOpen; }
    },
  };
}