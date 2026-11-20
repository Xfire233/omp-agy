import { describe, expect, spyOn, test } from "bun:test";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { LiveSteeringChannel } from "@oh-my-pi/pi-agent-core/live-steering";
import { Effort, type Message, type Model, type SimpleStreamOptions, type ToolResultMessage, type UserMessage } from "@oh-my-pi/pi-ai";
import type { Bridge, PendingCall } from "../src/bridge.ts";
import { readConfig } from "../src/config.ts";
import { ActivationCleanupError, SessionController, type AdvertisedModel, type ControllerCallbacks, type ControllerEvent } from "../src/controller.ts";
import { ProviderRuntime } from "../src/provider.ts";
import * as runnerModule from "../src/runner.ts";
import { resolveContextWindow } from "../src/context-limits.ts";
import { ThinkingSelectionError, type SteeringReceipt, type ThoughtOptions } from "../src/protocol.ts";
import { clampProviderContextImages } from "@oh-my-pi/pi-coding-agent/session/provider-image-budget";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { DateCwdReminderInjector } from "@oh-my-pi/pi-coding-agent/session/date-cwd-reminder";

const model: Model = { id: "gemini-4-argon", name: "Controlled lifecycle fixture", identity: { class: "unknown" }, compat: undefined,
  api: "omp-agy-acp", provider: "omp-agy", baseUrl: "acp://fixture", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 400000, maxTokens: 8192 };
const initial: UserMessage = { role: "user", content: "initial explicit task", timestamp: 1 };
const steer: UserMessage = { role: "user", content: "confirmed native steering", steering: true, timestamp: 2 };
const result: ToolResultMessage = { role: "toolResult", toolCallId: "pending", toolName: "read", content: [{ type: "text", text: "actual tool result" }], isError: false, timestamp: 3 };
const call: PendingCall = { id: "pending", name: "read", arguments: {} };
function liveSteering() {
  let taken = false;
  return new LiveSteeringChannel({
    async wait() {},
    async take() { if (taken) return []; taken = true; return [steer]; },
    async toProvider() { return [steer]; },
  });
}

const thoughtOptions = (currentValue = "medium", values = ["low", "medium", "high"]): ThoughtOptions => ({
  configId: "thought_level", currentValue, options: values.map(value => ({ value, name: value === "xhigh" ? "Extra" : value })),
});

/** Controlled external ACP seam; provider, ledger and canonical event stream are the real implementations. */
class ControlledController {
  phase: SessionController["phase"] = "idle";
  failure?: Error;
  capabilities = {};
  runner = { evidence: { version: "1.5.10" } };
  selectedModel?: string = model.id;
  contextUsage?: SessionController["contextUsage"];
  models: AdvertisedModel[] = [{ id: "gemini-4-argon", name: "Published fixture model" }, { id: "gemini-4-hydrogen", name: "Requested nondefault model" }];
  modelContextWindows?: ReadonlyMap<string, number>;
  thinking?: ThoughtOptions;
  thinkingCalls: (string | undefined)[] = [];
  beginThinking: (string | undefined)[] = [];
  discoveryCalls = 0;
  callbacks: ControllerCallbacks = {};
  counters = { providerInvocations: 0 };
  events: ControllerEvent[] = [];
  activeFlights = 0;
  hasCandidate = false;
  stopReason = "end_turn" as const;
  version = 0;
  private progress = Promise.withResolvers<void>();
  beginCalls = 0;
  selectCalls = 0;
  stopCalls = 0;
  completionCalls = 0;
  tool = false;
  holdForSteering = false;
  dispatched = false;
  pending = 0;
  delivered = 0;
  revoked = false;
  bridge: Bridge = {
    url: "http://fixture.invalid/mcp", token: "fixture-not-a-credential", aliases: ["read"],
    catalog: { tools: [], aliases: ["read"], originalToAlias: new Map(), aliasToOriginal: new Map(),
      resolve: alias => alias === "read" ? "read" : undefined, validate: (_alias, _value): asserts _value is Record<string, unknown> => {} },
    get pendingCount() { return 0; }, get deliveredCount() { return 0; },
    beginTurn: () => {}, endTurn: () => {}, takeNext: () => undefined,
    complete: async (id, _result) => {
      if (id !== "pending") throw new Error("Wrong original handler identity");
      this.completionCalls++; this.pending = 0; this.delivered++;
      this.events.push({ type: "text", text: "AGY completed after original handler result" });
    },
    revoke: async () => { this.revoked = true; },
    snapshot: () => ({ accepting: !this.revoked, revoked: this.revoked, initialized: true, catalogReadCount: 1, activeTurn: this.phase === "active",
      sessionCount: this.revoked ? 0 : 1, connections: 0, pendingCount: this.pending, queuedCount: this.pending,
      dispatchedCount: this.dispatched && this.pending ? 1 : 0, deliveringCount: 0, deliveredCount: this.delivered }),
  };
  constructor() {
    Object.defineProperties(this.bridge, {
      pendingCount: { get: () => this.pending }, deliveredCount: { get: () => this.delivered },
    });
  }
  async selectModel(id: string) { this.selectCalls++; this.selectedModel = id; }
  async discoverModelOptions(): Promise<AdvertisedModel[]> {
    if (this.phase !== "idle") throw new Error("Discovery must finish before cleanup");
    this.discoveryCalls++;
    return this.models.map(model => ({ ...model }));
  }
  async selectThinking(options: Pick<SimpleStreamOptions, "reasoning" | "disableReasoning">): Promise<void> {
    if (this.phase !== "idle") throw new Error("Thinking cannot change an active ACP turn");
    const requested = options.disableReasoning ? "off" : options.reasoning;
    this.thinkingCalls.push(requested);
    if (requested === undefined) return;
    if (!this.thinking?.options.some(option => option.value === requested)) throw new ThinkingSelectionError(`Unsupported live thinking request ${requested}; no prompt submitted`);
    this.thinking = { ...this.thinking, currentValue: requested };
  }
  begin(_prompt: ContentBlock[]) {
    this.beginCalls++; this.phase = "active";
    this.beginThinking.push(this.thinking?.currentValue);
    if (this.holdForSteering) { this.activeFlights = 1; return; }
    this.emitOutput();
  }
  async steer(_prompt: ContentBlock[], receipt?: SteeringReceipt) {
    if (!this.activeFlights) throw new Error("No active flight for steering");
    receipt?.onReceived?.();
    this.holdForSteering = false; this.activeFlights = 0;
    this.emitOutput(); this.wake();
  }
  private emitOutput() {
    if (this.tool) this.pending = 1;
    else this.events.push({ type: "text", text: "Original completed AGY answer" });
  }
  shiftEvent() { return this.events.shift(); }
  takeNext() { if (!this.pending || this.dispatched) return undefined; this.dispatched = true; return call; }
  finishTurn() { if (this.pending) throw new Error("Pending handler not completed"); this.phase = "idle"; }
  async wait(version: number, signal?: AbortSignal): Promise<void> {
    if (!this.activeFlights) throw new Error("Unexpected wait in deterministic lifecycle fixture");
    if (version === this.version && !signal?.aborted) await this.progress.promise;
  }
  wake() {
    this.version++; this.progress.resolve(); this.progress = Promise.withResolvers<void>();
  }
  async stop() { this.stopCalls++; this.phase = "stopped"; this.revoked = true; }
  snapshot() { return { phase: this.phase }; }
  async fail(error: Error) { this.failure = error; this.callbacks.failed?.(error); await this.stop(); }
}

