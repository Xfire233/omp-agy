import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Context, type Model, type SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import type { ProviderRuntime } from "./provider.ts";

// OMP's custom API registry and inherited ModelRegistry are process-global/shared.
// This table owns routing only; every runtime owns its own controller, ledger and MCP state.
const sessions = new Map<string, ProviderRuntime>();

export function bindProviderSession(id: string, runtime: ProviderRuntime): void {
  const prior = sessions.get(id);
  if (prior && prior !== runtime) throw new Error("AGY host session identity is already bound to another extension factory");
  for (const [key, value] of sessions) if (value === runtime && key !== id) sessions.delete(key);
  sessions.set(id, runtime);
}
export function unbindProviderSession(runtime: ProviderRuntime): void {
  for (const [id, value] of sessions) if (value === runtime) sessions.delete(id);
}

export function routeProviderStream(model: Model<Api>, context: Context, options?: SimpleStreamOptions) {
  const runtime = options?.sessionId ? sessions.get(options.sessionId) : undefined;
  if (runtime) return runtime.stream(model, context, options);
  const stream = createAssistantMessageEventStream();
  const error: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
    timestamp: Date.now(), content: [], stopReason: "error",
    errorMessage: "AGY provider request has no factory-bound host session identity. Refusing to use another parent/child controller; no ACP input was sent.",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  stream.push({ type: "start", partial: error }); stream.push({ type: "error", reason: "error", error }); stream.end();
  return stream;
}
