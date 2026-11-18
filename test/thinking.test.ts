import { expect, spyOn, test } from "bun:test";
import * as acp from "@agentclientprotocol/sdk";
import { Effort } from "@oh-my-pi/pi-ai";
import type { Bridge } from "../src/bridge.ts";
import { readConfig } from "../src/config.ts";
import { discoverModels, SessionController } from "../src/controller.ts";
import type { CleanupReport, RunningRunner } from "../src/runner.ts";
import { ThinkingSelectionError, type ThoughtOptions } from "../src/protocol.ts";
import { thinkingMetadata } from "../src/thinking.ts";

type ConfigResponse = acp.SetSessionConfigOptionResponse;
type ControlledResponse = ConfigResponse | acp.PromptResponse;
interface ControlledResponseResolver {
  promise: Promise<ControlledResponse>;
  resolve(value: ControlledResponse | PromiseLike<ControlledResponse>): void;
  reject(reason?: unknown): void;
}
type Select = Extract<acp.SessionConfigOption, { type: "select" }>;
const modelOptions = [{ value: "alpha", name: "Alpha" }, { value: "beta", name: "Beta" }];
const levels = [{ value: "high", name: "High" }, { value: "low", name: "Low" }, { value: "medium", name: "Medium" }];
const model = (currentValue = "alpha", options = modelOptions): Select => ({
  id: "live-model-id", category: "model", name: "Model", type: "select", currentValue, options,
});
const thought = (currentValue = "medium", options: acp.SessionConfigSelectOptions = levels): Select => ({
  id: "agent-specific-effort-id", category: "thought_level", name: "Thinking strength", type: "select", currentValue, options,
});
interface ConfigSeam {
  connection: {
    agent: { request(method: string, params: { configId?: string; value?: string }): Promise<ControlledResponse>; notify(): Promise<void> };
    close(): void;
  };
  update(notification: acp.SessionNotification): void;
}

/** Control only transport responses; all selector state, request bounds and cleanup are the real controller. */
function fixture(configOptions: acp.SessionConfigOption[], allowedModels?: string[]) {
  const controller = Reflect.construct(SessionController, [readConfig({}), {}]) as SessionController;
  if (allowedModels) controller.config.allowedModels = allowedModels;
  const seam = controller as unknown as ConfigSeam;
  const requests: { method: string; configId?: string; value?: string; response: ControlledResponseResolver }[] = [];
  let requestEntered = Promise.withResolvers<void>();
  let stopped = 0; let revoked = false; let closed = false;
  const cleanup: CleanupReport = { status: "stopped", generation: "thinking-fixture", workers: [], errors: [] };
  seam.connection = {
    agent: {
      request(method, params) {
        const response = Promise.withResolvers<ControlledResponse>();
        requests.push({ method, configId: params.configId, value: params.value, response });
        const entered = requestEntered;
        requestEntered = Promise.withResolvers<void>();
        entered.resolve();
        return response.promise;
      },
      async notify() {},
    },
    close() { closed = true; for (const request of requests) request.response.reject(new Error("controlled transport closed")); },
  };
  controller.bridge = { pendingCount: 0, deliveredCount: 0, beginTurn() {}, endTurn() {},
    snapshot: () => ({ revoked }), async revoke() { revoked = true; } } as unknown as Bridge;
  controller.runner = { evidence: { generation: "thinking-fixture", workers: [] }, async stop() { stopped++; return cleanup; } } as unknown as RunningRunner;
  controller.sessionId = "thinking-fixture-session"; controller.phase = "idle";
  const update = (options: acp.SessionConfigOption[]) => seam.update({ sessionId: controller.sessionId,
    update: { sessionUpdate: "config_option_update", configOptions: options } });
  const usage = (used: number, size = 100000) => seam.update({ sessionId: controller.sessionId,
    update: { sessionUpdate: "usage_update", used, size } });
  update(configOptions);
  return { controller, requests, update, usage, nextRequest: () => requestEntered.promise,
    get stopped() { return stopped; }, get revoked() { return revoked; }, get closed() { return closed; } };
}

