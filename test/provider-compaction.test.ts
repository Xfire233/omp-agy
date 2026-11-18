import { expect, spyOn, test } from "bun:test";
import type { Model, SimpleStreamOptions, UserMessage } from "@oh-my-pi/pi-ai";
import type { Bridge } from "../src/bridge.ts";
import { readConfig } from "../src/config.ts";
import { ActivationCleanupError, SessionController, type ControllerEvent } from "../src/controller.ts";
import { ProviderRuntime } from "../src/provider.ts";
import type { CleanupReport } from "../src/runner.ts";

const model: Model = { id: "gemini-4-argon", name: "Compaction ownership fixture", identity: { class: "unknown" }, compat: undefined,
  api: "omp-agy-acp", provider: "omp-agy", baseUrl: "acp://fixture", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 400000, maxTokens: 8192 };
const message = (content: string): UserMessage => ({ role: "user", content, timestamp: 1 });
const options = (signal?: AbortSignal): SimpleStreamOptions => ({ sessionId: "same-host-session", signal,
  codexCompaction: { operationId: "host-compaction-operation", trigger: "manual", reason: "user_requested",
    phase: "standalone_turn", strategy: "memento", implementation: "responses" } });

/** Control only external ACP controllers; the provider's routing, ownership and cancellation remain real. */
class ControlledController {
  phase: SessionController["phase"] = "idle";
  failure?: Error;
  capabilities = {};
  runner = { evidence: { version: "1.5.10" } };
  models = [{ id: "gemini-4-argon", name: "Compaction fixture model" }];
  counters = { providerInvocations: 0 };
  events: ControllerEvent[] = [];
  activeFlights = 0;
  hasCandidate = false;
  stopReason = "end_turn" as const;
  version = 0;
  beginCalls = 0;
  stopCalls = 0;
  selectCalls = 0;
  cleanupFailure = false;
  beginFailure = false;
  cleanup?: CleanupReport;
  cleanupGate?: Promise<void>;
  stopEntered = Promise.withResolvers<void>();
  private stopping?: Promise<void>;
  bridge = { pendingCount: 0 } as Bridge;
  constructor(readonly answer: string) {}
  async selectModel() { this.selectCalls++; }
  async selectThinking(options: Pick<SimpleStreamOptions, "reasoning" | "disableReasoning">) {
    if (this.phase !== "idle") throw new Error("Thinking cannot change an active ACP turn");
    if (options.disableReasoning || options.reasoning !== undefined) throw new Error("Compaction fixture advertises no thinking selector");
  }
  begin() { this.beginCalls++; this.phase = "active"; if (this.beginFailure) throw new Error("Controlled ACP prompt failure"); this.events.push({ type: "text", text: this.answer }); }
  shiftEvent() { return this.events.shift(); }
  finishTurn() { this.phase = "idle"; }
  async wait() { throw new Error("Unexpected wait in controlled compaction fixture"); }
  stop() {
    if (this.stopping) return this.stopping;
    this.stopCalls++; this.phase = "stopping"; this.stopEntered.resolve();
    this.stopping = (async () => {
      await this.cleanupGate;
      this.cleanup = { status: this.cleanupFailure ? "cleanup_failed" : "stopped", generation: this.answer, workers: [], errors: this.cleanupFailure ? ["Controlled cleanup failure"] : [] };
      this.phase = this.cleanupFailure ? "cleanup_failed" : "stopped";
      if (this.cleanupFailure) this.failure = new ActivationCleanupError(this.cleanup, "Controlled cleanup failure");
    })();
    return this.stopping;
  }
  async fail(error: Error) { this.failure ??= error; await this.stop(); }
  snapshot() { return { phase: this.phase, generation: this.answer }; }
}

test("host Promise.all portable summaries own independent activations and settle only after both cleanups", async () => {
  const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const controllers = [new ControlledController("history summary"), new ControlledController("turn-prefix summary")];
  controllers.forEach((controller, index) => { controller.cleanupGate = gates[index].promise; });
  let index = 0;
  const open = spyOn(SessionController, "open").mockImplementation(async () => controllers[index++] as unknown as SessionController);
  const runtime = new ProviderRuntime(readConfig({}));
  try {
    const first = runtime.stream(model, { messages: [message("history request")] }, options()).result();
    const second = runtime.stream(model, { messages: [message("turn-prefix request")] }, options()).result();
    let settled = 0; void first.then(() => { settled++; }); void second.then(() => { settled++; });
    await Promise.all(controllers.map(controller => controller.stopEntered.promise));
    expect(open).toHaveBeenCalledTimes(2); expect(runtime.snapshot().auxiliaryActivations).toBe(2); expect(settled).toBe(0);
    gates.forEach(gate => gate.resolve());
    const results = await Promise.all([first, second]);
    expect(results.map(result => result.stopReason)).toEqual(["stop", "stop"]);
    expect(results.map(result => result.content)).toEqual([[{ type: "text", text: "history summary" }], [{ type: "text", text: "turn-prefix summary" }]]);
    expect(controllers.every(controller => controller.phase === "stopped" && controller.stopCalls === 1)).toBe(true);
    expect(runtime.snapshot().auxiliaryActivations).toBe(0);
  } finally { gates.forEach(gate => gate.resolve()); await runtime.stop("fixture cleanup"); open.mockRestore(); }
});

