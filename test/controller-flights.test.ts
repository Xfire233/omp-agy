import { expect, test } from "bun:test";
import * as acp from "@agentclientprotocol/sdk";
import type { Bridge } from "../src/bridge.ts";
import { SessionController } from "../src/controller.ts";

type Flight = ReturnType<typeof Promise.withResolvers<acp.PromptResponse>>;
/** Replace only the external ACP endpoint; exercise the actual controller's flight and notification logic. */
interface AcpSeam {
  connection: {
    agent: { request(): Promise<acp.PromptResponse>; notify(): Promise<void> };
    close(): void;
  };
  flights: Map<number, Promise<void>>;
  update(notification: acp.SessionNotification): void;
}

function fixture() {
  const flights: Flight[] = [];
  const controller = Reflect.construct(SessionController, [{ profile: "custom-clean" }, {}]) as SessionController;
  const seam = controller as unknown as AcpSeam;
  seam.connection = {
    agent: {
      request() { const flight = Promise.withResolvers<acp.PromptResponse>(); flights.push(flight); return flight.promise; },
      async notify() {},
    },
    close() {},
  };
  controller.bridge = { beginTurn() {}, endTurn() {}, pendingCount: 0, async revoke() {} } as unknown as Bridge;
  controller.sessionId = "controlled-session"; controller.phase = "idle";
  const echo = (text: string) => seam.update({ sessionId: controller.sessionId,
    update: { sessionUpdate: "user_message_chunk", content: { type: "text", text } } });
  return { controller, seam, flights, echo, async close() {
    const stopping = controller.stop(new Error("Controlled ACP fixture cleanup"));
    for (const flight of flights) flight.resolve({ stopReason: "cancelled" });
    await stopping;
    await Promise.allSettled([...seam.flights.values()]);
  } };
}

test("acknowledged replacement flight may be cancelled by a later native takeover", async () => {
  const { controller, seam, flights, echo, close } = fixture();
  let accepted = 0;
  let rejected = 0;
  const callbacks = { onReceived() { accepted++; }, onUnsent() { rejected++; } };
  try {
    controller.begin([{ type: "text", text: "initial" }]);
    const second = controller.steer([{ type: "text", text: "second" }], callbacks);
    void second.catch(() => {});
    echo("second"); await second;
    expect(controller.activeFlights).toBe(2);
    const third = controller.steer([{ type: "text", text: "third" }], callbacks);
    void third.catch(() => {});
    expect(flights).toHaveLength(3);
    const replaced = seam.flights.get(2)!;
    flights[1].reject(new acp.RequestError(-32800, "Superseded by native steering"));
    await replaced;
    expect(controller.failure).toBeUndefined(); expect<string>(controller.phase).toBe("active");
    const original = seam.flights.get(1)!;
    flights[0].reject(new acp.RequestError(-32800, "Superseded by native steering"));
    await original;
    echo("third"); await third;
    flights[2].resolve({ stopReason: "end_turn" });
    await Promise.all([...seam.flights.values()]);
    expect(controller.failure).toBeUndefined(); expect(controller.activeFlights).toBe(0);
    expect(controller.counters.steeringAccepted).toBe(2); expect(accepted).toBe(2); expect(rejected).toBe(0);
    controller.finishTurn(); expect(controller.phase).toBe("idle");
  } finally { await close(); }
});

for (const newestFirst of [false, true]) {
  test(`an older success cannot mask latest-flight cancellation (${newestFirst ? "newest" : "oldest"} response first)`, async () => {
    const { controller, seam, flights: requests, echo, close } = fixture();
    try {
      controller.begin([{ type: "text", text: "initial" }]);
      const receipt = controller.steer([{ type: "text", text: "replacement" }]);
      void receipt.catch(() => {});
      echo("replacement");
      await receipt;
      const older = seam.flights.get(1)!;
      const newest = seam.flights.get(2)!;
      if (newestFirst) {
        requests[1]!.resolve({ stopReason: "cancelled" }); await newest;
        expect(controller.stopReason).toBe("cancelled");
        requests[0]!.resolve({ stopReason: "end_turn" }); await older;
      } else {
        requests[0]!.resolve({ stopReason: "end_turn" }); await older;
        expect(controller.stopReason).toBeUndefined();
        requests[1]!.resolve({ stopReason: "cancelled" }); await newest;
      }
      expect(controller.stopReason).toBe("cancelled");
      expect(() => controller.finishTurn()).toThrow("without a successful owner/replacement prompt response");
      expect(controller.counters.steeringAccepted).toBe(1);
      expect(controller.counters.steeringUncertain).toBe(0);
    } finally { await close(); }
  });
}
