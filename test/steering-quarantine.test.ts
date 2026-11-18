import { expect, spyOn, test } from "bun:test";
import type { PromptResponse } from "@agentclientprotocol/sdk";
import type { Model, UserMessage } from "@oh-my-pi/pi-ai";
import { LiveSteeringChannel } from "@oh-my-pi/pi-agent-core/live-steering";
import { SessionController } from "../src/controller.ts";
import { ProviderRuntime, type SteeringQuarantineRecord } from "../src/provider.ts";
import { readConfig } from "../src/config.ts";
interface Flight { promise: Promise<PromptResponse>; resolve(response: PromptResponse): void }
interface ControllerSeam { connection: { agent: { request(): Promise<PromptResponse>; notify(): Promise<void> }; close(): void }; flights: Map<number, Promise<void>> }

const initial: UserMessage = { role: "user", content: "controlled owner", timestamp: 0 };
const unknown: UserMessage = { role: "user", content: "controlled receipt depends on original MCP result", timestamp: 1 };
const model: Model = { id: "gemini-4-argon", name: "Controlled no-generation", identity: { class: "unknown" }, compat: undefined,
  api: "omp-agy-acp", provider: "omp-agy", baseUrl: "acp://fixture", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 400000, maxTokens: 8192 };
const record: SteeringQuarantineRecord = { version: 1, sessionId: "origin-host", messages: [unknown], reason: "no official receipt", recordedAt: 2 };

function unknownReceiptActivation(stop: () => Promise<void> = async () => {}) {
  const flights: Flight[] = [];
  const state: { pending: number; revoked: boolean; live?: SessionController } = { pending: 0, revoked: false };
  const open = spyOn(SessionController, "open").mockImplementation(async (config, _tools, callbacks = {}) => {
    const controller = Reflect.construct(SessionController, [config, callbacks]) as SessionController;
    const seam = controller as unknown as ControllerSeam;
    seam.connection = { agent: { request() {
      const flight = Promise.withResolvers<PromptResponse>(); flights.push(flight);
      if (flights.length === 2) state.pending = 1;
      return flight.promise;
    }, async notify() {} }, close() {} };
    // Replace external bridge/runner lifecycles only; provider and controller own UNKNOWN.
    controller.bridge = { beginTurn() {}, get pendingCount() { return state.pending; }, async revoke() { state.revoked = true; state.pending = 0; } } as unknown as SessionController["bridge"];
    controller.runner = { evidence: { version: "1.5.10", workers: [] }, async stop() {
      await stop(); return { status: "stopped", generation: "no-generation", workers: [], errors: [] };
    } } as unknown as SessionController["runner"];
    controller.selectModel = async id => { controller.selectedModel = id; };
    controller.selectThinking = async () => {};
    controller.models = [{ id: model.id, name: model.name }];
    controller.phase = "idle"; controller.sessionId = "controlled-no-generation"; state.live = controller; return controller;
  });
  return { open, flights, state };
}

test("sent live input at MCP receipt dependency terminates unknown without host acceptance or AGY replay", async () => {
  const { open, flights, state } = unknownReceiptActivation();
  let taken = false;
  const channel = new LiveSteeringChannel({ async wait() {}, async take() { if (taken) return []; taken = true; return [unknown]; }, async toProvider() { return [unknown]; } });
  const runtime = new ProviderRuntime(readConfig({})); const records: SteeringQuarantineRecord[] = [];
  runtime.onUncertainSteering = value => { records.push(value); };
  try {
    const first = await runtime.stream(model, { messages: [initial] }, { sessionId: "controlled-host", liveSteering: channel }).result();
    const sent = flights.length;
    expect(runtime.syncSteeringQuarantine(records, "different-host")).toBe(true);
    // An empty current-branch snapshot cannot erase a live UNKNOWN that was
    // reported to the host but has not been observed in persisted history.
    expect(runtime.syncSteeringQuarantine([], "controlled-host")).toBe(true);
    const dirty = await runtime.stream(model, { messages: [initial] }, { sessionId: "controlled-host" }).result();
    expect(dirty.errorMessage).toContain("Automatic replay is blocked");
    const retry = await runtime.stream(model, { messages: [initial, first, unknown] }, { sessionId: "controlled-host" }).result();
    expect(first.stopReason).toBe("error"); expect(first.errorMessage).toContain("MCP tool handoff");
    expect(channel.accepted).toEqual([]); expect(channel.deferred).toEqual([]);
    expect(records).toHaveLength(1); expect(records[0]).toMatchObject({ sessionId: "controlled-host", messages: [unknown] });
    expect(state.revoked).toBe(true); expect(state.pending).toBe(0); expect(state.live?.phase).toBe("stopped");
    expect(retry.errorMessage).toContain("quarantined"); expect(flights).toHaveLength(sent);
  } finally {
    open.mockRestore();
    for (const flight of flights) flight.resolve({ stopReason: "cancelled" });
    await state.live?.stop(new Error("controlled no-generation fixture cleanup"));
  }
});

