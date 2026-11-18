import { expect, spyOn, test } from "bun:test";
import * as acp from "@agentclientprotocol/sdk";
import type { UserMessage } from "@oh-my-pi/pi-ai";
import { LiveSteeringChannel } from "@oh-my-pi/pi-agent-core/live-steering";
import type { Bridge } from "../src/bridge.ts";
import { readConfig } from "../src/config.ts";
import { SessionController } from "../src/controller.ts";

type Flight = ReturnType<typeof Promise.withResolvers<acp.PromptResponse>>;
interface AcpSeam {
  connection: { agent: { request(): Promise<acp.PromptResponse>; notify(): Promise<void> }; close(): void };
  flights: Map<number, Promise<void>>;
  update(notification: acp.SessionNotification): void;
}

/** A deterministic clock replaces only platform time/timers, never controller deadline logic. */
function controlledClock() {
  let now = 0;
  let next = 0;
  type Timer = ReturnType<typeof setTimeout>;
  const timers = new Map<Timer, { at: number; run: () => void }>();
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const schedule = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) => {
    const timer = ++next as unknown as Timer;
    timers.set(timer, { at: now + delay, run: callback });
    return timer;
  }) as typeof setTimeout);
  const cancel = spyOn(globalThis, "clearTimeout").mockImplementation(timer => { timers.delete(timer as Timer); });
  return {
    advance(milliseconds: number) {
      const until = now + milliseconds;
      while (true) {
        let due: [Timer, { at: number; run: () => void }] | undefined;
        for (const entry of timers) if (entry[1].at <= until && (!due || entry[1].at < due[1].at)) due = entry;
        if (!due) break;
        now = due[1].at; timers.delete(due[0]); due[1].run();
      }
      now = until;
    },
    restore() { cancel.mockRestore(); schedule.mockRestore(); clock.mockRestore(); },
  };
}
function fixture() {
  const flights: Flight[] = [];
  const controller = Reflect.construct(SessionController, [{ ...readConfig({}), steeringConfirmationMs: 20 }, {}]) as SessionController;
  const seam = controller as unknown as AcpSeam;
  seam.connection = {
    agent: {
      request() { const flight = Promise.withResolvers<acp.PromptResponse>(); flights.push(flight); return flight.promise; },
      async notify() {},
    },
    close() {},
  };
  controller.bridge = { beginTurn() {}, endTurn() {}, pendingCount: 0, async revoke() {} } as unknown as Bridge;
  controller.sessionId = "controlled-timer-session"; controller.phase = "idle";
  const progress = (type: "agent_message_chunk" | "agent_thought_chunk") => seam.update({ sessionId: controller.sessionId,
    update: { sessionUpdate: type, content: { type: "text", text: "official progress" } } });
  return { controller, seam, flights, progress,
    async close() {
      for (const flight of flights) flight.resolve({ stopReason: "cancelled" });
      await controller.stop(new Error("Controlled receipt timer fixture cleanup"));
      await Promise.allSettled([...seam.flights.values()]);
    },
  };
}
const message: UserMessage = { role: "user", content: "pending steering", timestamp: 1 };
const replacement: acp.ContentBlock[] = [{ type: "text", text: String(message.content) }];
function hostChannel() {
  return new LiveSteeringChannel({ async wait() {}, async take() { return [message]; }, async toProvider() { return [message]; } });
}

test("official session progress extends receipt idleness even after the owner RPC settles, but silence remains bounded", async () => {
  const time = controlledClock(); let unknown = 0;
  const state = fixture();
  const channel = hostChannel(); const claim = await channel.claim(new AbortController().signal);
  try {
    state.controller.begin([{ type: "text", text: "initial owner" }]);
    const receipt = state.controller.steer(replacement, { onReceived: () => claim?.accept(), onUnsent: () => claim?.reject(),
      onUncertain() { unknown++; expect(claim?.messages).toEqual([message]); } });
    void receipt.catch(() => {});
    time.advance(15); state.progress("agent_message_chunk");
    time.advance(15); state.progress("agent_thought_chunk");
    time.advance(15);
    expect(state.controller.failure).toBeUndefined(); expect(state.controller.hasCandidate).toBe(true);
    // More than two idle windows elapsed with progress. The target can settle the
    // owner RPC early while official session-owned output continues streaming.
    const owner = state.seam.flights.get(1)!;
    state.flights[0].resolve({ stopReason: "end_turn" }); await owner;
    time.advance(4); state.progress("agent_message_chunk");
    time.advance(15); state.progress("agent_thought_chunk");
    time.advance(15);
    expect(state.controller.failure).toBeUndefined(); expect(state.controller.counters.steeringAccepted).toBe(0);
    time.advance(6);
    await expect(receipt).rejects.toThrow("confirmation idle window");
    expect(state.controller.counters.steeringAccepted).toBe(0); expect(state.controller.counters.steeringUncertain).toBe(1);
    expect(channel.accepted).toEqual([]); expect(channel.deferred).toEqual([]); expect(unknown).toBe(1);
    expect(state.controller.failure?.message).toContain("not confirmed delivered");
    await state.controller.stop(); expect(state.controller.phase).toBe("stopped");
  } finally { await state.close(); time.restore(); }
});

