import { describe, expect, test } from "bun:test";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { mergeToolReport, permissionOutcome } from "../src/controller.ts";

const request: RequestPermissionRequest = {
  sessionId: "session", toolCall: { toolCallId: "tool", _meta: { mcpServerName: "omp_agy_bridge", mcpToolName: "read" } },
  options: [
    { kind: "allow_always", optionId: "never-auto-allow-always", name: "Always" },
    { kind: "reject_once", optionId: "offered-deny", name: "Deny" },
    { kind: "allow_once", optionId: "actual-offered-once-id", name: "Once" },
  ],
};
const state = { sessionId: "session", active: true, registered: true,
  report: { server: "omp_agy_bridge", name: "read", conflict: false, closed: false } };

describe("structured bridge permission", () => {
  test("uses only the actual offered allow-once option ID", () => {
    expect(permissionOutcome(request, state)).toEqual({ outcome: { outcome: "selected", optionId: "actual-offered-once-id" } });
    expect(permissionOutcome({ ...request, options: request.options.filter(option => option.kind !== "allow_once") }, state)).toEqual({ outcome: { outcome: "cancelled" } });
  });
  test("does not approve unknown, stale, conflicting, native or wrong-session operations", () => {
    for (const invalid of [
      { ...state, active: false }, { ...state, registered: false }, { ...state, report: undefined },
      { ...state, sessionId: "other" }, { ...state, report: { ...state.report, closed: true } },
      { ...state, report: { ...state.report, conflict: true } },
      { ...state, report: { ...state.report, server: "native" } },
    ]) expect(permissionOutcome(request, invalid)).toEqual({ outcome: { outcome: "selected", optionId: "offered-deny" } });
    expect(permissionOutcome({ ...request, toolCall: { ...request.toolCall, _meta: { mcpServerName: "native" } } }, state))
      .toEqual({ outcome: { outcome: "selected", optionId: "offered-deny" } });
  });
  test("human-readable titles never grant native permissions", () => {
    const native = { ...request, toolCall: { toolCallId: "native", title: "omp_agy_bridge read" } };
    expect(permissionOutcome(native, { ...state, report: undefined })).toEqual({ outcome: { outcome: "selected", optionId: "offered-deny" } });
  });
  test("actual AGY 1.5.9 programmatic tool name resolves without legacy metadata", () => {
    const names = new Map([["mcp_omp_agy_bridge_identity_probe", "identity_probe"]]);
    const tool = { toolCallId: "observed-live-id", name: "mcp_omp_agy_bridge_identity_probe", kind: "other" as const, status: "pending" as const };
    const report = mergeToolReport(undefined, tool, names);
    expect(report).toEqual({ server: "omp_agy_bridge", name: "identity_probe", conflict: false, closed: false });
    expect(permissionOutcome({ ...request, toolCall: tool }, { ...state, report }))
      .toEqual({ outcome: { outcome: "selected", optionId: "actual-offered-once-id" } });
    const conflict = mergeToolReport(report, { ...tool, _meta: { mcpServerName: "native", mcpToolName: "identity_probe" } }, names);
    expect(conflict.conflict).toBe(true);
    expect(permissionOutcome({ ...request, toolCall: tool }, { ...state, report: conflict }))
      .toEqual({ outcome: { outcome: "selected", optionId: "offered-deny" } });
    const native = mergeToolReport(report, { ...tool, name: "native_write" }, names);
    expect(native.conflict).toBe(true);
    expect(permissionOutcome({ ...request, toolCall: { ...tool, name: "mcp_unknown_identity_probe" } }, { ...state, report }))
      .toEqual({ outcome: { outcome: "selected", optionId: "offered-deny" } });
    const titleOnly = mergeToolReport(undefined, { toolCallId: "display-only", title: "mcp_omp_agy_bridge_identity_probe" }, names);
    expect(titleOnly.server).toBeUndefined(); expect(titleOnly.name).toBeUndefined();
  });
});