const metadata = (currentValue: string, options = levels): ThoughtOptions => ({ configId: "live-thought", currentValue, options });

test("native effort metadata uses exact canonical values in host order without inventing labels or defaults", () => {
  const advertised = metadata("xhigh", [{ value: "xhigh", name: "Extra" }, ...levels,
    { value: "off", name: "Disabled" }, { value: "experimental", name: "Maximum" }, { value: "HIGH", name: "High alias" }]);
  expect(thinkingMetadata(advertised)).toEqual({ reasoning: true, thinking: {
    mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh], defaultLevel: Effort.XHigh,
  } });
  expect(advertised.options[0]).toEqual({ value: "xhigh", name: "Extra" });
  expect(thinkingMetadata(metadata("experimental"))).toEqual({ reasoning: true,
    thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High] } });
  expect(thinkingMetadata()).toEqual({ reasoning: false });
  expect(thinkingMetadata(metadata("off", [{ value: "off", name: "Off" }]))).toEqual({ reasoning: false });
  expect(thinkingMetadata(metadata("experimental", [{ value: "experimental", name: "High" }]))).toEqual({ reasoning: false });
  expect(() => thinkingMetadata(metadata("high", [{ value: "high", name: "High" }, { value: "high", name: "Extra" }]))).toThrow("duplicate");
});

test("grouped live selector uses its actual id and native labels, and config notifications replace its snapshot", async () => {
  const state = fixture([model(), thought("xhigh", [{ group: "strength", name: "Strength", options: [
    { value: "high", name: "High" }, { value: "xhigh", name: "Extra" },
  ] }])]);
  try {
    expect(state.controller.thinking).toEqual({ configId: "agent-specific-effort-id", currentValue: "xhigh", options: [
      { value: "high", name: "High" }, { value: "xhigh", name: "Extra" },
    ] });
    expect(state.controller.snapshot().thinking).toBe(state.controller.thinking);
    state.update([model(), thought("low")]);
    expect(state.controller.thinking?.currentValue).toBe("low");
    state.update([model("beta")]);
    expect(state.controller.thinking).toBeUndefined();
    expect(state.controller.snapshot().thinking).toBeUndefined();
  } finally { await state.controller.stop(); }
});

test("no explicit effort preserves live choice, equal effort avoids RPC, and actual off is required for disable", async () => {
  const state = fixture([model(), thought("medium")]);
  try {
    await state.controller.selectThinking({});
    await state.controller.selectThinking({ disableReasoning: false });
    await state.controller.selectThinking({ reasoning: Effort.Medium });
    expect(state.requests).toHaveLength(0);
    await expect(state.controller.selectThinking({ disableReasoning: true })).rejects.toThrow("not advertised");
    await expect(state.controller.selectThinking({ reasoning: Effort.XHigh })).rejects.toBeInstanceOf(ThinkingSelectionError);
    expect(state.requests).toHaveLength(0); expect(state.controller.phase).toBe("idle");
    state.update([model(), thought("medium", [...levels, { value: "off", name: "Off" }])]);
    const selected = state.controller.selectThinking({ reasoning: Effort.High, disableReasoning: true });
    expect(state.requests[0].value).toBe("off");
    state.requests[0].response.resolve({ configOptions: [model(), thought("off", [...levels, { value: "off", name: "Off" }])] });
    await selected;
    expect(state.controller.thinking?.currentValue).toBe("off");
  } finally { await state.controller.stop(); }
});

test("models without a thought selector preserve native behavior but cannot claim a requested effort or disabling", async () => {
  const state = fixture([model()]);
  try {
    await state.controller.selectThinking({});
    await expect(state.controller.selectThinking({ reasoning: Effort.Low })).rejects.toThrow("unavailable");
    await expect(state.controller.selectThinking({ disableReasoning: true })).rejects.toThrow("unavailable");
    expect(state.requests).toHaveLength(0);
    state.controller.phase = "active";
    await expect(state.controller.selectThinking({})).rejects.toThrow("idle");
    await expect(state.controller.discoverModelOptions()).rejects.toThrow("idle");
  } finally { await state.controller.stop(); }
});