test("a silent older owner does not extend the bounded receipt deadline", async () => {
  const time = controlledClock(); const state = fixture();
  try {
    state.controller.begin([{ type: "text", text: "silent owner" }]);
    const receipt = state.controller.steer(replacement); void receipt.catch(() => {});
    time.advance(21);
    await expect(receipt).rejects.toThrow("confirmation idle window");
    expect(state.controller.counters.steeringUncertain).toBe(1); expect(state.controller.counters.steeringAccepted).toBe(0);
    await state.controller.stop(); expect(state.controller.phase).toBe("stopped");
  } finally { await state.close(); time.restore(); }
});

test("official acknowledgement clears the receipt timer without counting progress as acceptance", async () => {
  const time = controlledClock(); const state = fixture();
  const channel = hostChannel(); const claim = await channel.claim(new AbortController().signal);
  try {
    state.controller.begin([{ type: "text", text: "owner" }]);
    const receipt = state.controller.steer(replacement, { onReceived: () => claim?.accept() });
    void receipt.catch(() => {});
    time.advance(15); state.progress("agent_message_chunk"); expect(channel.accepted).toEqual([]);
    state.seam.update({ sessionId: state.controller.sessionId,
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: String(message.content) } } });
    await receipt; time.advance(100);
    expect(channel.accepted).toEqual([message]); expect(channel.deferred).toEqual([]); expect(state.controller.counters.steeringAccepted).toBe(1);
    expect(state.controller.counters.steeringUncertain).toBe(0); expect(state.controller.failure).toBeUndefined();
  } finally { await state.close(); time.restore(); }
});

test("cancellation clears the pending receipt timer and settles unknown only once", async () => {
  const time = controlledClock(); const state = fixture();
  try {
    state.controller.begin([{ type: "text", text: "owner" }]);
    const receipt = state.controller.steer(replacement); void receipt.catch(() => {});
    await state.controller.stop(new Error("explicit cancellation"));
    await expect(receipt).rejects.toThrow("explicit cancellation");
    time.advance(100);
    expect(state.controller.counters.steeringUncertain).toBe(1); expect(state.controller.counters.steeringAccepted).toBe(0);
    expect(state.controller.phase).toBe("stopped");
  } finally { await state.close(); time.restore(); }
});

test("successful official prompt response confirms the real host claim without requiring an echo", async () => {
  const time = controlledClock(); const state = fixture(); const channel = hostChannel();
  try {
    state.controller.begin([{ type: "text", text: "owner" }]);
    const claim = await channel.claim(new AbortController().signal);
    const receipt = state.controller.steer(replacement, { onReceived: () => claim?.accept() });
    state.flights[1]!.resolve({ stopReason: "end_turn" }); await receipt;
    expect(channel.accepted).toEqual([message]); expect(channel.deferred).toEqual([]);
    expect(state.controller.counters.steeringAccepted).toBe(1); expect(state.controller.counters.steeringUncertain).toBe(0);
    time.advance(100); expect(state.controller.failure).toBeUndefined();
  } finally { await state.close(); time.restore(); }
});

test("a genuinely unsent candidate returns only to the host deferred queue", async () => {
  const state = fixture(); const channel = hostChannel();
  try {
    const claim = await channel.claim(new AbortController().signal);
    await expect(state.controller.steer(replacement, { onUnsent: () => claim?.reject() })).rejects.toThrow("turn already ended");
    expect(state.flights).toEqual([]); expect(channel.accepted).toEqual([]); expect(channel.deferred).toEqual([message]);
    expect(state.controller.counters.steeringAccepted).toBe(0); expect(state.controller.counters.steeringUncertain).toBe(0);
  } finally { await state.close(); }
});
