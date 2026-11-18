import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import cleanupAuditExtension from "./cleanup-audit-extension.ts";

// Acceptance-only wrapper. Observe real WSL launches without retaining arguments,
// environment, stdin, URLs or credentials. Delegate production unchanged.
const observations: Array<Record<string, unknown>> = [];
let installed = false;
let childSequence = 0;
function record(value: Record<string, unknown>): void {
  const row = { at: new Date().toISOString(), processId: process.pid, ...value };
  observations.push(row);
  appendFileSync(process.env.OMP_AGY_ACTIVATION_AUDIT_PATH!, JSON.stringify(row) + "\n");
}

export default async function activationAuditExtension(pi: ExtensionAPI): Promise<void> {
  if (!process.env.OMP_AGY_ACTIVATION_AUDIT_PATH) throw new Error("Explicit activation audit path required");
  if (!installed) {
    installed = true;
    const original = Bun.spawn;
    // Bun's overloaded spawn signatures cannot be represented by one wrapper signature.
    Bun.spawn = function (...args: unknown[]): unknown {
      const first = args[0];
      const command: unknown = Array.isArray(first) ? first : first && typeof first === "object" && "cmd" in first ? first.cmd : undefined;
      if (Array.isArray(command) && /(?:^|[\\/])wsl\.exe$/i.test(String(command[0]))) {
        record({ kind: "wsl_spawn", bootstrap: command.includes("bootstrap") });
      }
      return Reflect.apply(original, Bun, args);
    } as typeof Bun.spawn;
  }
  record({ kind: "factory_bind", discovery: process.env.OMP_AGY_DISCOVERY ?? "ondemand" });
  await cleanupAuditExtension(pi);
  pi.registerCommand("activation-audit", {
    description: "Acceptance-only bounded launch counters",
    handler: async (_args, ctx) => { ctx.ui.notify(JSON.stringify({ type: "activation-audit", observations }), "info"); },
  });
  pi.registerCommand("activation-child", {
    description: "Acceptance-only real SDK prepared non-AGY child, without a prompt",
    handler: async (args, ctx) => {
      const { createAgentSession, Settings, SessionManager } = pi.pi;
      const selector = args.trim();
      const model = ctx.modelRegistry.getAll().find(model => `${model.provider}/${model.id}` === selector && model.provider !== "omp-agy");
      if (!model) throw new Error("Requested exact non-AGY model metadata unavailable for preparation");
      const path = fileURLToPath(import.meta.url);
      const before = observations.filter(row => row.kind === "wsl_spawn").length;
      const child = await createAgentSession({
        cwd: ctx.cwd, model, modelRegistry: ctx.modelRegistry, authStorage: ctx.modelRegistry.authStorage,
        sessionManager: SessionManager.inMemory(ctx.cwd), settings: Settings.isolated({ "retry.enabled": false }),
        preloadedPreparedExtensions: [{ path, resolvedPath: path, factory: activationAuditExtension, error: null }],
        disableExtensionDiscovery: true, enableMCP: false, enableLsp: false, enableIrc: false,
        cacheWarming: false, skipPythonPreflight: true, toolNames: [], contextFiles: [], skills: [], rules: [],
        taskDepth: 1, agentId: `activation-child-${++childSequence}`, parentAgentId: ctx.agent.id,
        bindProcessState: false, hasUI: false,
      });
      try {
        if (child.extensionsResult.errors.length) throw new Error(JSON.stringify(child.extensionsResult.errors));
        record({ kind: "prepared_child", childSequence, provider: child.session.model?.provider, modelId: child.session.model?.id,
          boundFactories: child.extensionsResult.extensions.length,
          boundProductionFactories: child.extensionsResult.extensions.filter(extension => extension.resolvedPath === path).length, promptSubmitted: false,
          wslSpawnsBefore: before, wslSpawnsAfter: observations.filter(row => row.kind === "wsl_spawn").length,
          agyModelsAfter: ctx.modelRegistry.getAll().filter(model => model.provider === "omp-agy").map(model => model.id) });
      } finally { await child.session.dispose(); }
      ctx.ui.notify(JSON.stringify({ type: "activation-child", childSequence, promptSubmitted: false }), "info");
    },
  });
}