test("empty tool catalogs do not identify auxiliaries or bypass the interactive busy guard", async () => {
  const pending = Promise.withResolvers<SessionController>(); const controller = new ControlledController("interactive answer");
  const open = spyOn(SessionController, "open").mockReturnValue(pending.promise);
  const runtime = new ProviderRuntime(readConfig({}));
  try {
    const first = runtime.stream(model, { messages: [message("interactive first")] }).result();
    const second = await runtime.stream(model, { messages: [message("interactive second")] }).result();
    expect(second.stopReason).toBe("error"); expect(second.errorMessage).toContain("Concurrent provider consumers");
    expect(open).toHaveBeenCalledTimes(1); expect(runtime.snapshot().auxiliaryActivations).toBe(0);
    pending.resolve(controller as unknown as SessionController); expect((await first).stopReason).toBe("stop");
  } finally { pending.resolve(controller as unknown as SessionController); await runtime.stop("fixture cleanup"); open.mockRestore(); }
});

test("cancelling one cold auxiliary does not cancel its parallel sibling", async () => {
  const opening = [Promise.withResolvers<SessionController>(), Promise.withResolvers<SessionController>()];
  const controllers = [new ControlledController("cancelled"), new ControlledController("sibling summary")]; let index = 0;
  const open = spyOn(SessionController, "open").mockImplementation(() => opening[index++].promise);
  const runtime = new ProviderRuntime(readConfig({})); const cancel = new AbortController();
  try {
    const first = runtime.stream(model, { messages: [message("history")] }, options(cancel.signal)).result();
    const second = runtime.stream(model, { messages: [message("prefix")] }, options()).result();
    cancel.abort("cancel first summary"); opening.forEach((pending, index) => pending.resolve(controllers[index] as unknown as SessionController));
    const results = await Promise.all([first, second]);
    expect(results[0].stopReason).toBe("aborted"); expect(controllers[0].beginCalls).toBe(0);
    expect(results[1].stopReason).toBe("stop"); expect(controllers[1].beginCalls).toBe(1);
    expect(controllers.every(controller => controller.phase === "stopped")).toBe(true); expect(runtime.snapshot().auxiliaryActivations).toBe(0);
  } finally { opening.forEach((pending, index) => pending.resolve(controllers[index] as unknown as SessionController)); await runtime.stop("fixture cleanup"); open.mockRestore(); }
});

test("parent stop awaits cold auxiliary setup and its resulting cleanup without submitting prompts", async () => {
  const opening = Promise.withResolvers<SessionController>(); const controller = new ControlledController("cold summary");
  const open = spyOn(SessionController, "open").mockReturnValue(opening.promise);
  const runtime = new ProviderRuntime(readConfig({}));
  try {
    const result = runtime.stream(model, { messages: [message("history")] }, options()).result();
    let stopped = false; const stop = runtime.stop("parent shutdown").then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false);
    opening.resolve(controller as unknown as SessionController); await stop;
    expect((await result).stopReason).toBe("aborted"); expect(controller.beginCalls).toBe(0); expect(controller.selectCalls).toBe(0);
    expect(controller.phase).toBe("stopped"); expect(runtime.snapshot().auxiliaryActivations).toBe(0);
  } finally { opening.resolve(controller as unknown as SessionController); await runtime.stop("fixture cleanup"); open.mockRestore(); }
});

test("auxiliary prompt errors release ownership and do not poison another summary", async () => {
  const failed = new ControlledController("failed"); failed.beginFailure = true;
  const successful = new ControlledController("successful summary"); let index = 0;
  const open = spyOn(SessionController, "open").mockImplementation(async () => [failed, successful][index++] as unknown as SessionController);
  const runtime = new ProviderRuntime(readConfig({}));
  try {
    const first = await runtime.stream(model, { messages: [message("first summary")] }, options()).result();
    expect(first.stopReason).toBe("error"); expect(runtime.snapshot().auxiliaryActivations).toBe(0); expect(failed.phase).toBe("stopped");
    const second = await runtime.stream(model, { messages: [message("different summary")] }, options()).result();
    expect(second.stopReason).toBe("stop"); expect(successful.phase).toBe("stopped"); expect(open).toHaveBeenCalledTimes(2);
  } finally { await runtime.stop("fixture cleanup"); open.mockRestore(); }
});

test("unconfirmed auxiliary cleanup blocks parent admission and cannot be reported clean", async () => {
  const controller = new ControlledController("unclean summary"); controller.cleanupFailure = true;
  const open = spyOn(SessionController, "open").mockResolvedValue(controller as unknown as SessionController);
  const runtime = new ProviderRuntime(readConfig({}));
  try {
    const first = await runtime.stream(model, { messages: [message("summary")] }, options()).result();
    expect(first.stopReason).toBe("error"); expect(first.errorMessage).toContain("cleanup_failed");
    const next = await runtime.stream(model, { messages: [message("new interactive input")] }).result();
    expect(next.stopReason).toBe("error"); expect(next.errorMessage).toContain("cleanup_failed"); expect(open).toHaveBeenCalledTimes(1);
    await expect(runtime.stop("parent shutdown")).rejects.toThrow("cleanup_failed");
  } finally { open.mockRestore(); }
});

