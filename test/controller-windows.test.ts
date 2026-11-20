import { expect, spyOn, test } from "bun:test";
import * as acp from "@agentclientprotocol/sdk";
import * as bridgeModule from "../src/bridge.ts";
import { readConfig } from "../src/config.ts";
import { discoverModels, SessionController, type AdvertisedModel } from "../src/controller.ts";
import type { CleanupReport, RunnerEvidence, RunnerFactory } from "../src/runner.ts";

const sessionId = "window-fixture";
const configId = "live-model-selector";
const initial = "initial";
const target = "same-as-initial";
const later = "later-in-directory";
const small = "small-tail";
const extra = "advertised-after-first-switch";
const sizes: Record<string, number> = { [initial]: 4_100, [target]: 4_100, [later]: 4_100, [small]: 900, [extra]: 1_600 };
const inventory = [initial, target, later, small];

type Response = { configOptions: acp.SessionConfigOption[] };
interface Selection {
  model: string;
  probing: boolean;
  visit: number;
  config(model?: string, selector?: string): void;
  usage(size?: number, used?: number, session?: string): void;
  response(model?: string): Response;
}

/** Replace the process, bridge and ACP transport only; exercise startup, selection and teardown. */
function fixture({ allowedModels, emitInitial = true, onSelect }: {
  allowedModels?: string[];
  emitInitial?: boolean;
  onSelect?: (selection: Selection) => Response | Promise<Response> | undefined;
} = {}) {
  const config = { ...readConfig({}), allowedModels };
  const requests: { model: string; from: string; probing: boolean }[] = [];
  let model = initial;
  let prompts = 0;
  let stopped = 0;
  let revoked = false;
  let closed = false;
  let receive!: (event: { params: acp.SessionNotification }) => void;
  const options = (currentValue: string, selector: string, ids: string[]): acp.SessionConfigOption[] => [{
    id: selector, name: "Model", category: "model", type: "select", currentValue,
    options: ids.map(value => ({ value, name: value })),
  }, {
    id: "live-thinking", name: "Thinking", category: "thought_level", type: "select",
    currentValue: `effort:${currentValue}`, options: [{ value: `effort:${currentValue}`, name: currentValue }],
  }];
  const usage = (size: number, used = 0, session = sessionId) => receive({ params: { sessionId: session,
    update: { sessionUpdate: "usage_update", used, size } } });
  const connection = {
    closed: new Promise<void>(() => {}),
    close() { closed = true; },
    agent: {
      async notify() {},
      async request(method: string, params?: { sessionId?: string; configId?: string; value?: string }, requestOptions?: { cancellationSignal?: AbortSignal }) {
        if (method === acp.methods.agent.initialize) return { protocolVersion: acp.PROTOCOL_VERSION,
          agentCapabilities: { mcpCapabilities: { http: true } } };
        if (method === acp.methods.agent.session.new) {
          // Deliberately deliver before the response assigns the controller's session ID.
          if (emitInitial) usage(sizes[initial]);
          return { sessionId, configOptions: options(initial, configId, inventory) };
        }
        if (method === acp.methods.agent.session.prompt) { prompts++; return { stopReason: "end_turn" }; }
        if (method !== acp.methods.agent.session.setConfigOption || !params?.value) throw new Error(`Unexpected request ${method}`);
        expect(params.sessionId).toBe(sessionId);
        expect(params.configId).toBe(configId);
        const from = model;
        const requested = params.value;
        model = requested;
        const probing = !!requestOptions?.cancellationSignal;
        requests.push({ model: requested, from, probing });
        const selection: Selection = { model: requested, probing,
          visit: requests.filter(request => request.probing && request.model === requested).length,
          config(selected = requested, selector = configId) { receive({ params: { sessionId,
            update: { sessionUpdate: "config_option_update", configOptions: options(selected, selector, [...inventory, extra]) } } }); },
          usage(size = sizes[requested], used = 0, session = sessionId) { usage(size, used, session); },
          response(selected = requested) { return { configOptions: options(selected, configId, [...inventory, extra]) }; },
        };
        const override = onSelect?.(selection);
        if (override !== undefined) return override;
        selection.config();
        if (sizes[from] !== sizes[model]) selection.usage();
        return selection.response();
      },
    },
  };
  const builder = {
    onNotification(_method: string, handler: typeof receive) { receive = handler; return this; },
    onRequest() { return this; },
    connect() { return connection; },
  };
  const peer = spyOn(acp, "client").mockImplementation(() => builder as unknown as acp.ClientApp);
  const bridge = spyOn(bridgeModule, "createBridge").mockResolvedValue({
    url: "http://127.0.0.1:1/mcp", token: "fixture", aliases: [],
    pendingCount: 0, deliveredCount: 0, beginTurn() {}, endTurn() {},
    snapshot: () => ({ accepting: !revoked, initialized: true, catalogReadCount: 1 }),
    async revoke() { revoked = true; },
  } as unknown as bridgeModule.Bridge);
  const evidence = { generation: sessionId, workers: [] } as unknown as RunnerEvidence;
  const cleanup: CleanupReport = { status: "stopped", generation: sessionId, workers: [], errors: [] };
  const stop = async () => { stopped++; return cleanup; };
  const bootstrap: RunnerFactory = async () => ({
    gateway: "127.0.0.1", sourceAddress: "127.0.0.2", workspace: "/fixture", evidence, stop,
    async startUsage() { throw new Error("Discovery does not call quota"); },
    async start({ aliases }) {
      expect(aliases).toEqual([]);
      return { evidence, stop, exited: new Promise<number>(() => {}),
        stdin: new WritableStream<Uint8Array>(), stdout: new ReadableStream<Uint8Array>() };
    },
  });
  return { config, bootstrap, requests, usage,
    get probes() { return requests.filter(request => request.probing); },
    get prompts() { return prompts; },
    get stopped() { return stopped; }, get revoked() { return revoked; }, get closed() { return closed; },
    open(observeModelWindows = true) { return SessionController.open(config, [], { observeModelWindows }, undefined, undefined, bootstrap); },
    restore() { bridge.mockRestore(); peer.mockRestore(); },
  };
}