test("thinking selection waits for the full response and confirms the requested live model and option", async () => {
  const state = fixture([model(), thought()]);
  try {
    let settled = false;
    const selected = state.controller.selectThinking({ reasoning: Effort.High }).then(() => { settled = true; });
    expect(state.requests).toHaveLength(1);
    expect(state.requests[0]).toMatchObject({ method: acp.methods.agent.session.setConfigOption,
      configId: "agent-specific-effort-id", value: "high" });
    state.update([model(), thought("high")]);
    await Promise.resolve();
    expect(settled).toBe(false);
    state.requests[0].response.resolve({ configOptions: [model(), thought("high")] });
    await selected;
    expect(state.controller.selectedModel).toBe("alpha");
    expect(state.controller.thinking?.currentValue).toBe("high");
    expect(state.controller.phase).toBe("idle");
  } finally { await state.controller.stop(); }
});

for (const [name, configOptions] of [
  ["missing selector", [model()]],
  ["wrong current option", [model(), thought("low")]],
  ["removed requested option", [model(), thought("high", [{ value: "low", name: "Low" }])]],
  ["different selector identity", [model(), { ...thought("high"), id: "changed-selector" }]],
  ["different model", [model("beta"), thought("high")]],
  ["unadvertised current model", [model("alpha", [modelOptions[1]]), thought("high")]],
  ["missing model", [thought("high")]],
] as const) {
  test(`thinking confirmation rejects ${name} without submitting a prompt`, async () => {
    const state = fixture([model(), thought()]);
    try {
      const selected = state.controller.selectThinking({ reasoning: Effort.High });
      state.requests[0].response.resolve({ configOptions: [...configOptions] });
      await expect(selected).rejects.toBeInstanceOf(ThinkingSelectionError);
      expect(state.requests).toHaveLength(1); expect(state.controller.phase).toBe("idle");
    } finally { await state.controller.stop(); }
  });
}

for (const configOptions of [
  [model(), thought("high", [{ value: "high", name: "High" }, { value: "high", name: "Extra" }])],
  [model(), thought(), { ...thought(), id: "second-thought-selector" }],
  [model(), { id: "boolean-thought", category: "thought_level", type: "boolean", name: "Thinking", currentValue: true }],
] satisfies acp.SessionConfigOption[][]) {
  test("ambiguous live thought selectors are rejected rather than guessed", async () => {
    const state = fixture(configOptions);
    try {
      await expect(state.controller.selectThinking({ reasoning: Effort.High })).rejects.toBeInstanceOf(ThinkingSelectionError);
      await expect(state.controller.discoverModelOptions()).rejects.toBeInstanceOf(ThinkingSelectionError);
      expect(state.requests).toHaveLength(0);
    } finally { await state.controller.stop(); }
  });
}

test("thinking request uses the controller setup deadline and leaves no deadline behind", async () => {
  const state = fixture([model(), thought()]);
  const timers = new Map<Timer, () => void>(); let sequence = 0;
  const schedule = spyOn(globalThis, "setTimeout").mockImplementation(((run: () => void) => {
    const timer = ++sequence as unknown as Timer; timers.set(timer, run); return timer;
  }) as typeof setTimeout);
  const cancel = spyOn(globalThis, "clearTimeout").mockImplementation(timer => { timers.delete(timer as Timer); });
  try {
    const selected = state.controller.selectThinking({ reasoning: Effort.High });
    // Observe asynchronously before driving the response: Bun's rejects matcher blocks here.
    const failed = selected.then(() => undefined, error => error);
    expect(timers.size).toBe(1);
    for (const run of timers.values()) run();
    expect(await failed).toMatchObject({ message: expect.stringContaining("ACP setup timed out") });
    expect(timers.size).toBe(0); expect(state.controller.phase).toBe("idle");
    expect(state.requests).toHaveLength(1);
  } finally { await state.controller.stop(); cancel.mockRestore(); schedule.mockRestore(); }
});

