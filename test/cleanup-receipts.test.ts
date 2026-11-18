import { expect, test } from "bun:test";
import { assessCleanupReceipts, assessLinuxCleanupObservation } from "../scripts/cleanup-receipts.ts";

function stopped(callId: string, generation: string) {
  const common = { processId: 7, callId, generation, classIdentityMatchesPublicExport: true, receiverUsesSourceClass: true, hookIsCurrent: true, before: { generation } };
  return [
    { ...common, kind: "stop_before" },
    { ...common, kind: "stop_after", delegateOutcome: "fulfilled", after: { snapshotAvailable: true, generation, phase: "stopped",
      cleanup: { status: "stopped", generation, errorCount: 0, workers: [{ state: "exited" }] },
      bridge: { revoked: true, accepting: false, activeTurn: false, sessionCount: 0, connections: 0, pendingCount: 0, queuedCount: 0, dispatchedCount: 0, deliveringCount: 0 } } },
  ] as const;
}

test("discovery stop_after cannot mask a shutdown interrupted before its matching receipt", () => {
  const rows = [...stopped("7:1", "discovery"), stopped("7:2", "conversation")[0]!];
  const verdict = assessCleanupReceipts(rows, 7, ["conversation"]);
  expect(verdict.confirmed).toBe(false);
  expect(verdict.unmatchedCallIds).toEqual(["7:2"]);
  expect(verdict.missingActiveGenerations).toEqual(["conversation"]);
  expect(verdict.errors).toContain("Missing stop_after for 7:2 (generation conversation)");
});

test("every exact call and actual conversation generation must finish cleanup", () => {
  const rows = [...stopped("7:1", "discovery"), ...stopped("7:2", "conversation")];
  expect(assessCleanupReceipts(rows, 7, ["conversation"])).toMatchObject({ confirmed: true, pairedCount: 2, allCallbacksComplete: true });
  expect(assessCleanupReceipts(rows, 7, ["another-conversation"]).confirmed).toBe(false);
});

test("wrong generation, reversed receipt order and duplicate terminal receipts cannot confirm cleanup", () => {
  const [before, after] = stopped("7:1", "conversation");
  expect(assessCleanupReceipts([before!, { ...after!, generation: "discovery" }], 7, ["conversation"]).confirmed).toBe(false);
  expect(assessCleanupReceipts([after!, before!], 7, ["conversation"]).confirmed).toBe(false);
  expect(assessCleanupReceipts([before!, after!, after!], 7, ["conversation"]).confirmed).toBe(false);
});

test("alive workers, pending delivery, truncation and foreign-process receipts are not cleanup proof", () => {
  const rows = stopped("7:1", "conversation");
  const end = rows[1]!;
  expect(assessCleanupReceipts([rows[0]!, { ...end, after: { ...end.after!, cleanup: { ...end.after!.cleanup, workers: [{ state: "alive" }] } } }], 7, ["conversation"]).confirmed).toBe(false);
  expect(assessCleanupReceipts([rows[0]!, { ...end, after: { ...end.after!, bridge: { ...end.after!.bridge, deliveringCount: 1 } } }], 7, ["conversation"]).confirmed).toBe(false);
  expect(assessCleanupReceipts([...rows, { kind: "audit_truncated", processId: 7 }], 7, ["conversation"]).confirmed).toBe(false);
  expect(assessCleanupReceipts(rows, 8, ["conversation"]).confirmed).toBe(false);
});

test("fulfilled callback with a different snapshot or durable generation is rejected", () => {
  const [before, after] = stopped("7:1", "conversation");
  expect(assessCleanupReceipts([before!, { ...after!, after: { ...after!.after!, generation: "discovery" } }], 7, ["conversation"]).confirmed).toBe(false);
  expect(assessCleanupReceipts([before!, { ...after!, after: { ...after!.after!, cleanup: { ...after!.after!.cleanup, generation: "discovery" } } }], 7, ["conversation"]).confirmed).toBe(false);
  expect(assessCleanupReceipts([before!, { ...after!, receiverUsesSourceClass: 1 }], 7, ["conversation"]).confirmed).toBe(false);
});

test("physical cleanup does not satisfy a missing host callback", () => {
  const physical = assessLinuxCleanupObservation({ cleanup: "stopped\ngeneration\tconversation\nproducer_exit\t0\nworker\t42\t100\t42\t1\texited\n",
    runtimeExists: "no", knownWorkerLeftovers: "", supervisorIdentityPresent: "no" }, "conversation");
  expect(physical.confirmed).toBe(true);
  const host = assessCleanupReceipts([stopped("7:1", "conversation")[0]!], 7, ["conversation"]);
  expect(host.confirmed).toBe(false);
  expect(host.errors).toContain("Missing stop_after for 7:1 (generation conversation)");
});

test("physical proof requires matching durable generation, runtime absence and absent process identities", () => {
  const observation = { cleanup: "stopped\ngeneration\tconversation\nproducer_exit\t0\n", runtimeExists: "no", knownWorkerLeftovers: "", supervisorIdentityPresent: "no" };
  expect(() => assessLinuxCleanupObservation({ ...observation, cleanup: "stopped\nproducer_exit\t0\n" }, "conversation")).toThrow("generation");
  expect(() => assessLinuxCleanupObservation(observation, "discovery")).toThrow("generation");
  expect(assessLinuxCleanupObservation({ ...observation, runtimeExists: "yes" }, "conversation").confirmed).toBe(false);
  expect(assessLinuxCleanupObservation({ ...observation, knownWorkerLeftovers: "42:100 " }, "conversation").confirmed).toBe(false);
  expect(assessLinuxCleanupObservation({ ...observation, supervisorIdentityPresent: "yes" }, "conversation").confirmed).toBe(false);
});