describe("provider lifecycle regressions", () => {
  test("display state exposes only the actual live bound controller without discovery snapshots", async () => {
    const discovered = new ControlledController(); discovered.contextUsage = { used: 99, size: 100 };
    const live = new ControlledController(); live.tool = true; let index = 0;
    const open = spyOn(SessionController, "open").mockImplementation(async () => [discovered, live][index++] as unknown as SessionController);
    try {
      const runtime = new ProviderRuntime(readConfig({})); expect(runtime.displayState()).toBeUndefined();
      await runtime.discover(); expect(runtime.displayState()).toBeUndefined();
      const first = await runtime.stream(model, { messages: [initial] }, { sessionId: "visible-session" }).result();
      live.contextUsage = { used: 2500, size: 400000 };
      live.snapshot = () => { throw new Error("Display must never allocate full controller snapshots"); };
      const active = runtime.displayState();
      expect(active).toMatchObject({ phase: "active", sessionId: "visible-session", modelId: model.id, contextUsage: { used: 2500, size: 400000 } });
      expect(Number.isSafeInteger(active!.generation)).toBe(true); expect(active!.contextUsage).toBe(live.contextUsage);
      expect((await runtime.stream(model, { messages: [initial, first, result] }, { sessionId: "visible-session" }).result()).stopReason).toBe("stop");
      expect(runtime.displayState()).toMatchObject({ phase: "idle", generation: active!.generation, sessionId: "visible-session", modelId: model.id });
      await runtime.stop("display fixture stopped", false); expect(runtime.displayState()).toBeUndefined();
    } finally { open.mockRestore(); }
  });
  test("default-account replacement never steals a pending MCP result or admits generation during login", async () => {
    const live = new ControlledController(); live.tool = true;
    const open = spyOn(SessionController, "open").mockResolvedValue(live as unknown as SessionController);
    const terminal = Promise.withResolvers<void>();
    try {
      const runtime = new ProviderRuntime(readConfig({}));
      const first = await runtime.stream(model, { messages: [initial] }, { sessionId: "switch" }).result();
      expect(first.stopReason).toBe("toolUse");
      const refused = await runtime.withAccountLogin(async () => "opened").catch((e: Error) => e.message);
      expect(refused).toContain("pending work"); expect(live.stopCalls).toBe(0);
      expect((await runtime.stream(model, { messages: [initial, first, result] }, { sessionId: "switch" }).result()).stopReason).toBe("stop");
      const mounted = Promise.withResolvers<void>();
      const login = runtime.withAccountLogin(async () => { mounted.resolve(); await terminal.promise; });
      await mounted.promise;
      expect(live.stopCalls).toBe(1); expect(live.completionCalls).toBe(1);
      const competing = await runtime.stream(model, { messages: [initial] }, { sessionId: "switch", codexCompaction: {
        operationId: "login-race", trigger: "manual", reason: "user_requested", phase: "standalone_turn", strategy: "memento", implementation: "responses" } }).result();
      expect(competing.stopReason).toBe("error"); expect(open).toHaveBeenCalledTimes(1);
      terminal.resolve(); await login; expect(runtime.displayState()).toBeUndefined();
    } finally { terminal.resolve(); open.mockRestore(); }
  });
  test("discovery awaits model-specific options before cleanup and publishes only live canonical efforts", async () => {
    const controller = new ControlledController(); const discovering = Promise.withResolvers<void>();
    const options = Promise.withResolvers<AdvertisedModel[]>();
    controller.discoverModelOptions = async () => { controller.discoveryCalls++; discovering.resolve(); return options.promise; };
    const open = spyOn(SessionController, "open").mockResolvedValue(controller as unknown as SessionController);
    try {
      const runtime = new ProviderRuntime(readConfig({})); const discovery = runtime.discover();
      await discovering.promise; expect(controller.stopCalls).toBe(0);
      options.resolve([
        { id: model.id, name: "Argon", thinking: thoughtOptions("high", ["high", "low"]) },
        { id: "gemini-4-hydrogen", name: "Hydrogen", thinking: thoughtOptions("xhigh", ["low", "high", "xhigh"]) },
        { id: "gpt-oss-120b-medium", name: "No thought selector" },
      ]);
      const rows = await discovery;
      expect(rows[0]).toMatchObject({ reasoning: true, thinking: { mode: "effort", efforts: ["low", "high"], defaultLevel: "high" } });
      expect(rows[1]).toMatchObject({ reasoning: true, thinking: { mode: "effort", efforts: ["low", "high", "xhigh"], defaultLevel: "xhigh" } });
      expect(rows[2]!.reasoning).toBe(false); expect(rows[2]!.thinking).toBeUndefined();
      expect(controller.discoveryCalls).toBe(1); expect(controller.stopCalls).toBe(1); expect(controller.beginCalls).toBe(0);
    } finally { options.resolve([]); open.mockRestore(); }
  });
  test("idle effort changes use the same activation and omitted effort preserves the live setting", async () => {
    const controller = new ControlledController(); controller.thinking = thoughtOptions();
    const open = spyOn(SessionController, "open").mockResolvedValue(controller as unknown as SessionController);
    try {
      const runtime = new ProviderRuntime(readConfig({}));
      const first = await runtime.stream(model, { messages: [initial] }, { reasoning: Effort.High }).result();
      const next: UserMessage = { ...initial, content: "second task at low effort" };
      const second = await runtime.stream(model, { messages: [initial, first, next] }, { reasoning: Effort.Low }).result();
      const last: UserMessage = { ...initial, content: "third task preserves selected low effort" };
      const third = await runtime.stream(model, { messages: [initial, first, next, second, last] }).result();
      expect([first.stopReason, second.stopReason, third.stopReason]).toEqual(["stop", "stop", "stop"]);
      expect(controller.thinkingCalls).toEqual(["high", "low", undefined]); expect(controller.beginThinking).toEqual(["high", "low", "low"]);
      expect(open).toHaveBeenCalledTimes(1); expect(controller.selectCalls).toBe(1); expect(controller.stopCalls).toBe(0);
      expect(runtime.snapshot().rebuilds).toBe(0);
    } finally { open.mockRestore(); }
  });
  test("unsupported explicit effort, off and missing selectors fail before prompt without fencing clean input", async () => {
    for (const entry of [
      { options: { reasoning: Effort.XHigh }, selector: true },
      { options: { disableReasoning: true }, selector: true },
      { options: { reasoning: Effort.High }, selector: false },
    ] satisfies { options: SimpleStreamOptions; selector: boolean }[]) {
      const rejected = new ControlledController(); if (entry.selector) rejected.thinking = thoughtOptions();
      const accepted = new ControlledController(); accepted.thinking = thoughtOptions(); let index = 0;
      const open = spyOn(SessionController, "open").mockImplementation(async () => [rejected, accepted][index++] as unknown as SessionController);
      try {
        const runtime = new ProviderRuntime(readConfig({}));
        const response = await runtime.stream(model, { messages: [initial] }, entry.options).result();
        expect(response.stopReason).toBe("error"); expect(response.errorMessage).toContain("Unsupported live thinking request");
        expect(rejected.beginCalls).toBe(0); expect(rejected.thinking?.currentValue).toBe(entry.selector ? "medium" : undefined);
        expect(runtime.snapshot().requiresNewInput).toBe(false);
        expect((await runtime.stream(model, { messages: [initial] }, { reasoning: Effort.Low }).result()).stopReason).toBe("stop");
        expect(accepted.beginThinking).toEqual(["low"]); expect(open).toHaveBeenCalledTimes(2);
      } finally { open.mockRestore(); }
    }
  });
  test("idle configuration rejection does not consume the next input or dirty previously completed work", async () => {
    const original = new ControlledController(); original.thinking = thoughtOptions();
    const retried = new ControlledController(); retried.thinking = thoughtOptions(); let index = 0;
    const open = spyOn(SessionController, "open").mockImplementation(async () => [original, retried][index++] as unknown as SessionController);
    try {
      const runtime = new ProviderRuntime(readConfig({}));
      const first = await runtime.stream(model, { messages: [initial] }, { reasoning: Effort.High }).result();
      const next: UserMessage = { ...initial, content: "new task with unsupported effort" };
      const rejected = await runtime.stream(model, { messages: [initial, first, next] }, { reasoning: Effort.XHigh }).result();
      expect(rejected.stopReason).toBe("error"); expect(original.beginCalls).toBe(1); expect(runtime.snapshot().requiresNewInput).toBe(false);
      const response = await runtime.stream(model, { messages: [initial, first, next] }, { reasoning: Effort.Low }).result();
      expect(response.stopReason).toBe("stop"); expect(retried.beginThinking).toEqual(["low"]);
    } finally { open.mockRestore(); }
  });
  test("a changed effort preserves active MCP handoff and takes effect at the next idle begin", async () => {
    const controller = new ControlledController(); controller.tool = true; controller.thinking = thoughtOptions();
    const open = spyOn(SessionController, "open").mockResolvedValue(controller as unknown as SessionController);
    try {
      const runtime = new ProviderRuntime(readConfig({}));
      const first = await runtime.stream(model, { messages: [initial] }, { reasoning: Effort.High }).result();
      const second = await runtime.stream(model, { messages: [initial, first, result] }, { reasoning: Effort.Low }).result();
      expect(first.stopReason).toBe("toolUse"); expect(second.stopReason).toBe("stop");
      expect(controller.completionCalls).toBe(1); expect(controller.thinkingCalls).toEqual(["high"]); expect(controller.beginThinking).toEqual(["high"]);
      expect(controller.thinking?.currentValue).toBe("high"); expect(controller.stopCalls).toBe(0); expect(open).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(runtime.snapshot().diagnostics)).toContain("not applied or confirmed");
      controller.tool = false;
      const next: UserMessage = { ...initial, content: "new idle task after completed original MCP" };
      const third = await runtime.stream(model, { messages: [initial, first, result, second, next] }, { reasoning: Effort.Low }).result();
      expect(third.stopReason).toBe("stop"); expect(controller.beginThinking).toEqual(["high", "low"]);
      expect(controller.completionCalls).toBe(1); expect(controller.stopCalls).toBe(0); expect(open).toHaveBeenCalledTimes(1);
    } finally { open.mockRestore(); }
  });
  test("invalid active thinking metadata is diagnostic-only until the next idle prompt validation", async () => {
    const controller = new ControlledController(); controller.tool = true; controller.thinking = thoughtOptions();
    const open = spyOn(SessionController, "open").mockResolvedValue(controller as unknown as SessionController);
    try {
      const runtime = new ProviderRuntime(readConfig({}));
      const first = await runtime.stream(model, { messages: [initial] }, { reasoning: Effort.High }).result();
      const invalid = new ThinkingSelectionError("Ambiguous live thought selector");
      Object.defineProperty(controller, "thinking", { get() { throw invalid; } });
      const second = await runtime.stream(model, { messages: [initial, first, result] }, { reasoning: Effort.Low }).result();
      expect(first.stopReason).toBe("toolUse"); expect(second.stopReason).toBe("stop");
      expect(controller.completionCalls).toBe(1); expect(controller.pending).toBe(0); expect(controller.revoked).toBe(false);
      expect(controller.stopCalls).toBe(0); expect(controller.thinkingCalls).toEqual(["high"]);
      expect(controller.beginCalls).toBe(1); expect(open).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(runtime.snapshot().diagnostics)).toContain(invalid.message);
      expect(JSON.stringify(runtime.snapshot().diagnostics)).toContain("not applied or confirmed");
      const next: UserMessage = { ...initial, content: "new idle task must validate the invalid selector" };
      const rejected = await runtime.stream(model, { messages: [initial, first, result, second, next] }, { reasoning: Effort.Low }).result();
      expect(rejected.stopReason).toBe("error"); expect(rejected.errorMessage).toContain(invalid.message);
      expect(controller.beginCalls).toBe(1); expect(controller.thinkingCalls).toEqual(["high", "low"]);
      expect(runtime.snapshot().requiresNewInput).toBe(false);
    } finally { open.mockRestore(); }
  });
  test("unsupported off is deferred during active handoff, never substituted for low, and rejected before the next prompt", async () => {
    const controller = new ControlledController(); controller.tool = true; controller.thinking = thoughtOptions();
    const open = spyOn(SessionController, "open").mockResolvedValue(controller as unknown as SessionController);
    try {
      const runtime = new ProviderRuntime(readConfig({}));
      const first = await runtime.stream(model, { messages: [initial] }, { reasoning: Effort.High }).result();
      const second = await runtime.stream(model, { messages: [initial, first, result] }, { disableReasoning: true }).result();
      expect(second.stopReason).toBe("stop"); expect(controller.completionCalls).toBe(1); expect(controller.stopCalls).toBe(0);
      expect(controller.thinkingCalls).toEqual(["high"]); expect(controller.thinking?.currentValue).toBe("high");
      const next: UserMessage = { ...initial, content: "idle task explicitly requests off" };
      const rejected = await runtime.stream(model, { messages: [initial, first, result, second, next] }, { disableReasoning: true }).result();
      expect(rejected.stopReason).toBe("error"); expect(rejected.errorMessage).toContain("Unsupported live thinking request off");
      expect(controller.beginCalls).toBe(1); expect(controller.thinkingCalls).toEqual(["high", "off"]);
      expect(runtime.snapshot().requiresNewInput).toBe(false);
    } finally { open.mockRestore(); }
  });
  test("input queued behind an active MCP handoff selects effort only after the original turn drains", async () => {
    const controller = new ControlledController(); controller.tool = true; controller.thinking = thoughtOptions();
    const open = spyOn(SessionController, "open").mockResolvedValue(controller as unknown as SessionController);
    try {
      const runtime = new ProviderRuntime(readConfig({}));
      const first = await runtime.stream(model, { messages: [initial] }, { reasoning: Effort.High }).result();
      controller.tool = false;
      const next: UserMessage = { ...initial, content: "queued explicit task at lower effort" };
      const second = await runtime.stream(model, { messages: [initial, first, result, next] }, { reasoning: Effort.Low }).result();
      expect(second.stopReason).toBe("stop"); expect(controller.completionCalls).toBe(1);
      expect(controller.beginThinking).toEqual(["high", "low"]); expect(controller.thinkingCalls).toEqual(["high", "low"]);
      expect(controller.stopCalls).toBe(0); expect(open).toHaveBeenCalledTimes(1);
    } finally { open.mockRestore(); }
  });
  test("cancellation during thinking selection prevents the initial prompt", async () => {
    const controller = new ControlledController(); const selecting = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    controller.selectThinking = async () => { selecting.resolve(); await release.promise; };
    const open = spyOn(SessionController, "open").mockResolvedValue(controller as unknown as SessionController);
    try {
      const runtime = new ProviderRuntime(readConfig({})); const abort = new AbortController();
      const response = runtime.stream(model, { messages: [initial] }, { reasoning: Effort.High, signal: abort.signal }).result();
      await selecting.promise; abort.abort("cancel thinking selection"); release.resolve();
      expect((await response).stopReason).toBe("aborted"); expect(controller.beginCalls).toBe(0); expect(controller.revoked).toBe(true);
    } finally { release.resolve(); open.mockRestore(); }
  });
  test("thinking rejection cannot retire a dirty session's replay fence", async () => {
    const old = new ControlledController(); old.tool = true;
    const rejected = new ControlledController(); rejected.thinking = thoughtOptions(); let index = 0;
    const open = spyOn(SessionController, "open").mockImplementation(async (_config, _tools, callbacks) => {
      const controller = [old, rejected][index++]!; controller.callbacks = callbacks ?? {}; return controller as unknown as SessionController;
    });
    try {
      const runtime = new ProviderRuntime(readConfig({}));
      await runtime.stream(model, { messages: [initial] }, { sessionId: "thinking-fence" }).result(); await runtime.stop("cancel pending task");
      const fresh: UserMessage = { ...initial, content: "new explicit task with unsupported effort" };
      const response = await runtime.stream(model, { messages: [initial, fresh] }, { sessionId: "thinking-fence", reasoning: Effort.XHigh }).result();
      expect(response.errorMessage).toContain("Unsupported live thinking request"); expect(runtime.snapshot().requiresNewInput).toBe(true);
      const replay = await runtime.stream(model, { messages: [initial] }, { sessionId: "thinking-fence" }).result();
      expect(replay.errorMessage).toContain("Automatic replay is blocked"); expect(open).toHaveBeenCalledTimes(2); expect(rejected.beginCalls).toBe(0);
    } finally { open.mockRestore(); }
  });
  test("host assistant -> toolResult -> accepted steering completes original MCP without rebuild or re-steer", async () => {
    const controller = new ControlledController(); controller.tool = true; controller.holdForSteering = true;
    const open = spyOn(SessionController, "open").mockImplementation(async (_config, _tools, callbacks) => {
      controller.callbacks = callbacks ?? {}; return controller as unknown as SessionController;
    });
    try {
      const runtime = new ProviderRuntime(readConfig({}));
      const channel = liveSteering();
      const first = await runtime.stream(model, { messages: [initial] }, { liveSteering: channel }).result();
      expect(channel.accepted).toEqual([steer]);
      expect(first.stopReason).toBe("toolUse");
      const second = await runtime.stream(model, { messages: [initial, first, result, steer] }).result();
      expect(second.stopReason).toBe("stop"); expect(controller.completionCalls).toBe(1);
      expect(controller.beginCalls).toBe(1); expect(open).toHaveBeenCalledTimes(1); expect(controller.stopCalls).toBe(0);
    } finally { open.mockRestore(); }
  });
  test("omp-system preserves pending MCP completion and rebuilds only for a substantive prompt change", async () => {
    const original = new ControlledController(); original.tool = true;
    const replacement = new ControlledController();
    const initialPrompt = ["Fixture shared system block", "Fixture original system block"];
    const changedPrompt = [initialPrompt[0]!, "Fixture updated, ordered，　system block"];
    const openConfigs: string[] = [];
    const open = spyOn(SessionController, "open").mockImplementation(async config => {
      openConfigs.push(JSON.stringify(config));
      if (openConfigs.length === 1) return original as unknown as SessionController;
      if (openConfigs.length === 2) return replacement as unknown as SessionController;
      throw new Error("Unexpected extra activation");
    });
    try {
      const runtime = new ProviderRuntime(readConfig({ OMP_AGY_PROFILE: "omp-system" }));
      const tracePayloads: unknown[] = [];
      runtime.debug = { enabled: true, event(_name, payload) { tracePayloads.push(typeof payload === "function" ? payload() : payload); } };
      const options = { sessionId: "dynamic-system-prompt" };
      const first = await runtime.stream(model, { messages: [initial], systemPrompt: initialPrompt }, options).result();
      expect(first.stopReason).toBe("toolUse");
      expect(original).toMatchObject({ phase: "active", pending: 1, dispatched: true, completionCalls: 0 });

      const completed = await runtime.stream(model, { messages: [initial, first, result], systemPrompt: changedPrompt }, options).result();
      expect(completed.stopReason).toBe("stop");
      expect(completed.content).toEqual([{ type: "text", text: "AGY completed after original handler result" }]);
      expect(original).toMatchObject({ phase: "idle", pending: 0, completionCalls: 1, beginCalls: 1, stopCalls: 0 });
      expect(open).toHaveBeenCalledTimes(1);
      expect(runtime.snapshot().rebuilds).toBe(0);

      const next: UserMessage = { ...initial, content: "explicit task after the prompt change", timestamp: 4 };
      const history = [initial, first, result, completed, next];
      const rebuilt = await runtime.stream(model, { messages: history, systemPrompt: changedPrompt }, options).result();
      expect(rebuilt.stopReason).toBe("stop");
      expect(original).toMatchObject({ phase: "stopped", completionCalls: 1, beginCalls: 1, stopCalls: 1 });
      expect(replacement).toMatchObject({ phase: "idle", completionCalls: 0, beginCalls: 1, stopCalls: 0 });
      expect(open).toHaveBeenCalledTimes(2);
      expect(runtime.snapshot().rebuilds).toBe(1);

      const last: UserMessage = { ...initial, content: "explicit task after a comma-spacing-only update", timestamp: 5 };
      const reused = await runtime.stream(model, { messages: [...history, rebuilt, last], systemPrompt: [initialPrompt[0]!, "Fixture updated,ordered，system block"] }, options).result();
      expect(reused.stopReason).toBe("stop");
      expect(replacement).toMatchObject({ phase: "idle", completionCalls: 0, beginCalls: 2, stopCalls: 0 });
      expect(open).toHaveBeenCalledTimes(2);
      expect(runtime.snapshot().rebuilds).toBe(1);

      expect(tracePayloads.length).toBeGreaterThan(0);
      const traceText = JSON.stringify(tracePayloads);
      for (const block of [...initialPrompt, changedPrompt[1]!]) {
        expect(openConfigs.join("\n")).not.toContain(block);
        expect(traceText).not.toContain(block);
      }
    } finally { open.mockRestore(); }
  });
  test("omp-system rejects an initial call without a system prompt before opening an activation", async () => {
    const open = spyOn(SessionController, "open").mockRejectedValue(new Error("Unexpected ACP activation"));
    try {
      const runtime = new ProviderRuntime(readConfig({ OMP_AGY_PROFILE: "omp-system" }));
      const response = await runtime.stream(model, { messages: [initial] }).result();
      expect(response.stopReason).toBe("error");
      expect(response.errorMessage).toMatch(/system[ -]?prompt/i);
      expect(open).not.toHaveBeenCalled();
      expect(runtime.displayState()).toBeUndefined();
    } finally { open.mockRestore(); }
  });
  test("autonomous controller failure during tool gap fences automatic reentry before another producer", async () => {
    const controller = new ControlledController(); controller.tool = true;
    const open = spyOn(SessionController, "open").mockImplementation(async (_config, _tools, callbacks) => {
      controller.callbacks = callbacks ?? {}; return controller as unknown as SessionController;
    });
    try {
      const runtime = new ProviderRuntime(readConfig({}));
      const first = await runtime.stream(model, { messages: [initial] }).result();
      await controller.fail(new Error("supervisor died while OMP tool executes"));
      expect(runtime.snapshot().requiresNewInput).toBe(true);
      const second = await runtime.stream(model, { messages: [initial, first, result] }).result();
      expect(second.stopReason).toBe("error"); expect(second.errorMessage).toContain("Automatic replay is blocked");
      expect(open).toHaveBeenCalledTimes(1); expect(controller.beginCalls).toBe(1); expect(controller.completionCalls).toBe(0);
    } finally { open.mockRestore(); }
  });
  test("failure during an image read fences the projected retry with or without newly recorded steering", async () => {
    const controller = new ControlledController(); controller.capabilities = { image: true }; controller.tool = true;
    const replacement = new ControlledController(); replacement.capabilities = { image: true };
    const begin = spyOn(replacement, "begin");
    controller.takeNext = () => {
      if (!controller.pending || controller.dispatched) return undefined;
      controller.dispatched = true;
      return { ...call, id: `read-${controller.completionCalls}` };
    };
    controller.bridge.complete = async id => {
      expect(id).toBe(`read-${controller.completionCalls}`);
      controller.completionCalls++; controller.dispatched = false;
      if (controller.completionCalls === 4) { controller.pending = 0; controller.activeFlights = 1; }
    };
    let opened = 0;
    const open = spyOn(SessionController, "open").mockImplementation(async (_config, _tools, callbacks) => {
      const next = opened++ === 0 ? controller : replacement;
      next.callbacks = callbacks ?? {}; return next as unknown as SessionController;
    });
    try {
      const runtime = new ProviderRuntime(readConfig({}));
      const vision: Model = { ...model, input: ["text", "image"] };
      const sessionId = "dirty-image-read";
      const screenshot: UserMessage = { ...initial, content: [{ type: "image", mimeType: "image/png", data: "screenshot" }] };
      const history: Message[] = [screenshot];
      const reminder = new DateCwdReminderInjector();
      const prepare = (messages: Message[]) => {
        runtime.captureContextImages(messages);
        const projected = clampProviderContextImages({ messages: convertToLlm(messages), systemPrompt: ["Fixture system prompt"] }, vision);
        return reminder.transform(projected, "2026-11-18", "C:/fixture");
      };
      const channel = liveSteering();
      const submit = (messages: Message[]) => runtime.stream(vision, prepare(messages), { sessionId, liveSteering: channel }).result();
      for (let index = 0; index < 5; index++) {
        const reply = await submit(history);
        expect(reply.stopReason).toBe("toolUse");
        history.push(reply, { ...result, toolCallId: `read-${index}`,
          content: [{ type: "image", mimeType: "image/png", data: `result-image-${index}` }] });
      }
      expect(channel.accepted).toEqual([steer]);
      await controller.fail(new Error("supervisor died while OMP reads the fifth image"));
      expect(runtime.snapshot().requiresNewInput).toBe(true);
      expect(prepare(history).messages[0]!.content).toContainEqual({ type: "text", text: "[image omitted: provider image limit]" });
      const synthetic: UserMessage = { role: "user", content: "continue", timestamp: 6, synthetic: true };
      for (const tail of [[synthetic], [steer, synthetic]]) {
        const replay = await submit([...history, ...tail]);
        expect(replay.stopReason).toBe("error");
        expect(replay.errorMessage).toContain("Automatic replay is blocked");
        expect(open).toHaveBeenCalledTimes(1);
      }
      const unknown: UserMessage = { role: "user", content: "unconfirmed boundary input", timestamp: 7 };
      expect(runtime.syncSteeringQuarantine([{ version: 1, messages: [unknown], reason: "no receipt", recordedAt: 8 }], sessionId)).toBe(true);
      expect((await submit([...history, steer, unknown])).errorMessage).toContain("quarantined");
      const fresh: UserMessage = { ...steer, steering: false, timestamp: 9 };
      expect((await submit([...history, steer, unknown, fresh])).stopReason).toBe("stop");
      expect(open).toHaveBeenCalledTimes(2); expect(controller.beginCalls).toBe(1);
      expect(controller.completionCalls).toBe(4); expect(replacement.completionCalls).toBe(0);
      expect(begin).toHaveBeenCalledTimes(1);
      expect(begin.mock.calls[0]![0]).not.toContainEqual({ type: "text", text: unknown.content });
      expect((await submit([...history, steer, unknown])).errorMessage).toContain("quarantined");
      expect(open).toHaveBeenCalledTimes(2);
    } finally { open.mockRestore(); }
  });
  test.each(["ordinary", "compacted"] as const)("seven image reads preserve the original MCP handlers with %s history", async history => {
    const controller = new ControlledController(); controller.tool = true;
    const replacement = new ControlledController(); replacement.capabilities = { image: true };
    const completed: string[] = [];
    controller.takeNext = () => {
      if (!controller.pending || controller.dispatched) return undefined;
      controller.dispatched = true;
      return { id: `image-${completed.length}`, name: "read", arguments: { path: `synthetic-${completed.length}.png` } };
    };
    controller.bridge.complete = async (id, _result) => {
      expect(id).toBe(`image-${completed.length}`);
      completed.push(id); controller.completionCalls++; controller.dispatched = false;
      controller.pending = completed.length < 7 ? 1 : 0;
      if (!controller.pending) controller.events.push({ type: "text", text: "All original image handlers completed" });
    };
    let opened = 0;
    const open = spyOn(SessionController, "open").mockImplementation(async () => [controller, replacement][opened++] as unknown as SessionController);
    try {
      const runtime = new ProviderRuntime(readConfig({}));
      const vision: Model = { ...model, input: ["text", "image"] };
      controller.capabilities = { image: true };
      const archive = { role: "compactionSummary" as const, summary: "Earlier work was compacted.", tokensBefore: 380000, timestamp: 0,
        blocks: Array.from({ length: 5 }, (_, index) => ({ type: "image" as const, mimeType: "image/png", data: `archive-${index}` })) };
      const messages: Parameters<typeof convertToLlm>[0] = history === "compacted" ? [archive, initial] : [initial];
      const reminder = new DateCwdReminderInjector();
      const continueFromHost = () => {
        const source = structuredClone(messages);
        runtime.captureContextImages(source);
        const projected = clampProviderContextImages({ messages: convertToLlm(source), systemPrompt: ["Fixture system prompt"] }, vision);
        return runtime.stream(vision, reminder.transform(projected, "2026-11-18", "C:/fixture"), { sessionId: "image-sequence" }).result();
      };
      let response = await continueFromHost();
      const generation = runtime.displayState()!.generation;
      for (let index = 0; index < 7; index++) {
        expect(response.stopReason).toBe("toolUse");
        const toolCall = response.content.find(block => block.type === "toolCall")!;
        expect(toolCall.type).toBe("toolCall");
        if (toolCall.type !== "toolCall") throw new Error("Expected original image call");
        messages.push(response, { ...result, toolCallId: toolCall.id,
          content: [{ type: "text", text: "Synthetic image read" }, { type: "image", mimeType: "image/png", data: `synthetic-image-${index}` }] });
        response = await continueFromHost();
        expect(runtime.displayState()!.generation).toBe(generation);
      }
      expect(response.stopReason).toBe("stop"); expect(completed).toEqual(Array.from({ length: 7 }, (_, index) => `image-${index}`));
      expect(open).toHaveBeenCalledTimes(1); expect(controller.beginCalls).toBe(1); expect(controller.stopCalls).toBe(0);
      expect(runtime.snapshot().rebuilds).toBe(0); expect(runtime.snapshot().requiresNewInput).toBe(false);
      messages.push(response);
      if (history === "compacted") {
        // Its oldest frame is no longer visible. Editing that source is still a real history change.
        archive.blocks[0] = { ...archive.blocks[0]!, data: "actual-archive-image-edit" };
      } else {
        const changed = messages[2]!;
        if (changed.role !== "toolResult") throw new Error("Expected original host image result");
        changed.content = [{ type: "text", text: "Synthetic image read" }, { type: "image", mimeType: "image/png", data: "actual-history-image-edit" }];
      }
      messages.push({ ...initial, content: "New explicit task after actual image history edit" });
      expect((await continueFromHost()).stopReason).toBe("stop");
      expect(open).toHaveBeenCalledTimes(2); expect(runtime.snapshot().rebuilds).toBe(1);
      expect(controller.completionCalls).toBe(7); expect(replacement.completionCalls).toBe(0); expect(replacement.beginCalls).toBe(1);
    } finally { open.mockRestore(); }
  });
  test("confirmed text-only steering bookkeeping is canonical completion without another prompt", async () => {
    const controller = new ControlledController(); controller.holdForSteering = true;
    const open = spyOn(SessionController, "open").mockImplementation(async (_config, _tools, callbacks) => {
      controller.callbacks = callbacks ?? {}; return controller as unknown as SessionController;
    });
    try {
      const runtime = new ProviderRuntime(readConfig({}));
      const channel = liveSteering();
      const first = await runtime.stream(model, { messages: [initial] }, { liveSteering: channel }).result();
      expect(channel.accepted).toEqual([steer]);
      const second = await runtime.stream(model, { messages: [initial, first, steer] }).result();
      expect(second.stopReason).toBe("stop"); expect(second.content).toEqual([{ type: "text", text: "[omp-agy: confirmed steering already delivered; no new ACP prompt sent.]" }]);
      expect(controller.beginCalls).toBe(1); expect(controller.stopCalls).toBe(0); expect(open).toHaveBeenCalledTimes(1);
    } finally { open.mockRestore(); }
  });
  test("cancellation during open cleans up before model selection or initial prompt", async () => {
    const controller = new ControlledController(); const setup = Promise.withResolvers<SessionController>();
    const open = spyOn(SessionController, "open").mockReturnValue(setup.promise);
    try {
      const runtime = new ProviderRuntime(readConfig({})); const abort = new AbortController();
      const stream = runtime.stream(model, { messages: [initial] }, { signal: abort.signal });
      abort.abort("cancel cold start"); setup.resolve(controller as unknown as SessionController);
      const response = await stream.result();
      expect(response.stopReason).toBe("aborted"); expect(controller.beginCalls).toBe(0); expect(controller.selectCalls).toBe(0); expect(controller.stopCalls).toBe(1);
    } finally { open.mockRestore(); }
  });
  test("cancellation during model selection never submits the initial prompt", async () => {
    const controller = new ControlledController(); const selecting = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    controller.selectModel = async () => { controller.selectCalls++; selecting.resolve(); await release.promise; };
    const open = spyOn(SessionController, "open").mockImplementation(async (_config, _tools, callbacks) => {
      controller.callbacks = callbacks ?? {}; return controller as unknown as SessionController;
    });
    try {
      const runtime = new ProviderRuntime(readConfig({})); const abort = new AbortController();
      const stream = runtime.stream(model, { messages: [initial] }, { signal: abort.signal });
      await selecting.promise; abort.abort("cancel model selection"); release.resolve();
      const response = await stream.result();
      expect(response.stopReason).toBe("aborted"); expect(controller.beginCalls).toBe(0); expect(controller.selectCalls).toBe(1);
      expect(controller.revoked).toBe(true);
    } finally { release.resolve(); open.mockRestore(); }
  });
  test("lifecycle stop without a host signal awaits cold open and revokes it before submission", async () => {
    const opening = Promise.withResolvers<SessionController>(); const cleanup = Promise.withResolvers<void>();
    const controller = new ControlledController(); const stopping = Promise.withResolvers<void>();
    controller.stop = async () => { controller.stopCalls++; controller.phase = "stopping"; stopping.resolve(); await cleanup.promise; controller.phase = "stopped"; controller.revoked = true; };
    const open = spyOn(SessionController, "open").mockReturnValue(opening.promise);
    try {
      const runtime = new ProviderRuntime(readConfig({}));
      const response = runtime.stream(model, { messages: [initial] }).result();
      let stopped = false; const stop = runtime.stop("session switched during setup", false).then(() => { stopped = true; });
      await Promise.resolve(); expect(stopped).toBe(false);
      opening.resolve(controller as unknown as SessionController); await stopping.promise;
      expect(stopped).toBe(false); expect(controller.selectCalls).toBe(0); expect(controller.beginCalls).toBe(0);
      cleanup.resolve(); await stop;
      expect((await response).stopReason).toBe("aborted"); expect(controller.revoked).toBe(true);
    } finally { cleanup.resolve(); open.mockRestore(); }
  });
  test("active stop unblocks its consumer before a waiting new invocation owns the next epoch", async () => {
    const old = new ControlledController(); old.activeFlights = 1; const next = new ControlledController();
    const waiting = Promise.withResolvers<void>(); const wake = Promise.withResolvers<void>();
    const stopping = Promise.withResolvers<void>(); const cleanup = Promise.withResolvers<void>();
    old.wait = async () => { waiting.resolve(); await wake.promise; }; old.wake = () => { wake.resolve(); };
    let stopPromise: Promise<void> | undefined;
    old.stop = () => stopPromise ??= (async () => { old.stopCalls++; old.phase = "stopping"; stopping.resolve(); await cleanup.promise; old.phase = "stopped"; old.revoked = true; })();
    let index = 0;
    const open = spyOn(SessionController, "open").mockImplementation(async (_config, _tools, callbacks) => {
      const controller = [old, next][index++]!; controller.callbacks = callbacks ?? {}; return controller as unknown as SessionController;
    });
    try {
      const runtime = new ProviderRuntime(readConfig({})); const first = runtime.stream(model, { messages: [initial] }).result();
      await waiting.promise; const stop = runtime.stop("cancel active old epoch"); await stopping.promise;
      const fresh: UserMessage = { ...initial, content: "new explicit task after active cancellation" };
      const second = runtime.stream(model, { messages: [initial, fresh] }).result();
      await Promise.resolve(); expect(open).toHaveBeenCalledTimes(1);
      cleanup.resolve(); await stop;
      expect((await first).stopReason).toBe("aborted"); expect((await second).stopReason).toBe("stop");
      expect(old.stopCalls).toBe(1); expect(next.beginCalls).toBe(1); expect(runtime.snapshot().busy).toBe(false);
    } finally { wake.resolve(); cleanup.resolve(); open.mockRestore(); }
  });
  test("new invocation waits for old cleanup and cannot lose its ledger to late stop completion", async () => {
    const old = new ControlledController(); const next = new ControlledController();
    const stopping = Promise.withResolvers<void>(); const cleanup = Promise.withResolvers<void>();
    old.stop = async () => { old.stopCalls++; old.phase = "stopping"; stopping.resolve(); await cleanup.promise; old.phase = "stopped"; };
    let index = 0;
    const open = spyOn(SessionController, "open").mockImplementation(async (_config, _tools, callbacks) => {
      const controller = [old, next][index++]!; controller.callbacks = callbacks ?? {}; return controller as unknown as SessionController;
    });
    try {
      const runtime = new ProviderRuntime(readConfig({}));
      await runtime.stream(model, { messages: [initial] }).result();
      const stop = runtime.stop("switch host session", false); await stopping.promise;
      const fresh: UserMessage = { ...initial, content: "new session explicit input" };
      const pending = runtime.stream(model, { messages: [fresh] }).result();
      await Promise.resolve(); expect(open).toHaveBeenCalledTimes(1); expect(next.beginCalls).toBe(0);
      cleanup.resolve(); await stop; const answer = await pending;
      expect(answer.stopReason).toBe("stop"); expect(next.beginCalls).toBe(1);
      old.callbacks.failed?.(new Error("late old activation failure"));
      expect(runtime.snapshot().requiresNewInput).toBe(false);
      const followup: UserMessage = { ...initial, content: "next new session input" };
      expect((await runtime.stream(model, { messages: [fresh, answer, followup] }).result()).stopReason).toBe("stop");
      expect(open).toHaveBeenCalledTimes(2); expect(next.beginCalls).toBe(2);
    } finally { cleanup.resolve(); open.mockRestore(); }
  });
  test("dirty cold stop fences the attempted input but allows a fresh same-text submission", async () => {
    const opening = Promise.withResolvers<SessionController>(); const old = new ControlledController(); const next = new ControlledController();
    let index = 0;
    const open = spyOn(SessionController, "open").mockImplementation(() => index++ === 0 ? opening.promise : Promise.resolve(next as unknown as SessionController));
    try {
      const runtime = new ProviderRuntime(readConfig({})); const first = runtime.stream(model, { messages: [initial] }).result();
      const stop = runtime.stop("explicit cancel"); opening.resolve(old as unknown as SessionController); await stop; await first;
      expect(runtime.snapshot().requiresNewInput).toBe(true);
      const replay = await runtime.stream(model, { messages: [initial] }).result();
      expect(replay.errorMessage).toContain("Automatic replay is blocked"); expect(open).toHaveBeenCalledTimes(1);
      const fresh: UserMessage = { ...initial, timestamp: initial.timestamp + 1 };
      expect((await runtime.stream(model, { messages: [fresh] }).result()).stopReason).toBe("stop");
      expect(open).toHaveBeenCalledTimes(2); expect(old.beginCalls).toBe(0);
    } finally { open.mockRestore(); }
  });
  test("sent steering settled during teardown remains fenced even after epoch invalidation", async () => {
    const controller = new ControlledController(); controller.holdForSteering = true;
    const sent = Promise.withResolvers<SteeringReceipt>();
    const confirmed = Promise.withResolvers<void>();
    controller.steer = async (_prompt, receipt) => { sent.resolve(receipt!); await confirmed.promise; };
    controller.stop = async () => {
      if (controller.phase === "stopped") return;
      controller.phase = "stopping"; (await sent.promise).onReceived?.(); confirmed.resolve();
      controller.phase = "stopped"; controller.revoked = true;
    };
    const open = spyOn(SessionController, "open").mockImplementation(async (_config, _tools, callbacks) => {
      controller.callbacks = callbacks ?? {}; return controller as unknown as SessionController;
    });
    try {
      const runtime = new ProviderRuntime(readConfig({}));
      const channel = liveSteering();
      const first = runtime.stream(model, { messages: [initial] }, { liveSteering: channel }).result();
      await sent.promise;
      await runtime.stop("cancel pending steering");
      expect(channel.accepted).toEqual([steer]);
      const replay = await runtime.stream(model, { messages: [initial, await first, steer] }).result();
      expect(replay.errorMessage).toContain("Automatic replay is blocked"); expect(open).toHaveBeenCalledTimes(1);
    } finally { open.mockRestore(); }
  });
  test("model changes rebuild the activation and still select the requested nondefault model", async () => {
    const controllers = [new ControlledController(), new ControlledController()]; const selected: string[] = []; let index = 0;
    for (const controller of controllers) controller.selectModel = async id => { selected.push(id); controller.selectCalls++; };
    const open = spyOn(SessionController, "open").mockImplementation(async () => controllers[index++] as unknown as SessionController);
    try {
      const runtime = new ProviderRuntime(readConfig({})); const first = await runtime.stream(model, { messages: [initial] }).result();
      const followup: UserMessage = { ...initial, content: "use another model" };
      const response = await runtime.stream({ ...model, id: "gemini-4-hydrogen" }, { messages: [initial, first, followup] }).result();
      expect(response.stopReason).toBe("stop"); expect(open).toHaveBeenCalledTimes(2); expect(controllers[0]!.stopCalls).toBe(1);
      expect(selected).toEqual(["gemini-4-argon", "gemini-4-hydrogen"]); expect(runtime.snapshot().rebuilds).toBe(1);
    } finally { open.mockRestore(); }
  });
  test("unknown history blocks and non-finite tool arguments fail before opening an activation", async () => {
    const open = spyOn(SessionController, "open");
    try {
      const runtime = new ProviderRuntime(readConfig({}));
      const unknown = { ...initial, content: [{ type: "audio", data: "retained" }] } as unknown as UserMessage;
      const invalid = await runtime.stream(model, { messages: [unknown] }).result();
      expect(invalid.errorMessage).toContain("Unsupported OMP history content block 'audio'"); expect(open).not.toHaveBeenCalled();
      const history = { role: "assistant", content: [{ type: "toolCall", id: "old", name: "read", arguments: { nested: [Infinity] } }] };
      const numeric = await runtime.stream(model, { messages: [history as never, initial] }).result();
      expect(numeric.errorMessage).toContain("Non-finite JSON number"); expect(open).not.toHaveBeenCalled();
    } finally { open.mockRestore(); }
  });
  test("stop also owns a cold explicit discovery until its no-generation controller is cleaned up", async () => {
    const opening = Promise.withResolvers<SessionController>(); const controller = new ControlledController();
    const open = spyOn(SessionController, "open").mockReturnValue(opening.promise);
    try {
      const runtime = new ProviderRuntime(readConfig({})); const discovery = runtime.discover();
      // Bun's rejects matcher waits synchronously; observe first, then drive cold-stop setup.
      const outcome = discovery.then(
        models => ({ status: "fulfilled" as const, models }),
        error => ({ status: "rejected" as const, error }),
      );
      let stopped = false; const stop = runtime.stop("stop cold discovery", false).then(() => { stopped = true; });
      await Promise.resolve(); expect(stopped).toBe(false);
      opening.resolve(controller as unknown as SessionController); await stop;
      expect(await outcome).toMatchObject({ status: "rejected", error: expect.objectContaining({ name: "AbortError", message: "stop cold discovery" }) });
      expect(controller.phase).toBe("stopped"); expect(controller.beginCalls).toBe(0);
    } finally { open.mockRestore(); }
  });
  test("verified reset alone releases cleanup failure, never the dirty-input replay fence", async () => {
    const controller = new ControlledController(); controller.tool = true;
    const failure = new ActivationCleanupError(undefined, "controlled unconfirmed cleanup");
    const open = spyOn(SessionController, "open").mockResolvedValue(controller as unknown as SessionController);
    const recover = spyOn(runnerModule, "resetRunner").mockRejectedValue(new Error("owned worker still alive"));
    try {
      const runner = { distribution: "omp-agy-wsl", user: "agy" }; const runtime = new ProviderRuntime({ ...readConfig({}), runner });
      await runtime.stream(model, { messages: [initial] }).result();
      controller.stop = async () => { controller.phase = "cleanup_failed"; controller.failure = failure; };
      await expect(runtime.stop("cancel tool gap")).rejects.toThrow("cleanup_failed");
      await expect(runtime.reset()).rejects.toThrow("owned worker still alive");
      expect(runtime.snapshot().phase).toBe("cleanup_failed"); expect(runtime.snapshot().requiresNewInput).toBe(true);
      recover.mockResolvedValue({ recovered: ["/controlled/stale-activation"] });
      expect(await runtime.reset()).toEqual({ recovered: ["/controlled/stale-activation"] });
      expect(recover).toHaveBeenLastCalledWith(runner); expect(runtime.snapshot().phase).not.toBe("cleanup_failed");
      expect(runtime.snapshot().requiresNewInput).toBe(true);
      const replay = await runtime.stream(model, { messages: [initial] }).result();
      expect(replay.errorMessage).toContain("Automatic replay is blocked"); expect(open).toHaveBeenCalledTimes(1);
    } finally { recover.mockRestore(); open.mockRestore(); }
  });
  test("reset cannot race a cold setup or clear its ownership", async () => {
    const opening = Promise.withResolvers<SessionController>(); const controller = new ControlledController();
    const open = spyOn(SessionController, "open").mockReturnValue(opening.promise);
    const recover = spyOn(runnerModule, "resetRunner").mockResolvedValue({ recovered: [] });
    try {
      const runtime = new ProviderRuntime(readConfig({})); const pending = runtime.stream(model, { messages: [initial] }).result();
      await expect(runtime.reset()).rejects.toThrow("idle"); expect(recover).not.toHaveBeenCalled();
      const stop = runtime.stop("cancel fixture", false); opening.resolve(controller as unknown as SessionController);
      await stop; await pending;
    } finally { recover.mockRestore(); open.mockRestore(); }
  });
  test("profile mutation reserves admission until cleanup and installs the profile before new work", async () => {
    const old = new ControlledController(); const next = new ControlledController();
    const stopping = Promise.withResolvers<void>(); const cleanup = Promise.withResolvers<void>();
    old.stop = async () => { old.phase = "stopping"; stopping.resolve(); await cleanup.promise; old.phase = "stopped"; };
    const profiles: string[] = []; let index = 0;
    const open = spyOn(SessionController, "open").mockImplementation(async config => {
      profiles.push(config.profile); return [old, next][index++] as unknown as SessionController;
    });
    const recover = spyOn(runnerModule, "resetRunner");
    try {
      const runtime = new ProviderRuntime(readConfig({ OMP_AGY_PROFILE: "default-agy" }));
      await runtime.stream(model, { messages: [initial] }).result();
      const changing = runtime.setProfile("custom-clean"); await stopping.promise;
      await expect(runtime.setProfile("default-agy")).rejects.toThrow("idle");
      await expect(runtime.discover()).rejects.toThrow("idle");
      await expect(runtime.reset()).rejects.toThrow("idle"); expect(recover).not.toHaveBeenCalled();
      expect((await runtime.stream(model, { messages: [initial] }).result()).stopReason).toBe("error");
      expect((await runtime.stream(model, { messages: [initial] }, { codexCompaction: { operationId: "profile-race", trigger: "manual", reason: "user_requested", phase: "standalone_turn", strategy: "memento", implementation: "responses" } }).result()).stopReason).toBe("error");
      expect(open).toHaveBeenCalledTimes(1);
      cleanup.resolve(); await changing;
      expect(runtime.config.profile).toBe("custom-clean"); expect(runtime.snapshot().busy).toBe(false);
      expect((await runtime.stream(model, { messages: [initial] }).result()).stopReason).toBe("stop");
      expect(profiles).toEqual(["default-agy", "custom-clean"]);
    } finally { cleanup.resolve(); recover.mockRestore(); open.mockRestore(); }
  });
  test("external stop cancels a reserved profile mutation without a self-wait or config change", async () => {
    const controller = new ControlledController(); const stopping = Promise.withResolvers<void>(); const cleanup = Promise.withResolvers<void>();
    let stopPromise: Promise<void> | undefined;
    controller.stop = () => stopPromise ??= (async () => { controller.phase = "stopping"; stopping.resolve(); await cleanup.promise; controller.phase = "stopped"; })();
    const open = spyOn(SessionController, "open").mockResolvedValue(controller as unknown as SessionController);
    try {
      const runtime = new ProviderRuntime(readConfig({ OMP_AGY_PROFILE: "default-agy" })); await runtime.stream(model, { messages: [initial] }).result();
      const changing = runtime.setProfile("custom-clean").then(() => undefined, error => error);
      await stopping.promise; let stopped = false;
      const stop = runtime.stop("external profile cancellation", false).then(() => { stopped = true; });
      await expect(runtime.setProfile("custom-clean")).rejects.toThrow("idle");
      await Promise.resolve(); expect(stopped).toBe(false); cleanup.resolve();
      expect(await changing).toMatchObject({ name: "AbortError", message: "external profile cancellation" });
      await stop; expect(runtime.config.profile).toBe("default-agy"); expect(runtime.snapshot().busy).toBe(false);
    } finally { cleanup.resolve(); open.mockRestore(); }
  });
  test("profile mutation cannot enter an already-owned external stop barrier", async () => {
    const controller = new ControlledController(); const stopping = Promise.withResolvers<void>(); const cleanup = Promise.withResolvers<void>();
    controller.stop = async () => { controller.phase = "stopping"; stopping.resolve(); await cleanup.promise; controller.phase = "stopped"; };
    const open = spyOn(SessionController, "open").mockResolvedValue(controller as unknown as SessionController);
    try {
      const runtime = new ProviderRuntime(readConfig({ OMP_AGY_PROFILE: "default-agy" })); await runtime.stream(model, { messages: [initial] }).result();
      const stop = runtime.stop("external cleanup", false); await stopping.promise;
      await expect(runtime.setProfile("custom-clean")).rejects.toThrow("idle");
      cleanup.resolve(); await stop; expect(runtime.config.profile).toBe("default-agy");
    } finally { cleanup.resolve(); open.mockRestore(); }
  });
  for (const sameInput of [true, false]) test(`session B ${sameInput ? "equal" : "distinct"} input cannot consume or retire session A's dirty fence`, async () => {
    const old = new ControlledController(); old.tool = true; const next = new ControlledController(); const fresh = new ControlledController(); let index = 0;
    const open = spyOn(SessionController, "open").mockImplementation(async (_config, _tools, callbacks) => {
      const controller = [old, next, fresh][index++]!; controller.callbacks = callbacks ?? {}; return controller as unknown as SessionController;
    });
    try {
      const runtime = new ProviderRuntime(readConfig({}));
      await runtime.stream(model, { messages: [initial] }, { sessionId: "A" }).result(); await runtime.stop("cancel session A");
      const inputB = sameInput ? initial : { ...initial, content: "distinct session B task" };
      expect((await runtime.stream(model, { messages: [inputB] }, { sessionId: "B" }).result()).stopReason).toBe("stop");
      expect(runtime.snapshot().requiresNewInput).toBe(true);
      old.callbacks.failed?.(new Error("late A failure"));
      const replay = await runtime.stream(model, { messages: [initial] }, { sessionId: "A" }).result();
      expect(replay.errorMessage).toContain("Automatic replay is blocked"); expect(open).toHaveBeenCalledTimes(2);
      const newInput: UserMessage = { ...initial, content: "new explicit A task" };
      expect((await runtime.stream(model, { messages: [initial, newInput] }, { sessionId: "A" }).result()).stopReason).toBe("stop");
      expect(runtime.snapshot().requiresNewInput).toBe(false);
    } finally { open.mockRestore(); }
  });
  test("missing direct-call identity has an isolated stable replay fence, not a routed session alias", async () => {
    const old = new ControlledController(); old.tool = true; const next = new ControlledController(); let index = 0;
    const open = spyOn(SessionController, "open").mockImplementation(async () => [old, next][index++] as unknown as SessionController);
    try {
      const runtime = new ProviderRuntime(readConfig({})); await runtime.stream(model, { messages: [initial] }).result(); await runtime.stop("cancel identity-less direct call");
      expect((await runtime.stream(model, { messages: [initial] }, { sessionId: "named" }).result()).stopReason).toBe("stop");
      expect((await runtime.stream(model, { messages: [initial] }).result()).errorMessage).toContain("Automatic replay is blocked");
      expect(open).toHaveBeenCalledTimes(2);
    } finally { open.mockRestore(); }
  });
  test("steering on a reused activation extends the current session attempt's checkpoint array", async () => {
    const controller = new ControlledController();
    const open = spyOn(SessionController, "open").mockImplementation(async (_config, _tools, callbacks) => {
      controller.callbacks = callbacks ?? {}; return controller as unknown as SessionController;
    });
    try {
      const runtime = new ProviderRuntime(readConfig({}));
      const first = await runtime.stream(model, { messages: [initial] }, { sessionId: "A" }).result();
      const followup: UserMessage = { ...initial, content: "second explicit A task" };
      controller.holdForSteering = true; controller.tool = true;
      const channel = liveSteering();
      const second = await runtime.stream(model, { messages: [initial, first, followup] }, { sessionId: "A", liveSteering: channel }).result();
      expect(channel.accepted).toEqual([steer]);
      expect(second.stopReason).toBe("toolUse"); await runtime.stop("cancel second A attempt");
      const replay = await runtime.stream(model, { messages: [initial, first, followup, second, result, steer] }, { sessionId: "A" }).result();
      expect(replay.errorMessage).toContain("Automatic replay is blocked"); expect(open).toHaveBeenCalledTimes(1);
    } finally { open.mockRestore(); }
  });
  test("cancelled rediscovery releases only its stopped controller and retains the last published catalog", async () => {
    const published = new ControlledController(); const cancelled = new ControlledController();
    published.modelContextWindows = new Map([[model.id, 650000]]);
    cancelled.models = [{ id: "cancelled-model", name: "Never published" }];
    cancelled.modelContextWindows = new Map([[cancelled.models[0]!.id, 700000]]);
    const stopping = Promise.withResolvers<void>(); const cleanup = Promise.withResolvers<void>(); let stopPromise: Promise<void> | undefined;
    cancelled.stop = () => stopPromise ??= (async () => { cancelled.phase = "stopping"; stopping.resolve(); await cleanup.promise; cancelled.phase = "stopped"; })();
    let index = 0; const open = spyOn(SessionController, "open").mockImplementation(async () => [published, cancelled][index++] as unknown as SessionController);
    try {
      const runtime = new ProviderRuntime(readConfig({})); const models = await runtime.discover(); expect(models[0]!.id).toBe("gemini-4-argon");
      const evidence = runtime.discoveredContextWindows;
      const discovery = runtime.discover().then(() => undefined, error => error); await stopping.promise;
      const stop = runtime.stop("cancel rediscovery", false); cleanup.resolve();
      expect(await discovery).toMatchObject({ name: "AbortError" }); await stop;
      expect(runtime.snapshot().advertisedModels).toEqual(published.models); expect(runtime.snapshot().phase).toBe("stopped");
      expect(runtime.discoveredContextWindows).toBe(evidence);
      expect(evidence?.get(model.id)).toBe(650000);
      expect(evidence?.get(cancelled.models[0]!.id)).toBeUndefined();
      expect(cancelled.beginCalls).toBe(0);
    } finally { cleanup.resolve(); open.mockRestore(); }
  });
  test("failed discovery cleanup retains its fail-closed controller evidence and published catalog", async () => {
    const published = new ControlledController(); const failed = new ControlledController();
    failed.models = [{ id: "unpublished-model", name: "Unpublished" }];
    failed.stop = async () => { failed.phase = "cleanup_failed"; failed.failure = new ActivationCleanupError(undefined, "discovery cleanup not confirmed"); };
    let index = 0; const open = spyOn(SessionController, "open").mockImplementation(async () => [published, failed][index++] as unknown as SessionController);
    const recover = spyOn(runnerModule, "resetRunner").mockResolvedValue({ recovered: [] });
    try {
      const runtime = new ProviderRuntime(readConfig({})); await runtime.discover();
      await expect(runtime.discover()).rejects.toThrow("cleanup_failed");
      expect(runtime.snapshot().phase).toBe("cleanup_failed"); expect(runtime.snapshot().failure).toContain("discovery cleanup not confirmed");
      expect(runtime.snapshot().advertisedModels).toEqual(failed.models);
      await expect(runtime.discover()).rejects.toThrow("cleanup_failed"); expect(open).toHaveBeenCalledTimes(2);
      await runtime.reset(); expect(runtime.snapshot().advertisedModels).toEqual(published.models);
    } finally { recover.mockRestore(); open.mockRestore(); }
  });
  test("discovery defaults vary by verified live model, not a uniform host fallback", async () => {
    const controller = new ControlledController();
    controller.models = [{ id: "gemini-4-argon", name: "Argon" }, { id: "gpt-oss-120b-medium", name: "GPT-OSS" }];
    const open = spyOn(SessionController, "open").mockResolvedValue(controller as unknown as SessionController);
    try {
      const models = await new ProviderRuntime(readConfig({})).discover();
      expect(models.map(row => row.id)).toEqual(controller.models.map(row => row.id));
      expect(models.map(row => row.contextWindow)).toEqual(controller.models.map(row => resolveContextWindow("1.5.10", row.id)));
      expect(models[0]!.contextWindow).not.toBe(models[1]!.contextWindow);
      expect(models.every(row => row.maxTokens === 8192 && Object.values(row.cost).every(cost => cost === 0))).toBe(true);
      expect(controller.beginCalls).toBe(0); expect(controller.stopCalls).toBe(1);
    } finally { open.mockRestore(); }
  });
  test("explicit context budgets below and equal to a known ceiling publish unchanged; above clamps", async () => {
    const ceiling = resolveContextWindow("1.5.10", model.id);
    for (const budget of [ceiling - 1, ceiling, ceiling + 1]) {
      const controller = new ControlledController(); controller.models = [{ id: model.id, name: model.name }];
      const open = spyOn(SessionController, "open").mockResolvedValue(controller as unknown as SessionController);
      try {
        const runtime = new ProviderRuntime(readConfig({ OMP_AGY_CONTEXT_WINDOW: String(budget) }));
        expect((await runtime.discover())[0]!.contextWindow).toBe(Math.min(budget, ceiling));
        if (budget > ceiling) expect(JSON.stringify(runtime.snapshot().diagnostics)).toContain(`clamped to known ceiling ${ceiling}`);
        expect(controller.beginCalls).toBe(0); expect(controller.phase).toBe("stopped");
      } finally { open.mockRestore(); }
    }
  });
  test("400000 discovery retains small models at their ceiling and future models at an unknown-capacity local budget", async () => {
    const controller = new ControlledController();
    controller.models = [{ id: "gpt-oss-120b-medium", name: "Small" }, { id: model.id, name: model.name }, { id: "future-live-model", name: "Future" }];
    const open = spyOn(SessionController, "open").mockResolvedValue(controller as unknown as SessionController);
    try {
      const runtime = new ProviderRuntime(readConfig({ OMP_AGY_CONTEXT_WINDOW: "400000" }));
      expect((await runtime.discover()).map(row => [row.id, row.contextWindow])).toEqual([["gpt-oss-120b-medium", 131072], [model.id, 400000], ["future-live-model", 400000]]);
      const diagnostics = runtime.snapshot().diagnostics as string[];
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toContain("clamped to known ceiling 131072");
      expect(controller.beginCalls).toBe(0); expect(controller.phase).toBe("stopped");
    } finally { open.mockRestore(); }
  });
  test("unknown capacities use local budgets without warnings on discovery or repeated calls", async () => {
    for (const unknownVersion of [true, false]) for (const requested of [undefined, "200000", "600000"]) {
      const id = unknownVersion ? "gpt-oss-120b-medium" : "future-live-model";
      const controllers = [new ControlledController(), new ControlledController()]; let index = 0;
      for (const controller of controllers) {
        controller.runner.evidence.version = unknownVersion ? "future-cli-version" : "1.5.10";
        controller.models = [{ id, name: "Future live selection" }];
      }
      const open = spyOn(SessionController, "open").mockImplementation(async () => controllers[index++] as unknown as SessionController);
      try {
        const runtime = new ProviderRuntime(readConfig(requested === undefined ? {} : { OMP_AGY_CONTEXT_WINDOW: requested }));
        const warnings: string[] = []; runtime.onDiagnostic = text => warnings.push(text);
        const budget = requested === undefined ? 400000 : Number(requested);
        expect((await runtime.discover()).map(row => [row.id, row.contextWindow])).toEqual([[id, budget]]);
        const selected = { ...model, id, contextWindow: budget };
        const first = await runtime.stream(selected, { messages: [initial] }).result();
        expect(first.stopReason).toBe("stop");
        const followup: UserMessage = { ...initial, content: "another turn with the same local budget" };
        expect((await runtime.stream(selected, { messages: [initial, first, followup] }).result()).stopReason).toBe("stop");
        expect(controllers[0]!.beginCalls).toBe(0); expect(controllers[0]!.phase).toBe("stopped");
        expect(controllers[1]!.beginCalls).toBe(2); expect(controllers[1]!.selectCalls).toBe(1); expect(open).toHaveBeenCalledTimes(2);
        expect(warnings).toEqual([]); expect(runtime.snapshot().diagnostics).toEqual([]);
      } finally { open.mockRestore(); }
    }
  });
  test("an empty live catalog still fails explicitly after cleanup without inventing a fallback model", async () => {
    const controller = new ControlledController(); controller.models = [];
    const open = spyOn(SessionController, "open").mockResolvedValue(controller as unknown as SessionController);
    try {
      await expect(new ProviderRuntime(readConfig({})).discover()).rejects.toThrow("No models were advertised");
      expect(controller.beginCalls).toBe(0); expect(controller.phase).toBe("stopped");
    } finally { open.mockRestore(); }
  });
  test("large future-model catalogs are registered without discovery warning spam", async () => {
    const controller = new ControlledController();
    controller.models = [...Array.from({ length: 30 }, (_, index) => ({ id: `unknown-${index}-${"x".repeat(1000)}`, name: "Unknown" })), { id: model.id, name: model.name }];
    const open = spyOn(SessionController, "open").mockResolvedValue(controller as unknown as SessionController);
    try {
      const runtime = new ProviderRuntime(readConfig({}));
      const warnings: string[] = []; runtime.onDiagnostic = text => warnings.push(text);
      expect(await runtime.discover()).toHaveLength(31);
      expect(warnings).toEqual([]); expect(runtime.snapshot().diagnostics).toEqual([]);
    } finally { open.mockRestore(); }
  });
  test("discovery prefers trusted exact-model capacities, clamps configuration, and snapshots only live rows", async () => {
    const controller = new ControlledController();
    const small = "gpt-oss-120b-medium";
    const invalid = "gemini-4-hydrogen";
    const future = "future-live-model";
    controller.models = [model.id, small, invalid, future].map(id => ({ id, name: id }));
    const capacities = new Map([[model.id, 640000], [small, 800000], [invalid, 0], [future.toUpperCase(), 900000]]);
    controller.modelContextWindows = capacities;
    const stop = controller.stop.bind(controller);
    controller.stop = async () => { capacities.clear(); await stop(); };
    const open = spyOn(SessionController, "open").mockResolvedValue(controller as unknown as SessionController);
    try {
      const runtime = new ProviderRuntime(readConfig({ OMP_AGY_CONTEXT_WINDOW: "700000" }));
      const rows = await runtime.discover();
      expect(rows.map(row => [row.id, row.contextWindow])).toEqual([[model.id, 640000], [small, 700000], [invalid, 700000], [future, 700000]]);
      const discovery = runtime.discoveredContextWindows;
      expect(discovery?.version).toBe("1.5.10");
      expect(discovery?.get(small)).toBe(800000);
      expect(discovery?.get(invalid)).toBeUndefined();
      expect(discovery?.get(future.toUpperCase())).toBeUndefined();
      expect(controller.beginCalls).toBe(0); expect(controller.stopCalls).toBe(1);
    } finally { open.mockRestore(); }
  });
  test("admission keeps discovered capacity without fresh metadata, re-clamps it, and prefers fresh capacity", async () => {
    const id = "future-live-model";
    const discovery = new ControlledController(); const live = new ControlledController();
    for (const controller of [discovery, live]) controller.models = [{ id, name: id }];
    discovery.modelContextWindows = new Map([[id, 650000]]);
    let index = 0;
    const open = spyOn(SessionController, "open").mockImplementation(async () => [discovery, live][index++] as unknown as SessionController);
    try {
      const runtime = new ProviderRuntime(readConfig({ OMP_AGY_CONTEXT_WINDOW: "500000" }));
      const [row] = await runtime.discover();
      expect(row!.contextWindow).toBe(500000);
      const warnings: string[] = []; runtime.onDiagnostic = text => warnings.push(text);
      const first = await runtime.stream({ ...model, id, contextWindow: row!.contextWindow }, { messages: [initial] }).result();
      expect(first.stopReason).toBe("stop");
      expect(open.mock.calls[0]?.[2]?.observeModelWindows).toBe(true);
      expect(open.mock.calls[1]?.[2]?.observeModelWindows).toBeUndefined();
      const history = { messages: [initial, first, { ...initial, content: "use the discovered capacity again" }] };
      runtime.config = { ...runtime.config, contextWindow: 600000 };
      live.modelContextWindows = new Map([[id, 550000]]);
      const stale = await runtime.stream({ ...model, id, contextWindow: 600000 }, history).result();
      expect(stale.errorMessage).toContain("runtime's context budget 550000");
      expect(live.beginCalls).toBe(1); expect(live.stopCalls).toBe(0);
      live.modelContextWindows = new Map();
      const oversized = await runtime.stream({ ...model, id, contextWindow: 600001 }, history).result();
      expect(oversized.errorMessage).toContain("runtime's context budget 600000");
      expect((await runtime.stream({ ...model, id, contextWindow: 600000 }, history).result()).stopReason).toBe("stop");
      expect(live.beginCalls).toBe(2); expect(warnings).toEqual([]);
    } finally { open.mockRestore(); }
  });
  test("rediscovery without an entry forgets the old model capacity even under the same CLI version", async () => {
    const id = "future-live-model";
    const discovery = new ControlledController(); const rediscovery = new ControlledController(); const live = new ControlledController();
    for (const controller of [discovery, rediscovery, live]) controller.models = [{ id, name: id }, { id: model.id, name: model.name }];
    discovery.modelContextWindows = new Map([[id, 650000]]);
    rediscovery.modelContextWindows = new Map([[model.id, 550000]]);
    let index = 0;
    const open = spyOn(SessionController, "open").mockImplementation(async () => [discovery, rediscovery, live][index++] as unknown as SessionController);
    try {
      const runtime = new ProviderRuntime(readConfig({}));
      expect((await runtime.discover())[0]!.contextWindow).toBe(650000);
      expect((await runtime.discover())[0]!.contextWindow).toBe(400000);
      expect(runtime.discoveredContextWindows?.get(id)).toBeUndefined();
      expect(runtime.discoveredContextWindows?.get(model.id)).toBe(550000);
      const stale = await runtime.stream({ ...model, id, contextWindow: 650000 }, { messages: [initial] }).result();
      expect(stale.errorMessage).toContain("runtime's context budget 400000");
      expect(live.beginCalls).toBe(0);
    } finally { open.mockRestore(); }
  });
  test("discovery evidence does not cross CLI versions or configured and explicit account switches", async () => {
    for (const changed of ["version", "runner", "account"] as const) {
      const id = "future-live-model";
      const discovery = new ControlledController(); const live = new ControlledController();
      for (const controller of [discovery, live]) controller.models = [{ id, name: id }];
      discovery.modelContextWindows = new Map([[id, 650000]]);
      let index = 0;
      const open = spyOn(SessionController, "open").mockImplementation(async () => [discovery, live][index++] as unknown as SessionController);
      try {
        const runtime = new ProviderRuntime(readConfig({}));
        await runtime.discover();
        if (changed === "version") live.runner.evidence.version = "1.5.11";
        if (changed === "runner") runtime.config = readConfig({ OMP_AGY_ACCOUNT_DIRECTORY: "/home/agy/.gemini/other-account" });
        if (changed === "account") await runtime.withAccountLogin(async () => {});
        const stale = await runtime.stream({ ...model, id, contextWindow: 650000 }, { messages: [initial] }).result();
        expect(stale.errorMessage).toContain("runtime's context budget 400000");
        expect(live.selectCalls).toBe(0); expect(live.beginCalls).toBe(0);
      } finally { open.mockRestore(); }
    }
  });
  test("borrowed evidence follows the host's current publication and does not fall back to an invalidated local snapshot", async () => {
    const id = "future-live-model";
    const discovery = new ControlledController(); const childLive = new ControlledController(); const parentLive = new ControlledController();
    for (const controller of [discovery, childLive, parentLive]) controller.models = [{ id, name: id }];
    discovery.modelContextWindows = new Map([[id, 650000]]);
    let index = 0;
    const open = spyOn(SessionController, "open").mockImplementation(async () => [discovery, childLive, parentLive][index++] as unknown as SessionController);
    try {
      const parent = new ProviderRuntime(readConfig({})); const child = new ProviderRuntime(readConfig({}));
      await parent.discover();
      let published = parent.discoveredContextWindows;
      parent.getPublishedContextWindows = child.getPublishedContextWindows = version => published?.version === version ? published : undefined;
      const selected = { ...model, id, contextWindow: 650000 };
      expect((await child.stream(selected, { messages: [initial] }, { cwd: "another-host-directory" }).result()).stopReason).toBe("stop");
      published = undefined;
      const stale = await parent.stream(selected, { messages: [initial] }).result();
      expect(stale.errorMessage).toContain("runtime's context budget 400000");
      expect(childLive.beginCalls).toBe(1); expect(parentLive.beginCalls).toBe(0);
    } finally { open.mockRestore(); }
  });
  test("discovery with an unprobed version does not publish portable capacity evidence", async () => {
    const controller = new ControlledController(); const id = "future-live-model";
    controller.models = [{ id, name: id }]; controller.runner.evidence.version = "not probed";
    controller.modelContextWindows = new Map([[id, 650000]]);
    const open = spyOn(SessionController, "open").mockResolvedValue(controller as unknown as SessionController);
    try {
      const runtime = new ProviderRuntime(readConfig({}));
      expect((await runtime.discover())[0]!.contextWindow).toBe(400000);
      expect(runtime.discoveredContextWindows).toBeUndefined();
    } finally { open.mockRestore(); }
  });
  test("known small models generate at their ceiling, but raw oversized registry budgets cannot be clamped into acceptance", async () => {
    const controller = new ControlledController(); controller.models = [{ id: "gpt-oss-120b-medium", name: "GPT-OSS" }];
    const open = spyOn(SessionController, "open").mockResolvedValue(controller as unknown as SessionController);
    try {
      const runtime = new ProviderRuntime(readConfig({ OMP_AGY_CONTEXT_WINDOW: "400000" }));
      const selected = { ...model, id: "gpt-oss-120b-medium", contextWindow: 131072 };
      const first = await runtime.stream(selected, { messages: [initial] }).result();
      expect(first.stopReason).toBe("stop"); expect(controller.beginCalls).toBe(1);
      const followup: UserMessage = { ...initial, content: "continue with a refreshed budget" };
      const rejected = await runtime.stream({ ...selected, contextWindow: 400000 }, { messages: [initial, first, followup] }).result();
      expect(rejected.errorMessage).toContain("runtime's context budget 131072");
      expect(controller.beginCalls).toBe(1); expect(controller.stopCalls).toBe(0); expect(runtime.snapshot().requiresNewInput).toBe(false);
      expect((await runtime.stream(selected, { messages: [initial, first, followup] }).result()).stopReason).toBe("stop");
      expect(controller.beginCalls).toBe(2); expect(open).toHaveBeenCalledTimes(1);
    } finally { open.mockRestore(); }
  });
  test("stale, unavailable and invalid registry budgets cannot submit a prompt or dirty a clean input", async () => {
    const ceiling = resolveContextWindow("1.5.10", model.id);
    const missingContextWindow: Partial<Model> = { ...model }; delete missingContextWindow.contextWindow;
    const cases = [
      { selected: { ...model, id: "unadvertised-future-model" }, version: "1.5.10", config: {}, error: "not advertised by this live ACP configuration" },
      { selected: { ...model, contextWindow: 400001 }, version: "future-cli-version", config: {}, error: "runtime's context budget 400000" },
      { selected: { ...model, contextWindow: ceiling + 1 }, version: "1.5.10", config: {}, error: "runtime's context budget" },
      { selected: { ...model, contextWindow: 400001 }, version: "1.5.10", config: { OMP_AGY_CONTEXT_WINDOW: "400000" }, error: "runtime's context budget" },
      { selected: { ...model, contextWindow: ceiling + 1 }, version: "1.5.10", config: { OMP_AGY_CONTEXT_WINDOW: String(ceiling + 1) }, error: "runtime's context budget" },
      { selected: { ...model, id: "gpt-oss-120b-medium", contextWindow: 400000 }, version: "1.5.10", config: { OMP_AGY_CONTEXT_WINDOW: "400000" }, error: "runtime's context budget 131072" },
      { selected: { ...model, id: "gpt-oss-120b-medium", contextWindow: 131072 }, version: "1.5.10", config: {}, error: "not advertised by this live ACP configuration" },
      { selected: { ...model, contextWindow: 0 }, version: "1.5.10", config: {}, error: "positive safe integer" },
      { selected: { ...model, contextWindow: 1.5 }, version: "1.5.10", config: {}, error: "positive safe integer" },
      { selected: { ...model, contextWindow: NaN }, version: "1.5.10", config: {}, error: "positive safe integer" },
      { selected: { ...model, contextWindow: null }, version: "1.5.10", config: {}, error: "no numeric contextWindow" },
      { selected: missingContextWindow as Model, version: "1.5.10", config: {}, error: "no numeric contextWindow" },
    ];
    for (const entry of cases) {
      const rejected = new ControlledController(); rejected.runner.evidence.version = entry.version;
      const accepted = new ControlledController(); let index = 0;
      const open = spyOn(SessionController, "open").mockImplementation(async () => [rejected, accepted][index++] as unknown as SessionController);
      try {
        const runtime = new ProviderRuntime(readConfig(entry.config));
        const response = await runtime.stream(entry.selected, { messages: [initial] }).result();
        expect(response.stopReason).toBe("error"); expect(response.errorMessage).toContain(entry.error);
        expect(rejected.selectCalls).toBe(0); expect(rejected.beginCalls).toBe(0); expect(rejected.phase).toBe("stopped");
        expect(runtime.snapshot().requiresNewInput).toBe(false);
        runtime.config = readConfig({ OMP_AGY_CONTEXT_WINDOW: "400000" });
        expect((await runtime.stream({ ...model, contextWindow: 399999 }, { messages: [initial] }).result()).stopReason).toBe("stop");
        expect(accepted.beginCalls).toBe(1);
      } finally { open.mockRestore(); }
    }
  });
  test("capacity rejection cannot retire a dirty session's replay fence", async () => {
    const old = new ControlledController(); old.tool = true;
    const rejected = new ControlledController(); let index = 0;
    const open = spyOn(SessionController, "open").mockImplementation(async (_config, _tools, callbacks) => {
      const controller = [old, rejected][index++]!; controller.callbacks = callbacks ?? {}; return controller as unknown as SessionController;
    });
    try {
      const runtime = new ProviderRuntime(readConfig({ OMP_AGY_CONTEXT_WINDOW: "400000" }));
      await runtime.stream(model, { messages: [initial] }, { sessionId: "capacity-fence" }).result(); await runtime.stop("cancel pending task");
      const fresh: UserMessage = { ...initial, content: "new explicit input but stale registry budget" };
      const response = await runtime.stream({ ...model, contextWindow: 400001 }, { messages: [initial, fresh] }, { sessionId: "capacity-fence" }).result();
      expect(response.errorMessage).toContain("runtime's context budget"); expect(runtime.snapshot().requiresNewInput).toBe(true);
      const replay = await runtime.stream(model, { messages: [initial] }, { sessionId: "capacity-fence" }).result();
      expect(replay.errorMessage).toContain("Automatic replay is blocked"); expect(open).toHaveBeenCalledTimes(2);
      expect(rejected.beginCalls).toBe(0);
    } finally { open.mockRestore(); }
  });
  test("capacity validation precedes completion of an existing pending tool result", async () => {
    const controller = new ControlledController(); controller.tool = true;
    const open = spyOn(SessionController, "open").mockImplementation(async (_config, _tools, callbacks) => {
      controller.callbacks = callbacks ?? {}; return controller as unknown as SessionController;
    });
    try {
      const runtime = new ProviderRuntime(readConfig({ OMP_AGY_CONTEXT_WINDOW: "400000" }));
      const first = await runtime.stream(model, { messages: [initial] }).result();
      const response = await runtime.stream({ ...model, contextWindow: 400001 }, { messages: [initial, first, result] }).result();
      expect(response.errorMessage).toContain("runtime's context budget"); expect(controller.completionCalls).toBe(0);
      expect(controller.beginCalls).toBe(1); expect(controller.stopCalls).toBe(0); expect(runtime.snapshot().requiresNewInput).toBe(false);
      expect((await runtime.stream(model, { messages: [initial, first, result] }).result()).stopReason).toBe("stop");
      expect(controller.completionCalls).toBe(1); expect(open).toHaveBeenCalledTimes(1);
    } finally { open.mockRestore(); }
  });
});