test("UNKNOWN survives branch marker removal both during and after its originating operation", async () => {
  const stopping = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  const { open, flights, state } = unknownReceiptActivation(async () => { stopping.resolve(); await release.promise; });
  const runtime = new ProviderRuntime(readConfig({})); const records: SteeringQuarantineRecord[] = [];
  runtime.onUncertainSteering = value => { records.push(value); };
  let taken = false;
  const channel = new LiveSteeringChannel({ async wait() {}, async take() { if (taken) return []; taken = true; return [unknown]; }, async toProvider() { return [unknown]; } });
  const first = runtime.stream(model, { messages: [initial] }, { sessionId: "in-flight-host", liveSteering: channel }).result();
  try {
    await stopping.promise;
    expect(records).toHaveLength(1);
    expect(runtime.syncSteeringQuarantine(records, "in-flight-host")).toBe(true);
    expect(runtime.syncSteeringQuarantine([], "in-flight-host")).toBe(true);
    const blocked = await runtime.stream(model, { messages: [unknown] }, { sessionId: "in-flight-host",
      codexCompaction: { operationId: "quarantine-fence", trigger: "manual", reason: "user_requested", phase: "standalone_turn", strategy: "memento", implementation: "responses" },
    }).result();
    expect(blocked.errorMessage).toContain("quarantined"); expect(open).toHaveBeenCalledTimes(1);
    expect(channel.accepted).toEqual([]); expect(channel.deferred).toEqual([]);
    release.resolve(); expect((await first).stopReason).toBe("error");
    const dirty = await runtime.stream(model, { messages: [initial] }, { sessionId: "in-flight-host" }).result();
    expect(dirty.errorMessage).toContain("Automatic replay is blocked");
    // The input can survive a rewind before its later custom marker, or remain
    // in the host steering queue. Settling the operation never authorizes it.
    const retained = await runtime.stream(model, { messages: [unknown] }, { sessionId: "in-flight-host" }).result();
    expect(retained.errorMessage).toContain("quarantined"); expect(open).toHaveBeenCalledTimes(1);
    open.mockRejectedValue(new Error("Healthy branch reached ACP admission"));
    const fresh: UserMessage = { role: "user", content: "fresh authorized branch task", timestamp: 3 };
    const admitted = await runtime.stream(model, { messages: [fresh] }, { sessionId: "in-flight-host" }).result();
    expect(admitted.errorMessage).toBe("Healthy branch reached ACP admission"); expect(open).toHaveBeenCalledTimes(2);
  } finally {
    release.resolve(); for (const flight of flights) flight.resolve({ stopReason: "cancelled" });
    await first; await state.live?.stop(new Error("controlled in-flight fixture cleanup")); open.mockRestore();
  }
});

test("active-branch snapshots replace invalid flags while exact UNKNOWN identities remain quarantined", async () => {
  const open = spyOn(SessionController, "open").mockRejectedValue(new Error("Healthy branch reached ACP admission"));
  try {
    const runtime = new ProviderRuntime(readConfig({}));
    expect(runtime.syncSteeringQuarantine([record], "branch-host")).toBe(true);
    expect((await runtime.stream(model, { messages: [unknown] }, { sessionId: "branch-host" }).result()).errorMessage).toContain("quarantined");
    expect(runtime.syncSteeringQuarantine([null, record], "branch-host")).toBe(false);
    expect(runtime.syncSteeringQuarantine([null], "other-host")).toBe(false);
    expect((await runtime.stream(model, { messages: [initial] }, { sessionId: "branch-host" }).result()).errorMessage).toContain("quarantine is invalid");
    expect(open).not.toHaveBeenCalled();
    expect(runtime.syncSteeringQuarantine([], "branch-host")).toBe(true);
    expect((await runtime.stream(model, { messages: [unknown] }, { sessionId: "branch-host" }).result()).errorMessage).toContain("quarantined");
    expect((await runtime.stream(model, { messages: [initial] }, { sessionId: "branch-host" }).result()).errorMessage).toBe("Healthy branch reached ACP admission");
    expect((await runtime.stream(model, { messages: [initial] }, { sessionId: "other-host" }).result()).errorMessage).toContain("quarantine is invalid");
    expect(open).toHaveBeenCalledTimes(1);
    // Re-observing an inherited record is idempotent, not permission to replay.
    expect(runtime.syncSteeringQuarantine([record], "branch-host")).toBe(true);
    expect((await runtime.stream(model, { messages: [unknown] }, { sessionId: "branch-host" }).result()).errorMessage).toContain("quarantined");
    expect(open).toHaveBeenCalledTimes(1);
  } finally { open.mockRestore(); }
});

