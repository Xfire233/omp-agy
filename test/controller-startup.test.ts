import { expect, spyOn, test } from "bun:test";
import * as acp from "@agentclientprotocol/sdk";
import * as bridgeModule from "../src/bridge.ts";
import type { Bridge } from "../src/bridge.ts";
import * as runnerModule from "../src/runner.ts";
import type { CleanupReport, PreparedRunner, RunnerEvidence, RunningRunner } from "../src/runner.ts";
import { readConfig } from "../src/config.ts";
import { SessionController } from "../src/controller.ts";

/** Only external process/SDK boundaries are controlled; exercise SessionController.open and its cleanup. */
function startupFixture(initialized: boolean, catalogReadCount: number, nondefaultModel = false) {
  let stopped = 0;
  let revoked = false;
  let turns = 0;
  let dispatched = 0;
  let connectionCloses = 0;
  let bridgeOptions: Parameters<typeof bridgeModule.createBridge>[0] | undefined;
  const waiting = Promise.withResolvers<SessionController>();
  const exited = Promise.withResolvers<number>();
  const runnerStarting = Promise.withResolvers<void>();
  let runnerStartWait: Promise<void> | undefined;
  const requestGates = new Map<string, { entered: () => void; wait: Promise<void>; reject: (error: Error) => void }>();
  const originalWait = SessionController.prototype.wait;
  const wait = spyOn(SessionController.prototype, "wait").mockImplementation(function (this: SessionController, previous, signal) {
    waiting.resolve(this);
    return originalWait.call(this, previous, signal);
  });
  const methods: string[] = [];
  const closed = Promise.withResolvers<void>();
  const evidence = { generation: "controlled-startup", workers: [] } as unknown as RunnerEvidence;
  const cleanup: CleanupReport = { status: "stopped", generation: evidence.generation, workers: [], errors: [] };
  const stop = async () => { stopped++; return cleanup; };
  const running: RunningRunner = { evidence, stop, exited: exited.promise,
    stdin: new WritableStream<Uint8Array>(), stdout: new ReadableStream<Uint8Array>() };
  const prepared: PreparedRunner = { gateway: "127.0.0.1", sourceAddress: "127.0.0.2", workspace: "/controlled", evidence,
    startUsage: async () => { throw new Error("ACP startup must not invoke quota"); },
    start: async () => { runnerStarting.resolve(); await runnerStartWait; return running; }, stop };
  const bridge: Bridge = {
    url: "http://127.0.0.1:1/mcp", token: "controlled-not-a-credential", aliases: [],
    catalog: { tools: [], aliases: [], originalToAlias: new Map(), aliasToOriginal: new Map(),
      resolve: () => undefined, validate: (_name, _value): asserts _value is Record<string, unknown> => {} },
    pendingCount: 0, deliveredCount: 0,
    snapshot: () => ({ accepting: !revoked, revoked, initialized, catalogReadCount, activeTurn: false,
      sessionCount: initialized && !revoked ? 1 : 0, connections: 0, pendingCount: 0, queuedCount: 0,
      dispatchedCount: 0, deliveringCount: 0, deliveredCount: 0 }),
    beginTurn() { turns++; }, endTurn() {}, takeNext() { dispatched++; return undefined; }, async complete() {}, async revoke() { revoked = true; },
  };
  const connection = { closed: closed.promise, close(reason = new Error("controlled connection closed")) {
    connectionCloses++; closed.resolve();
    for (const gate of requestGates.values()) gate.reject(reason);
  }, agent: {
    async request(method: string) {
      methods.push(method);
      const gate = requestGates.get(method);
      if (gate) {
        gate.entered();
        try { await gate.wait; }
        finally { requestGates.delete(method); }
      }
      if (method === acp.methods.agent.initialize) return { protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { mcpCapabilities: { http: true }, promptCapabilities: {} } };
      if (method === acp.methods.agent.session.new) return { sessionId: "controlled-acp-success", configOptions: [
        { id: "model", category: "model", name: "Model", type: "select", currentValue: "actual-fixture-model",
          options: [{ value: "actual-fixture-model", name: "Actual fixture model" },
            ...(nondefaultModel ? [{ value: "nondefault-model", name: "Requested nondefault model" }] : [])] },
      ] };
      if (method === acp.methods.agent.session.setConfigOption) return { configOptions: [
        { id: "model", category: "model", name: "Model", type: "select", currentValue: "nondefault-model",
          options: [{ value: "actual-fixture-model", name: "Actual fixture model" }, { value: "nondefault-model", name: "Requested nondefault model" }] },
      ] };
      throw new Error(`Unexpected ACP request ${method}`);
    },
    async notify() {},
  } };
  const builder = { onNotification() { return this; }, onRequest() { return this; }, connect() { return connection; } };
  const bootstrap = spyOn(runnerModule, "bootstrapRunner").mockResolvedValue(prepared);
  const createBridge = spyOn(bridgeModule, "createBridge").mockImplementation(async options => { bridgeOptions = options; return bridge; });
  const client = spyOn(acp, "client").mockImplementation(() => builder as unknown as ReturnType<typeof acp.client>);
  return { methods, bootstrap, bridge, waiting: waiting.promise,
    get stopped() { return stopped; }, get revoked() { return revoked; }, get turns() { return turns; },
    get dispatched() { return dispatched; }, get connectionCloses() { return connectionCloses; },
    get pendingRequests() { return requestGates.size; },
    blockRequest(method: string) {
      const entered = Promise.withResolvers<void>(); const response = Promise.withResolvers<void>();
      requestGates.set(method, { entered: entered.resolve, wait: response.promise, reject: response.reject });
      return entered.promise;
    },
    blockRunnerStart() {
      const gate = Promise.withResolvers<void>(); runnerStartWait = gate.promise;
      return { entered: runnerStarting.promise, release: gate.resolve };
    },
    activity(authenticated: boolean, reads: number) { initialized = authenticated; catalogReadCount = reads; bridgeOptions!.onActivity(); },
    fatal(error: Error) { revoked = true; bridgeOptions!.onFatal(error); },
    closeConnection() { closed.resolve(); }, exit(code: number) { exited.resolve(code); },
    restore() { wait.mockRestore(); client.mockRestore(); createBridge.mockRestore(); bootstrap.mockRestore(); },
  };
}

