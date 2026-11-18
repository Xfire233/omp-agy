import { describe, expect, test } from "bun:test";
import { redact } from "../scripts/acceptance";

// Offline evidence-boundary tests only. These do not launch OMP/WSL, inspect
// implementation source, or count as real-account acceptance observations.
describe("acceptance evidence redaction", () => {
  test("removes structured credentials but retains usage counts and ACP identity", () => {
    expect(redact({ Authorization: "Bearer private", nested: { access_token: "private", refreshToken: "private", password: "private" }, inputTokens: 12, outputTokens: 7, acpSessionId: "session-123" })).toEqual({ Authorization: "[REDACTED]", nested: { access_token: "[REDACTED]", refreshToken: "[REDACTED]", password: "[REDACTED]" }, inputTokens: 12, outputTokens: 7, acpSessionId: "session-123" });
  });

  test("redacts serialized UI notices recursively, including escaped Windows roots", () => {
    const notice = JSON.stringify({ type: "omp-agy-status", authorization: "Bearer private", path: "C:\\Users\\private\\session", providerInvocations: 3 });
    expect(JSON.parse(redact(notice, ["C:\\Users\\private"]) as string)).toEqual({ type: "omp-agy-status", authorization: "[REDACTED]", path: "<private-root>\\session", providerInvocations: 3 });
  });

  test("strips bearer strings and credential URL query parameters from stderr", () => {
    const evidence = redact("request Authorization: Bearer do-not-save at http://127.0.0.1/mcp?token=private&other=kept") as string;
    expect(evidence).not.toContain("do-not-save");
    expect(evidence).not.toContain("token=private");
    expect(evidence).toContain("other=kept");
  });

  test("retains ordinary results and reminder content", () => {
    const content = { toolName: "read", result: [{ type: "text", text: "<system-reminder>acceptance marker</system-reminder>" }], pendingCount: 45, resultWasEmpty: false };
    expect(redact(content)).toEqual(content);
  });
});