test("restored exact unknown input is blocked before activation, including inherited branch history", async () => {
  const open = spyOn(SessionController, "open").mockRejectedValue(new Error("must not open"));
  try {
    const runtime = new ProviderRuntime(readConfig({}));
    expect(runtime.syncSteeringQuarantine([JSON.parse(JSON.stringify(record))], "branch-host")).toBe(true);
    const response = await runtime.stream(model, { messages: [initial, unknown] }, { sessionId: "branch-host" }).result();
    expect(response.errorMessage).toContain("quarantined"); expect(open).not.toHaveBeenCalled();
  } finally { open.mockRestore(); }
});

test("fresh explicit input can resume while only exact unknown originals are omitted from AGY reconstruction", async () => {
  const fresh: UserMessage = { role: "user", content: "new explicitly authorized task", timestamp: 3 };
  const repeatedText: UserMessage = { ...unknown, timestamp: 4 };
  let promptText = "";
  const open = spyOn(SessionController, "open").mockImplementation(async config => {
    const controller = Reflect.construct(SessionController, [config, {}]) as SessionController;
    const seam = controller as unknown as ControllerSeam;
    seam.connection = { agent: { async request() { return { stopReason: "end_turn" }; }, async notify() {} }, close() {} };
    // This no-tool bridge supplies only the external turn lifecycle exercised here.
    controller.bridge = { beginTurn() {}, endTurn() {}, pendingCount: 0, async revoke() {} } as unknown as SessionController["bridge"];
    controller.runner = { evidence: { version: "1.5.10" } } as SessionController["runner"];
    controller.models = [{ id: model.id, name: model.name }]; controller.phase = "idle";
    controller.selectModel = async id => { controller.selectedModel = id; }; controller.selectThinking = async () => {};
    const begin = controller.begin.bind(controller);
    controller.begin = prompt => { promptText = prompt.filter(block => block.type === "text").map(block => block.text).join(""); begin(prompt); };
    return controller;
  });
  try {
    const runtime = new ProviderRuntime(readConfig({})); runtime.syncSteeringQuarantine([record], "branch-host");
    const messages = [initial, unknown, fresh];
    const response = await runtime.stream(model, { messages }, { sessionId: "branch-host" }).result();
    expect(response.stopReason).toBe("stop"); expect(promptText).toContain(String(fresh.content));
    expect(promptText).not.toContain(String(unknown.content)); expect(messages).toEqual([initial, unknown, fresh]);
    // Fresh input never releases the original identity's persistent quarantine.
    const retry = await runtime.stream(model, { messages: [initial, unknown] }, { sessionId: "branch-host" }).result();
    expect(retry.errorMessage).toContain("quarantined"); expect(open).toHaveBeenCalledTimes(1);
    const nextRuntime = new ProviderRuntime(readConfig({})); nextRuntime.syncSteeringQuarantine([record], "branch-host");
    expect((await nextRuntime.stream(model, { messages: [repeatedText] }, { sessionId: "branch-host" }).result()).stopReason).toBe("stop");
    expect(promptText).toContain(String(repeatedText.content));
    const otherSession = new ProviderRuntime(readConfig({})); otherSession.syncSteeringQuarantine([record], "branch-host");
    expect((await otherSession.stream(model, { messages: [unknown] }, { sessionId: "unrelated-host" }).result()).stopReason).toBe("stop");
    // A cold runtime may reopen before the custom marker. Valid whole-tree
    // history still fences UNKNOWN, while malformed abandoned records do not.
    const coldRuntime = new ProviderRuntime(readConfig({}));
    expect(coldRuntime.syncSteeringQuarantine([], "branch-host", [null, { ...record, version: 2 }, record])).toBe(true);
    expect((await coldRuntime.stream(model, { messages }, { sessionId: "branch-host" }).result()).stopReason).toBe("stop");
    expect(promptText).toContain(String(fresh.content)); expect(promptText).not.toContain(String(unknown.content));
    const blockedCold = await coldRuntime.stream(model, { messages: [unknown] }, { sessionId: "branch-host" }).result();
    expect(blockedCold.errorMessage).toContain("quarantined"); expect(open).toHaveBeenCalledTimes(4);
  } finally { open.mockRestore(); }
});

