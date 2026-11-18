import { expect, test } from "bun:test";
import * as acp from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Agent, type AgentUpdate, type CleanupReport, type RunnerEvidence, type RunnerFactory, type ToolDefinition, type TrustedResult } from "../core.ts";

const tools: ToolDefinition[] = [{ name: "display/greet", description: "Returns a name-based greeting",
  parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false } }];
const greeting = { source: "content", isError: false, content: [{ type: "text", text: "Hello Ada" }] } satisfies TrustedResult;

/** Both SDKs and the production controller/bridge are real. Only the producer is replaced. */
function fakeRunner() {
  const sessionId = "standalone-fixture-session";
  const evidence: RunnerEvidence = { generation: "standalone-fixture", version: "fixture", workspace: "/fixture",
    gateway: "127.0.0.1", sourceAddress: "127.0.0.1", distribution: "", user: "", uid: 0, gid: 0, groups: "", home: "", cli: "",
    kernel: "", mounts: "", sharedDirectories: "", interop: "", permissions: "", route: "", windowsInterface: "", cleanupReceiptPath: "",
    stderr: "", stderrTruncated: false, workers: [] };
  const cleanup: CleanupReport = { status: "stopped", generation: evidence.generation, workers: [], errors: [] };
  const toAgent = new TransformStream<Uint8Array, Uint8Array>();
  const toHost = new TransformStream<Uint8Array, Uint8Array>();
  const exited = Promise.withResolvers<number>();
  let stops = 0;
  let stopPromise: Promise<CleanupReport> | undefined;
  let peer: acp.AgentConnection | undefined;
  let mcp: Client | undefined;
  const stop = () => stopPromise ??= (async () => {
    stops++;
    peer?.close();
    await mcp?.close();
    exited.resolve(0);
    return cleanup;
  })();
  const bootstrap: RunnerFactory = async (_config, signal) => {
    signal?.throwIfAborted();
    return {
      gateway: evidence.gateway, sourceAddress: evidence.sourceAddress, workspace: evidence.workspace, evidence, stop,
      async startUsage() { throw new Error("Standalone ACP must not use the runner's quota path"); },
      async start({ url, token, aliases }) {
        mcp = new Client({ name: "fixture-mcp-client", version: "1" });
        const transport = new StreamableHTTPClientTransport(new URL(url), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
          reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1, maxReconnectionDelay: 1, reconnectionDelayGrowFactor: 1 },
        });
        await mcp.connect(transport);
        expect((await mcp.listTools()).tools.map(tool => tool.name)).toEqual([...aliases]);
        peer = acp.agent({ name: "fixture-acp-agent" })
          .onRequest(acp.methods.agent.initialize, () => ({ protocolVersion: acp.PROTOCOL_VERSION,
            agentCapabilities: { mcpCapabilities: { http: true } } }))
          .onRequest(acp.methods.agent.session.new, () => ({ sessionId, configOptions: [{
            id: "model", category: "model", name: "Model", type: "select", currentValue: "fixture-model",
            options: [{ value: "fixture-model", name: "Fixture" }],
          }] }))
          .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
            expect(params.prompt).toEqual([{ type: "text", text: "Please greet Ada" }]);
            const options = [{ optionId: "allowed", name: "Allow once", kind: "allow_once" },
              { optionId: "denied", name: "Reject once", kind: "reject_once" }] as const;
            const requestPermission = (toolCall: acp.ToolCallUpdate) => client.request(acp.methods.client.session.requestPermission,
              { sessionId, options: [...options], toolCall });
            const native = await requestPermission({ toolCallId: "native", title: "Looks like a bridge tool", name: "native_tool" });
            expect(native).toMatchObject({ outcome: { outcome: "selected", optionId: "denied" } });
            const tool = { toolCallId: "bridge", title: "Greeting", name: `mcp_omp_agy_bridge_${aliases[0]}` };
            await client.notify(acp.methods.client.session.update, { sessionId, update: { sessionUpdate: "tool_call", ...tool } });
            await client.notify(acp.methods.client.session.update, { sessionId, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Greeting:" } } });
            const allowed = await requestPermission(tool);
            expect(allowed).toMatchObject({ outcome: { outcome: "selected", optionId: "allowed" } });
            const result = await mcp!.callTool({ name: aliases[0]!, arguments: { name: "Ada" } });
            expect(result.content).toEqual(greeting.content);
            const [first] = result.content as { type: string; text?: string }[];
            if (first?.type !== "text" || typeof first.text !== "string") throw new Error("Unexpected greeting result");
            await client.notify(acp.methods.client.session.update, { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: first.text } } });
            return { stopReason: "end_turn" };
          })
          .connect(acp.ndJsonStream(toHost.writable, toAgent.readable));
        return { evidence, exited: exited.promise, stdin: toAgent.writable, stdout: toHost.readable, stop };
      },
    };
  };
  return { bootstrap, stop, get stops() { return stops; } };
}

for (const manual of [false, true]) {
  test(`standalone session streams and returns an authenticated tool result (${manual ? "manual" : "callback"})`, async () => {
    const runner = fakeRunner();
    let calls = 0;
    const agent = await Agent.open({ bootstrap: runner.bootstrap, tools, signal: AbortSignal.timeout(4000),
      executeTool: manual ? undefined : (call, signal) => {
        expect(signal.aborted).toBe(false);
        expect(call.name).toBe("display/greet");
        expect(call.arguments).toEqual({ name: "Ada" });
        calls++;
        return greeting;
      },
    });
    try {
      expect(agent.selectedModel).toBe("fixture-model");
      expect(agent.catalog.originalToAlias.has("display/greet")).toBe(true);
      agent.send("Please greet Ada", { signal: AbortSignal.timeout(4000) });
      const updates: AgentUpdate[] = [];
      for await (const update of agent.receive()) {
        updates.push(update);
        if (manual && update.type === "tool_call") {
          expect(update.call.name).toBe("display/greet");
          expect(update.call.arguments).toEqual({ name: "Ada" });
          calls++;
          await agent.complete(update.call.id, greeting);
          await expect(agent.complete(update.call.id, greeting)).rejects.toThrow("Unknown");
        }
      }
      expect(calls).toBe(1);
      expect(updates.map(update => update.type)).toEqual(["thinking", "tool_call", "text", "done"]);
      expect(updates.slice(-2)).toEqual([{ type: "text", text: "Hello Ada" }, { type: "done", stopReason: "end_turn" }]);
    } finally { await agent.close(); }
    await agent.close();
    expect(agent.cleanup?.status).toBe("stopped");
    expect(runner.stops).toBe(1);
  }, 10_000);
}

test("breaking the receive iterator revokes pending tool work and closes the adapter", async () => {
  const runner = fakeRunner();
  const agent = await Agent.open({ bootstrap: runner.bootstrap, tools, signal: AbortSignal.timeout(4000) });
  try {
    agent.send("Please greet Ada", { signal: AbortSignal.timeout(4000) });
    for await (const update of agent.receive()) {
      if (update.type === "tool_call") break;
    }
    expect(agent.cleanup?.status).toBe("stopped");
    expect(() => agent.send("Do not replay")).toThrow("stopped");
  } finally { await agent.close(); }
  expect(runner.stops).toBe(1);
}, 10_000);