function expectDirectory(models: AdvertisedModel[], ids = inventory) {
  expect(models.map(item => [item.id, item.thinking?.currentValue])).toEqual(ids.map(id => [id, `effort:${id}`]));
}

test("measures same-size peers via new, repeated transitions from the live alternate anchor", async () => {
  const state = fixture({ emitInitial: false });
  let controller: SessionController | undefined;
  try {
    controller = await state.open();
    expect(controller.modelContextWindows.size).toBe(0);
    const discovery = controller.discoverModelOptions();
    expect(state.requests).toHaveLength(0);
    state.usage(sizes[initial]);
    expectDirectory(await discovery);
    expect(state.probes[0]).toEqual({ model: small, from: initial, probing: true });
    for (const id of [initial, target, later]) {
      expect(state.probes.filter(step => step.model === id).map(step => step.from)).toEqual([small, small]);
    }
    expect(state.probes.filter(step => step.model === small).every(step => step.from !== small)).toBe(true);
    expect(state.requests.some(step => step.model === extra)).toBe(false);
    expect(controller.contextUsage).toBeUndefined();
    expect(state.prompts).toBe(0);
    await controller.stop();
    expect(controller.modelContextWindows).toEqual(new Map(inventory.map(id => [id, sizes[id]])));
  } finally { await controller?.stop(); state.restore(); }
});

test("an excluded default can seed the pass but is never selected or published", async () => {
  const state = fixture({ allowedModels: [target, small, extra] });
  let controller: SessionController | undefined;
  try {
    controller = await state.open();
    expectDirectory(await controller.discoverModelOptions(), [target, small]);
    expect(state.requests.every(step => step.model === target || step.model === small)).toBe(true);
    expect(controller.modelContextWindows).toEqual(new Map([[target, sizes[target]], [small, sizes[small]]]));
  } finally { await controller?.stop(); state.restore(); }
});