test("discovery selects the initially allowed models serially and captures per-model post-confirmation selectors", async () => {
  const extra = { value: "later-model", name: "Later" };
  const state = fixture([model("beta", [...modelOptions, { value: "blocked", name: "Blocked" }]), thought()], ["alpha", "beta", "later-model"]);
  try {
    const discovered = state.controller.discoverModelOptions();
    expect(state.requests).toHaveLength(1); expect(state.requests[0].value).toBe("alpha");
    const nextRequest = state.nextRequest();
    state.requests[0].response.resolve({ configOptions: [model("alpha", [...modelOptions, extra]), thought("xhigh", [
      { value: "high", name: "High" }, { value: "xhigh", name: "Extra" },
    ])] });
    await nextRequest;
    expect(state.requests).toHaveLength(2); expect(state.requests[1].value).toBe("beta");
    state.requests[1].response.resolve({ configOptions: [model("beta", [...modelOptions, extra])] });
    const models = await discovered;
    expect(models).toEqual([{ id: "alpha", name: "Alpha", thinking: {
      configId: "agent-specific-effort-id", currentValue: "xhigh", options: [
        { value: "high", name: "High" }, { value: "xhigh", name: "Extra" },
      ],
    } }, { id: "beta", name: "Beta" }]);
    expect(state.controller.thinking).toBeUndefined(); expect(state.requests).toHaveLength(2);
  } finally { await state.controller.stop(); }
});

test("exposed discovery cleans its actual controller when per-model confirmation fails", async () => {
  const state = fixture([model("beta"), thought()]);
  const open = spyOn(SessionController, "open").mockResolvedValue(state.controller);
  try {
    const nextRequest = state.nextRequest();
    const discovered = discoverModels(readConfig({}));
    const failed = discovered.then(() => undefined, error => error);
    await nextRequest;
    expect(state.requests).toHaveLength(1);
    state.requests[0].response.resolve({ configOptions: [model("beta"), thought()] });
    expect(await failed).toMatchObject({ message: expect.stringContaining("did not confirm model") });
    expect(state.controller.phase).toBe("stopped");
    expect(state.stopped).toBe(1); expect(state.revoked).toBe(true); expect(state.closed).toBe(true);
  } finally { await state.controller.stop(); open.mockRestore(); }
});

test("context usage is owned by actual generation, never discovery or an in-flight model transition", async () => {
  const state = fixture([model(), thought()]);
  const complete = async (index: number) => {
    const version = state.controller.version;
    state.requests[index].response.resolve({ stopReason: "end_turn" });
    await state.controller.wait(version);
    state.controller.finishTurn();
  };
  try {
    state.usage(100);
    expect(state.controller.contextUsage).toBeUndefined();
    state.controller.begin([{ type: "text", text: "alpha generation" }]);
    state.usage(200);
    expect(state.controller.contextUsage?.used).toBe(200);
    await complete(0);
    state.usage(250);
    expect(state.controller.contextUsage?.used).toBe(250);

    const selecting = state.controller.selectModel("beta");
    expect(state.controller.contextUsage).toBeUndefined();
    expect(() => state.controller.begin([{ type: "text", text: "not confirmed" }])).toThrow("before configuration");
    state.usage(999);
    state.update([model("beta"), thought()]);
    state.usage(998);
    expect(state.controller.contextUsage).toBeUndefined();
    state.requests[1].response.resolve({ configOptions: [model("beta"), thought()] });
    await selecting;
    state.usage(997);
    expect(state.controller.contextUsage).toBeUndefined();

    state.controller.begin([{ type: "text", text: "beta generation" }]);
    state.usage(300);
    expect(state.controller.contextUsage?.used).toBe(300);
    await complete(2);
    state.usage(350);
    expect(state.controller.contextUsage?.used).toBe(350);
    const thinking = state.controller.selectThinking({ reasoning: Effort.High });
    state.usage(996);
    expect(state.controller.contextUsage?.used).toBe(350);
    state.requests[3].response.resolve({ configOptions: [model("beta"), thought("high")] });
    await thinking;
    state.usage(400);
    expect(state.controller.contextUsage?.used).toBe(400);

    state.update([model("alpha"), thought()]);
    expect(state.controller.contextUsage).toBeUndefined();
    state.usage(995);
    expect(state.controller.contextUsage).toBeUndefined();
  } finally { await state.controller.stop(); }
});
