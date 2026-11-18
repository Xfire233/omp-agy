import { describe, expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { readConfig } from "../src/config.ts";
import { API_ID, PROVIDER_ID, ProviderRuntime } from "../src/provider.ts";
import { bindProviderSession, routeProviderStream, unbindProviderSession } from "../src/router.ts";

const model: Model = {
  id: "gemini-4-argon", name: "Fixture for aborted stream only", api: API_ID, provider: PROVIDER_ID,
  identity: { class: "unknown" }, compat: undefined,
  baseUrl: "acp://fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 400000, maxTokens: 8192,
};

describe("provider configuration", () => {
  test("enforces explicit model restrictions and rejects invalid configuration", () => {
    expect(readConfig({ OMP_AGY_PROFILE: "default-agy", OMP_AGY_MODELS: "a,b,a" }).allowedModels).toEqual(["a", "b"]);
    expect(() => readConfig({ OMP_AGY_PROFILE: "native-fallback" })).toThrow();
    expect(() => readConfig({ OMP_AGY_CONTEXT_WINDOW: "NaN" })).toThrow();
  });
  test("already-aborted invocation emits canonical start/error without launching WSL", async () => {
    const runtime = new ProviderRuntime(readConfig({}));
    const abort = new AbortController(); abort.abort("test");
    const stream = runtime.stream(model, { systemPrompt: ["never submitted"], messages: [] }, { signal: abort.signal });
    const events: string[] = [];
    for await (const event of stream) events.push(event.type);
    const result = await stream.result();
    expect(events).toEqual(["start", "error"]);
    expect(result.stopReason).toBe("aborted");
    expect(result.errorMessage).toContain("already aborted");
    expect(runtime.snapshot().advertisedModels).toEqual([]);
    expect(runtime.snapshot().busy).toBe(false);
  });
  test("process-global API dispatch routes parent and child to their own factory state", async () => {
    const parent = new ProviderRuntime(readConfig({})); const child = new ProviderRuntime(readConfig({}));
    bindProviderSession("parent-fixture", parent); bindProviderSession("child-fixture", child);
    const signal = AbortSignal.abort("fixture: do not launch WSL");
    try {
      await routeProviderStream(model, { messages: [] }, { sessionId: "parent-fixture", signal }).result();
      expect(parent.snapshot().providerInvocations).toBe(1); expect(child.snapshot().providerInvocations).toBe(0);
      await routeProviderStream(model, { messages: [] }, { sessionId: "child-fixture", signal }).result();
      expect(parent.snapshot().providerInvocations).toBe(1); expect(child.snapshot().providerInvocations).toBe(1);
      const unknown = await routeProviderStream(model, { messages: [] }, { sessionId: "unknown-fixture" }).result();
      expect(unknown.stopReason).toBe("error"); expect(unknown.errorMessage).toContain("no factory-bound");
      expect(() => bindProviderSession("parent-fixture", child)).toThrow("already bound");
    } finally { unbindProviderSession(parent); unbindProviderSession(child); }
  });
});