for (const fault of ["silence", "usage before config", "foreign usage", "wrong selector", "unconfirmed response", "nonempty usage", "conflict", "disagreement on repeat"] as const) {
  test(`${fault} cannot prove a window or carry evidence forward`, async () => {
    let late: (() => void) | undefined;
    const state = fixture({ onSelect(selection) {
      if (!selection.probing) { late?.(); late = undefined; return; }
      if (selection.model !== target) return;
      if (fault === "disagreement on repeat" && selection.visit === 1) return;
      if (fault === "usage before config") selection.usage();
      selection.config(undefined, fault === "wrong selector" ? "other-selector" : undefined);
      switch (fault) {
        case "silence":
          late = () => { selection.config(target); selection.usage(sizes[target]); };
          break;
        case "foreign usage": selection.usage(undefined, 0, "different-session"); break;
        case "nonempty usage": selection.usage(undefined, 1); break;
        case "disagreement on repeat": selection.usage(sizes[target] + 1); break;
        case "conflict":
          selection.usage();
          queueMicrotask(() => selection.usage(sizes[target] + 1));
          break;
        default: if (fault !== "usage before config") selection.usage();
      }
      return selection.response(fault === "unconfirmed response" ? initial : undefined);
    } });
    let controller: SessionController | undefined;
    try {
      controller = await state.open();
      expectDirectory(await controller.discoverModelOptions());
      expect(state.probes.at(-1)?.model).toBe(target);
      expect(controller.contextUsage).toBeUndefined();
      expect(controller.modelContextWindows).toEqual(new Map([[initial, sizes[initial]], [small, sizes[small]]]));
    } finally { await controller?.stop(); state.restore(); }
  });
}

test("a late RPC response cannot replace a confirmed thinking selector after a probe timeout", async () => {
  const held = Promise.withResolvers<Response>();
  let late: (() => void) | undefined;
  const state = fixture({ onSelect(selection) {
    if (selection.probing) {
      selection.config(); selection.usage();
      late = () => held.resolve(selection.response(small));
      return held.promise;
    }
    late?.(); late = undefined;
  } });
  let controller: SessionController | undefined;
  try {
    controller = await state.open();
    expectDirectory(await controller.discoverModelOptions());
    expect(state.probes.map(step => step.model)).toEqual([small]);
    expect(controller.modelContextWindows.size).toBe(0);
  } finally { await controller?.stop(); state.restore(); }
});

for (const mode of ["missing startup signal", "normal activation", "previously selected"] as const) {
  test(`${mode} enumerates thinking without window probes`, async () => {
    const state = fixture({ emitInitial: mode !== "missing startup signal" });
    let controller: SessionController | undefined;
    try {
      controller = await state.open(mode !== "normal activation");
      if (mode === "previously selected") await controller.selectModel(small);
      expectDirectory(await controller.discoverModelOptions(), mode === "previously selected" ? [...inventory, extra] : inventory);
      expect(state.probes).toHaveLength(0);
      expect(controller.modelContextWindows.size).toBe(0);
      expect(controller.contextUsage).toBeUndefined();
      expect(state.prompts).toBe(0);
    } finally { await controller?.stop(); state.restore(); }
  });
}

test("returning to idle after generation cannot restore the startup baseline", async () => {
  const state = fixture();
  let controller: SessionController | undefined;
  try {
    controller = await state.open();
    controller.begin([{ type: "text", text: "fixture input" }]);
    state.usage(sizes[initial], 22);
    expect(controller.contextUsage).toMatchObject({ used: 22, size: sizes[initial] });
    while (controller.activeFlights) await controller.wait(controller.version);
    controller.finishTurn();
    expectDirectory(await controller.discoverModelOptions());
    expect(state.prompts).toBe(1);
    expect(state.probes).toHaveLength(0);
    expect(controller.modelContextWindows.size).toBe(0);
  } finally { await controller?.stop(); state.restore(); }
});

test("owner cancellation interrupts a pending probe and completes discovery cleanup", async () => {
  const entered = Promise.withResolvers<void>();
  const never = new Promise<Response>(() => {});
  const state = fixture({ onSelect(selection) {
    if (selection.probing) { entered.resolve(); return never; }
  } });
  const abort = new AbortController();
  const reason = new Error("discovery owner cancelled");
  try {
    const result = discoverModels(state.config, { bootstrap: state.bootstrap, signal: abort.signal }).catch(error => error);
    await entered.promise;
    abort.abort(reason);
    expect(await result).toBe(reason);
    expect(state.requests).toHaveLength(1);
    expect(state.stopped).toBe(1);
    expect(state.revoked).toBe(true);
    expect(state.closed).toBe(true);
    expect(state.prompts).toBe(0);
  } finally { abort.abort(reason); state.restore(); }
});
