import { expect, test } from "bun:test";
import * as acp from "@agentclientprotocol/sdk";
import { boundary, bounded, confirmationMs, createBoundaryFixture, sessionId } from "./helpers/boundary-steering.ts";

for (const receipt of ["successful response", "official echo"] as const) {
  test(`boundary ${receipt} retains the original MCP result and dispatches the next request once`, async () => {
    const state = createBoundaryFixture();
    try {
      const run = await state.start();
      if (receipt === "successful response") run.candidate.resolve({ stopReason: "end_turn" });
      else await state.peer.client.notify(acp.methods.client.session.update, { sessionId: state.controller.sessionId,
        update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: run.candidate.prompt.filter(block => block.type === "text").map(block => block.text).join("") } } });
      await state.waitFor(live => !live.hasCandidate);
      const next = state.call(2);
      const response = await bounded(run.continuation, "Confirmed next MCP handoff");
      expect(response.stopReason).toBe("toolUse");
      expect(response.content.filter(block => block.type === "toolCall")).toMatchObject([{ name: "read", arguments: { index: 2 } }]);
      const secondResult = state.toolResult(response, "second actual OMP result");
      expect(secondResult.toolCallId).not.toBe(run.result.toolCallId);
      const completed = state.stream([...run.history, response, secondResult]);
      await state.waitFor(live => live.bridge.deliveredCount === 2);
      expect((await bounded(next, "Second HTTP result")).content).toEqual(secondResult.content);
      for (const flight of state.flights) flight.resolve({ stopReason: "end_turn" });
      expect((await bounded(completed, "Completed original turn")).stopReason).toBe("stop");
      expect(state.completedIds).toEqual([run.result.toolCallId, secondResult.toolCallId]);
      expect(state.dispatched.map(call => call.arguments)).toEqual([{ index: 1 }, { index: 2 }]);
      expect(state.controller.counters).toMatchObject({ steeringAccepted: 1, steeringUncertain: 0, steeringDeferred: 0 });
      expect(state.records).toEqual([]);
      expect(state.flights).toHaveLength(2);
      expect(state.openings).toBe(1);
    } finally { await state.close(); }
  }, 10_000);
}

test("new queued MCP after original delivery terminates an unconfirmed boundary receipt as UNKNOWN without dispatch or resend", async () => {
  const state = createBoundaryFixture();
  try {
    const run = await state.start();
    const started = performance.now();
    void state.call(2).catch(() => {});
    const response = await bounded(run.continuation, "Unconfirmed boundary MCP guard");
    expect(performance.now() - started).toBeLessThan(confirmationMs);
    expect(state.sawNextQueuedAfterDelivery).toBe(true);
    expect(response.stopReason).toBe("error");
    expect(response.errorMessage).toContain("MCP tool handoff");
    expect(response.content.some(block => block.type === "toolCall")).toBe(false);
    expect(state.controller.counters).toMatchObject({ steeringAccepted: 0, steeringDeferred: 0, steeringUncertain: 1 });
    expect(state.records).toHaveLength(1);
    expect(state.records[0]).toMatchObject({ sessionId, messages: [boundary] });
    expect(state.controller.bridge.deliveredCount).toBe(1);
    expect(state.controller.bridge.snapshot()).toMatchObject({ revoked: true, pendingCount: 0, dispatchedCount: 0 });
    expect(state.controller.phase).toBe("stopped");
    expect(state.completedIds).toEqual([run.result.toolCallId]);
    expect(state.dispatched.map(call => call.arguments)).toEqual([{ index: 1 }]);
    const retry = await bounded(state.stream([...run.history, response]), "Quarantined boundary retry");
    expect(retry.errorMessage).toContain("quarantined");
    expect(state.records).toHaveLength(1);
    expect(state.flights).toHaveLength(2);
    expect(state.openings).toBe(1);
    expect(state.completedIds).toEqual([run.result.toolCallId]);
  } finally { await state.close(); }
}, 10_000);

for (const cancellation of ["host abort", "runtime stop"] as const) {
  test(`${cancellation} wakes a boundary receipt wait after original delivery without accepting or replaying input`, async () => {
    const state = createBoundaryFixture();
    const abort = new AbortController();
    try {
      const run = await state.start(abort.signal);
      const started = performance.now();
      const stopping = cancellation === "runtime stop" ? state.runtime.stop("Explicit boundary cancellation") : undefined;
      if (cancellation === "host abort") abort.abort(new Error("Explicit boundary cancellation"));
      const response = await bounded(run.continuation, "Cancelled boundary wait");
      if (stopping) await bounded(stopping, "Runtime stop barrier");
      expect(performance.now() - started).toBeLessThan(confirmationMs);
      expect(response.stopReason).toBe("aborted");
      expect(response.content.some(block => block.type === "toolCall")).toBe(false);
      expect(state.controller.phase).toBe("stopped");
      expect(state.controller.counters).toMatchObject({ steeringAccepted: 0, steeringDeferred: 0, steeringUncertain: 1 });
      expect(state.records).toHaveLength(1);
      expect(state.records[0]).toMatchObject({ sessionId, messages: [boundary] });
      expect(state.controller.bridge.deliveredCount).toBe(1);
      expect(state.completedIds).toEqual([run.result.toolCallId]);
      expect(state.flights).toHaveLength(2);
      expect(state.openings).toBe(1);
    } finally { await state.close(); }
  }, 10_000);
}