test("invalid saved quarantine fails closed without opening an ACP activation", async () => {
  const open = spyOn(SessionController, "open").mockRejectedValue(new Error("must not open"));
  try {
    for (const invalid of [null, { ...record, version: 2 }, { ...record, messages: [{ role: "user", timestamp: 1, content: [{ type: "image", data: 7 }] }] }]) {
      const runtime = new ProviderRuntime(readConfig({}));
      expect(runtime.syncSteeringQuarantine([invalid], "corrupt-host")).toBe(false);
      const response = await runtime.stream(model, { messages: [initial] }, { sessionId: "corrupt-host" }).result();
      expect(response.errorMessage).toContain("quarantine is invalid");
    }
    expect(open).not.toHaveBeenCalled();
  } finally { open.mockRestore(); }
});

test("normal boundary steering completes its original MCP result before awaiting dependent receipt", async () => {
  const flights: Flight[] = []; let pending = 0; let dispatched = false; let completed = 0; let revoked = 0;
  let live: SessionController | undefined;
  const open = spyOn(SessionController, "open").mockImplementation(async (config, _tools, callbacks = {}) => {
    const controller = Reflect.construct(SessionController, [config, callbacks]) as SessionController;
    const seam = controller as unknown as ControllerSeam;
    seam.connection = { agent: { request() {
      const flight = Promise.withResolvers<PromptResponse>(); flights.push(flight);
      if (flights.length === 1) pending = 1;
      return flight.promise;
    }, async notify() {} }, close() {} };
    controller.bridge = { beginTurn() {}, endTurn() {}, get pendingCount() { return pending; },
      takeNext() { if (dispatched || !pending) return; dispatched = true; return { id: "original-mcp", name: "read", arguments: {} }; },
      async complete() { completed++; pending = 0; for (const flight of flights) flight.resolve({ stopReason: "end_turn" }); },
      async revoke() { revoked++; pending = 0; },
    } as unknown as SessionController["bridge"];
    controller.runner = { evidence: { version: "1.5.10", workers: [] }, async stop() { return { status: "stopped", generation: "no-generation", workers: [], errors: [] }; } } as unknown as SessionController["runner"];
    controller.models = [{ id: model.id, name: model.name }]; controller.phase = "idle";
    controller.selectModel = async id => { controller.selectedModel = id; }; controller.selectThinking = async () => {};
    live = controller; return controller;
  });
  try {
    const runtime = new ProviderRuntime(readConfig({}));
    const first = await runtime.stream(model, { messages: [initial] }, { sessionId: "boundary-host" }).result();
    expect(first.stopReason).toBe("toolUse"); expect(completed).toBe(0);
    const boundary: UserMessage = { role: "user", content: "boundary input during original read", timestamp: 2 };
    const response = await runtime.stream(model, { messages: [initial, first,
      { role: "toolResult", toolCallId: "original-mcp", toolName: "read", content: [{ type: "text", text: "original actual result" }], isError: false, timestamp: 3 }, boundary,
    ] }, { sessionId: "boundary-host" }).result();
    expect(response.stopReason).toBe("stop"); expect(open).toHaveBeenCalledTimes(1);
    expect(completed).toBe(1); expect(flights).toHaveLength(2); expect(revoked).toBe(0);
    expect(live?.counters.steeringAccepted).toBe(1); expect(live?.counters.steeringUncertain).toBe(0);
  } finally {
    open.mockRestore(); for (const flight of flights) flight.resolve({ stopReason: "cancelled" });
    await live?.stop(new Error("controlled boundary fixture cleanup"));
  }
});

test("false or throwing host persistence callbacks never release an unpersisted UNKNOWN", async () => {
  for (const throws of [false, true]) {
    const { open, flights, state } = unknownReceiptActivation();
    const runtime = new ProviderRuntime(readConfig({}));
    runtime.onUncertainSteering = () => { if (throws) throw new Error("Host persistence unavailable"); return false; };
    let taken = false;
    const channel = new LiveSteeringChannel({ async wait() {}, async take() { if (taken) return []; taken = true; return [unknown]; }, async toProvider() { return [unknown]; } });
    try {
      const first = await runtime.stream(model, { messages: [initial] }, { sessionId: "unpersisted-host", liveSteering: channel }).result();
      expect(first.stopReason).toBe("error");
      if (throws) expect(first.errorMessage).toContain("Host persistence unavailable");
      expect(runtime.syncSteeringQuarantine([], "unpersisted-host")).toBe(true);
      const retry = await runtime.stream(model, { messages: [unknown] }, { sessionId: "unpersisted-host" }).result();
      expect(retry.errorMessage).toContain("quarantined"); expect(open).toHaveBeenCalledTimes(1);
      expect(channel.accepted).toEqual([]); expect(channel.deferred).toEqual([]);
    } finally {
      for (const flight of flights) flight.resolve({ stopReason: "cancelled" });
      await state.live?.stop(new Error("controlled persistence fixture cleanup")); open.mockRestore();
    }
  }
});