/** Own only platform deadlines; test success and failure are driven by actual controller signals. */
function startupClock() {
  let now = 0;
  let sequence = 0;
  const timers = new Map<Timer, { at: number; run: () => void }>();
  const schedule = spyOn(globalThis, "setTimeout").mockImplementation(((run: () => void, delay: number) => {
    const timer = ++sequence as unknown as Timer;
    timers.set(timer, { at: now + delay, run });
    return timer;
  }) as typeof setTimeout);
  const cancel = spyOn(globalThis, "clearTimeout").mockImplementation(timer => { timers.delete(timer as Timer); });
  return {
    get pending() { return timers.size; },
    advance(milliseconds: number) {
      now += milliseconds;
      for (const [timer, entry] of [...timers]) if (entry.at <= now) { timers.delete(timer); entry.run(); }
    },
    restore() { cancel.mockRestore(); schedule.mockRestore(); },
  };
}

function pendingWaiters(controller: SessionController): number {
  return (Reflect.get(controller, "waiters") as Set<() => void>).size;
}

function startupFailure(opened: Promise<SessionController>): Promise<Error | undefined> {
  return opened.then(() => undefined, (error: unknown) => error instanceof Error ? error : new Error(String(error)));
}

const readinessConfig = readConfig({ OMP_AGY_STARTUP_TIMEOUT_MS: "1024" });

for (const initialized of [false, true]) {
  test(`successful ACP setup with initialized=${initialized} but no authenticated tools/list times out before admission`, async () => {
    const time = startupClock(); const state = startupFixture(initialized, 0);
    const outcome = startupFailure(SessionController.open(readinessConfig, []));
    try {
      const starting = await state.waiting;
      expect(starting.phase).toBe("starting"); expect(time.pending).toBe(1);
      time.advance(1024);
      expect((await outcome)?.message).toContain("authenticated initialization and tools/list");
      expect(state.methods).toEqual([acp.methods.agent.initialize, acp.methods.agent.session.new]);
      expect(state.turns).toBe(0); expect(state.dispatched).toBe(0);
      expect(state.revoked).toBe(true); expect(state.stopped).toBe(1); expect(state.connectionCloses).toBe(1);
      expect(pendingWaiters(starting)).toBe(0); expect(time.pending).toBe(0);
    } finally { state.restore(); time.restore(); }
  });
}