test("parallel summaries never replace the interactive controller or its context ledger", async () => {
  const primary = new ControlledController("interactive answer");
  const summaries = [new ControlledController("history summary"), new ControlledController("prefix summary")]; let index = 0;
  const open = spyOn(SessionController, "open").mockImplementation(async () => [primary, ...summaries][index++] as unknown as SessionController);
  const runtime = new ProviderRuntime(readConfig({})); const initial = message("interactive task");
  try {
    const first = await runtime.stream(model, { messages: [initial] }, { sessionId: "same-host-session" }).result();
    await Promise.all([
      runtime.stream(model, { messages: [message("history summary request")] }, options()).result(),
      runtime.stream(model, { messages: [message("prefix summary request")] }, options()).result(),
    ]);
    expect(primary.phase).toBe("idle"); expect(primary.stopCalls).toBe(0);
    const next = await runtime.stream(model, { messages: [initial, first, message("next explicit task")] }, { sessionId: "same-host-session" }).result();
    expect(next.stopReason).toBe("stop"); expect(primary.beginCalls).toBe(2); expect(open).toHaveBeenCalledTimes(3);
    expect(runtime.snapshot().rebuilds).toBe(0); expect(summaries.every(controller => controller.phase === "stopped")).toBe(true);
  } finally { await runtime.stop("fixture cleanup"); open.mockRestore(); }
});

test("parent cancellation during auxiliary cleanup waits and cannot emit terminal success", async () => {
  const controller = new ControlledController("summary awaiting cleanup"); const cleanup = Promise.withResolvers<void>();
  controller.cleanupGate = cleanup.promise;
  const open = spyOn(SessionController, "open").mockResolvedValue(controller as unknown as SessionController);
  const runtime = new ProviderRuntime(readConfig({}));
  try {
    const result = runtime.stream(model, { messages: [message("summary")] }, options()).result();
    await controller.stopEntered.promise;
    let stopped = false; const stop = runtime.stop("cancel during cleanup").then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false);
    cleanup.resolve(); await stop;
    expect((await result).stopReason).toBe("aborted"); expect(controller.stopCalls).toBe(1);
    expect(runtime.snapshot().auxiliaryActivations).toBe(0);
  } finally { cleanup.resolve(); await runtime.stop("fixture cleanup"); open.mockRestore(); }
});

test("failed cleanup inside auxiliary open fences the owning runtime even before a controller is returned", async () => {
  const report: CleanupReport = { status: "cleanup_failed", generation: "cold-failure", workers: [], errors: ["Unconfirmed cold worker cleanup"] };
  const open = spyOn(SessionController, "open").mockRejectedValue(new ActivationCleanupError(report, "Unconfirmed cold worker cleanup"));
  const runtime = new ProviderRuntime(readConfig({}));
  try {
    const first = await runtime.stream(model, { messages: [message("first summary")] }, options()).result();
    expect(first.stopReason).toBe("error"); expect(first.errorMessage).toContain("cleanup_failed");
    const next = await runtime.stream(model, { messages: [message("second summary")] }, options()).result();
    expect(next.stopReason).toBe("error"); expect(next.errorMessage).toContain("cleanup_failed");
    expect(open).toHaveBeenCalledTimes(1); expect(runtime.snapshot().auxiliaryActivations).toBe(0);
    await expect(runtime.stop("parent shutdown")).rejects.toThrow("cleanup_failed");
  } finally { open.mockRestore(); }
});

test("parallel auxiliaries share the owner's once-only D04 warning", async () => {
  const opening = [Promise.withResolvers<SessionController>(), Promise.withResolvers<SessionController>()];
  const controllers = [new ControlledController("history"), new ControlledController("prefix")]; let index = 0;
  const open = spyOn(SessionController, "open").mockImplementation(() => opening[index++].promise);
  const runtime = new ProviderRuntime(readConfig({})); const diagnostics: string[] = [];
  runtime.onDiagnostic = text => diagnostics.push(text);
  try {
    const first = runtime.stream(model, { systemPrompt: ["standalone omitted"], messages: [message("history")] }, options()).result();
    const second = runtime.stream(model, { systemPrompt: ["standalone omitted"], messages: [message("prefix")] }, options()).result();
    opening.forEach((gate, index) => gate.resolve(controllers[index] as unknown as SessionController));
    await Promise.all([first, second]);
    expect(diagnostics.filter(text => text.startsWith("D04:"))).toHaveLength(1);
  } finally { opening.forEach((gate, index) => gate.resolve(controllers[index] as unknown as SessionController)); await runtime.stop("fixture cleanup"); open.mockRestore(); }
});
