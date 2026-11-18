import { expect, test } from "bun:test";
import type { LiveSteering, SimpleStreamOptions, UserMessage } from "@oh-my-pi/pi-ai";
import { LiveSteeringChannel } from "@oh-my-pi/pi-agent-core/live-steering";
import { readConfig } from "../src/config.ts";
import { SessionController } from "../src/controller.ts";
import { ProviderRuntime } from "../src/provider.ts";

const message: UserMessage = { role: "user", content: "input queued during MCP", timestamp: 1 };
interface ConsumerSeam {
  consumeSteering(controller: SessionController, attempt: { sessionId?: string; currentInput: string[]; inputs: Set<string> }, options: SimpleStreamOptions, signal: AbortSignal): Promise<void>;
  expectedTool?: { id: string; name: string; arguments: Record<string, unknown> };
}

/** Real provider consumer and installed host claim lifecycle; no AGY process or generation. */
function fixture() {
  const runtime = new ProviderRuntime(readConfig({}));
  const consumer = runtime as unknown as ConsumerSeam;
  let pending = 0;
  let takes = 0;
  let sends = 0;
  let queued = [message];
  const controller = Reflect.construct(SessionController, [readConfig({}), {}]) as SessionController;
  controller.phase = "active";
  controller.bridge = { get pendingCount() { return pending; } } as SessionController["bridge"];
  Object.defineProperty(controller, "activeFlights", { get: () => 1 });
  controller.steer = async (_prompt, receipt) => { sends++; receipt?.onReceived?.(); };
  const channel = new LiveSteeringChannel({
    async wait() {},
    async take() { takes++; const batch = queued; queued = []; return batch; },
    async toProvider(messages) { return messages as UserMessage[]; },
  });
  return { controller, consumer, channel, runtime, setPending(value: number) { pending = value; },
    get queued() { return queued; }, get takes() { return takes; }, get sends() { return sends; },
    run(source: LiveSteering = channel) { return consumer.consumeSteering(controller, { currentInput: [], inputs: new Set() }, { liveSteering: source }, new AbortController().signal); } };
}

test("MCP-stage steering is not claimed or sent and remains in the real host queue", async () => {
  const state = fixture(); state.setPending(1);
  await state.run();
  expect(state.takes).toBe(0); expect(state.sends).toBe(0);
  expect(state.queued).toEqual([message]); expect(state.channel.accepted).toEqual([]); expect(state.channel.deferred).toEqual([]);
});

test("a dispatched MCP handler also defers steering before claim at the next provider boundary", async () => {
  const state = fixture(); state.consumer.expectedTool = { id: "parked-handler", name: "read", arguments: {} };
  await state.run();
  expect(state.takes).toBe(0); expect(state.sends).toBe(0); expect(state.queued).toEqual([message]);
});

test("MCP arrival while waiting defers unsent input without claiming it", async () => {
  const state = fixture();
  await state.run({ async wait() { state.setPending(1); }, claim: signal => state.channel.claim(signal) });
  expect(state.takes).toBe(0); expect(state.sends).toBe(0); expect(state.queued).toEqual([message]);
});

test("MCP arrival during host claim conversion safely rejects only the genuinely unsent claim", async () => {
  const state = fixture();
  await state.run({ wait: signal => state.channel.wait(signal), async claim(signal) {
    const claim = await state.channel.claim(signal); state.setPending(1); return claim;
  } });
  expect(state.takes).toBe(1); expect(state.sends).toBe(0);
  expect(state.channel.accepted).toEqual([]); expect(state.channel.deferred).toEqual([message]);
});

test("restored unknown claims stay unresolved and never reach AGY or host delivered/deferred lists", async () => {
  const state = fixture();
  state.runtime.syncSteeringQuarantine([{ version: 1, messages: [message], reason: "sent without receipt", recordedAt: 2 }]);
  // /tree replaces visible history but can retain the host steering queue.
  state.runtime.syncSteeringQuarantine([]);
  await state.run();
  expect(state.takes).toBe(1); expect(state.sends).toBe(0);
  expect(state.channel.accepted).toEqual([]); expect(state.channel.deferred).toEqual([]);
});