test("late authenticated tools/list wakes startup without admitting prompts or tool dispatch early", async () => {
  const time = startupClock(); const state = startupFixture(true, 0); let controller: SessionController | undefined;
  try {
    const opened = SessionController.open(readinessConfig, []);
    const starting = await state.waiting;
    expect(starting.phase).toBe("starting");
    expect(() => starting.begin([{ type: "text", text: "must not submit" }])).toThrow("while starting");
    expect(starting.takeNext()).toBeUndefined();
    expect(state.turns).toBe(0); expect(state.dispatched).toBe(0);
    expect(state.methods).toEqual([acp.methods.agent.initialize, acp.methods.agent.session.new]);
    time.advance(50); state.activity(true, 1);
    controller = await opened;
    expect(controller.phase).toBe("idle"); expect(state.stopped).toBe(0);
    expect(pendingWaiters(controller)).toBe(0); expect(time.pending).toBe(0);
  } finally { await controller?.stop(); state.restore(); time.restore(); }
});

test("a catalog count without authenticated initialization remains closed until the deadline", async () => {
  const time = startupClock(); const state = startupFixture(false, 1);
  const outcome = startupFailure(SessionController.open(readinessConfig, []));
  try {
    const starting = await state.waiting;
    time.advance(1024);
    expect((await outcome)?.message).toContain("authenticated initialization and tools/list");
    expect(state.turns).toBe(0); expect(state.dispatched).toBe(0);
    expect(state.revoked).toBe(true); expect(state.stopped).toBe(1);
    expect(pendingWaiters(starting)).toBe(0); expect(time.pending).toBe(0);
  } finally { state.restore(); time.restore(); }
});

for (const interruption of ["abort", "stop", "fatal", "connection-close", "runner-exit"] as const) {
  test(`startup readiness ${interruption} promptly rejects and removes its deadline and waiter`, async () => {
    const time = startupClock(); const state = startupFixture(true, 0); const abort = new AbortController();
    const outcome = startupFailure(SessionController.open(readinessConfig, [], {}, abort.signal));
    try {
      const starting = await state.waiting;
      const reason = new Error(`controlled startup ${interruption}`);
      if (interruption === "abort") abort.abort(reason);
      else if (interruption === "stop") void starting.stop(reason);
      else if (interruption === "fatal") state.fatal(reason);
      else if (interruption === "connection-close") state.closeConnection();
      else state.exit(17);
      expect((await outcome)?.message).toContain(interruption === "connection-close" ? "ACP connection closed unexpectedly" :
        interruption === "runner-exit" ? "AGY supervisor exited (17)" : reason.message);
      expect(state.revoked).toBe(true); expect(state.stopped).toBe(1); expect(state.connectionCloses).toBe(1);
      expect(state.turns).toBe(0); expect(state.dispatched).toBe(0);
      expect(pendingWaiters(starting)).toBe(0); expect(time.pending).toBe(0);
      state.activity(true, 1);
      expect(starting.phase).toBe("stopped");
      expect(state.methods).toEqual([acp.methods.agent.initialize, acp.methods.agent.session.new]);
    } finally { state.restore(); time.restore(); }
  });
}

test("readiness activity between snapshot and waiter registration cannot be lost", async () => {
  const time = startupClock(); const state = startupFixture(true, 0); let controller: SessionController | undefined;
  const originalSnapshot = state.bridge.snapshot;
  const snapshot = spyOn(state.bridge, "snapshot").mockImplementationOnce(() => {
    const previous = originalSnapshot();
    state.activity(true, 1);
    return previous;
  });
  try {
    controller = await SessionController.open(readinessConfig, []);
    expect(controller.phase).toBe("idle"); expect(state.stopped).toBe(0);
    expect(pendingWaiters(controller)).toBe(0); expect(time.pending).toBe(0);
  } finally { await controller?.stop(); snapshot.mockRestore(); state.restore(); time.restore(); }
});

for (const method of [acp.methods.agent.initialize, acp.methods.agent.session.new]) {
  test(`startup cancellation during ${method} closes its outstanding request and deadline`, async () => {
    const time = startupClock(); const state = startupFixture(true, 1); const abort = new AbortController();
    const entered = state.blockRequest(method);
    const outcome = startupFailure(SessionController.open(readinessConfig, [], {}, abort.signal));
    try {
      await entered; expect(state.pendingRequests).toBe(1);
      abort.abort(new Error("cancelled ACP setup"));
      expect((await outcome)?.message).toContain("cancelled ACP setup");
      expect(state.pendingRequests).toBe(0); expect(time.pending).toBe(0);
      expect(state.revoked).toBe(true); expect(state.stopped).toBe(1); expect(state.connectionCloses).toBe(1);
      expect(state.turns).toBe(0); expect(state.dispatched).toBe(0);
    } finally { state.restore(); time.restore(); }
  });
}

test("cancellation while runner start owns resources waits for ownership and then cleans without ACP setup", async () => {
  const state = startupFixture(true, 1); const abort = new AbortController(); const start = state.blockRunnerStart();
  const outcome = startupFailure(SessionController.open(readinessConfig, [], {}, abort.signal));
  try {
    await start.entered;
    abort.abort(new Error("cancelled runner start"));
    expect(state.stopped).toBe(0);
    start.release();
    expect((await outcome)?.message).toContain("cancelled runner start");
    expect(state.revoked).toBe(true); expect(state.stopped).toBe(1); expect(state.connectionCloses).toBe(0);
    expect(state.methods).toEqual([]);
  } finally { start.release(); state.restore(); }
});

test("cancellation racing the final ready snapshot cannot reopen a stopped activation", async () => {
  const time = startupClock(); const state = startupFixture(true, 1); const abort = new AbortController();
  const originalSnapshot = state.bridge.snapshot;
  const snapshot = spyOn(state.bridge, "snapshot").mockImplementationOnce(() => {
    abort.abort(new Error("cancelled at readiness"));
    return originalSnapshot();
  });
  const outcome = startupFailure(SessionController.open(readinessConfig, [], {}, abort.signal));
  try {
    expect((await outcome)?.message).toContain("cancelled at readiness");
    expect(state.stopped).toBe(1); expect(state.revoked).toBe(true); expect(time.pending).toBe(0);
    expect(state.turns).toBe(0); expect(state.dispatched).toBe(0);
  } finally { snapshot.mockRestore(); state.restore(); time.restore(); }
});

test("authenticated initialization plus real catalog read permits idle admission after ACP setup", async () => {
  const state = startupFixture(true, 1); let controller: SessionController | undefined;
  try {
    controller = await SessionController.open(readConfig({}), []);
    expect(controller.phase).toBe("idle"); expect(controller.models.map(model => model.id)).toEqual(["actual-fixture-model"]);
    expect(state.stopped).toBe(0); expect(state.revoked).toBe(false);
  } finally { await controller?.stop(); state.restore(); }
  expect(state.stopped).toBe(1); expect(state.revoked).toBe(true);
});

test("runner overrides reach bootstrap and nondefault model selection remains required after session/new", async () => {
  const state = startupFixture(true, 1, true); let controller: SessionController | undefined;
  const runner = { cli: "/home/agy/.local/bin/agy", distribution: "omp-agy-wsl", user: "agy" };
  try {
    controller = await SessionController.open({ ...readConfig({}), runner }, []);
    expect(state.bootstrap).toHaveBeenCalledWith(runner, undefined);
    expect(controller.selectedModel).toBe("actual-fixture-model");
    await controller.selectModel("nondefault-model");
    expect(controller.selectedModel).toBe("nondefault-model");
    expect(state.methods).toEqual([acp.methods.agent.initialize, acp.methods.agent.session.new, acp.methods.agent.session.setConfigOption]);
  } finally { await controller?.stop(); state.restore(); }
});
