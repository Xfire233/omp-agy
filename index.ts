import type { ExtensionAPI, ExtensionContext, ProviderModelConfig, SourceInfo } from "@oh-my-pi/pi-coding-agent";
import { readConfig, type AgyConfig } from "./src/config.ts";
import { API_ID, PROVIDER_ID, ProviderRuntime, type DiscoveredContextWindows } from "./src/provider.ts";
import { SessionController, discoverModels } from "./src/controller.ts";
import { bindProviderSession, routeProviderStream, unbindProviderSession } from "./src/router.ts";
import { encodeHostToolResult } from "./src/provenance.ts";
import { canonical } from "./src/ledger.ts";
import { DEFAULT_RUNNER_CONFIG, isRunnerProfile, RUNNER_PROFILES } from "./src/runner.ts";
import { join, resolve } from "node:path";
import { createQuotaProvider } from "./src/quota.ts";
import { createStatusDisplay } from "./src/status.ts";
import { DebugTrace } from "./src/debug.ts";
import { openAccountLogin, validateAccountLogin } from "./src/account-login.ts";

// OMP clears source registrations while preparing children sharing its registry.
// Republish only immutable model rows from successfully cleaned live discoveries;
// never persist them or share a controller, endpoint, pending tool or credential.
const liveCatalogs = new Map<string, { rows: readonly ProviderModelConfig[]; windows?: DiscoveredContextWindows }>();
let catalogEpoch = 0;
let catalogLoginInProgress = false;
function catalogKey(config: AgyConfig): string {
  const { discovery: _discovery, debug: _debug, ...effective } = config;
  return canonical({ ...effective, runner: { ...DEFAULT_RUNNER_CONFIG, ...config.runner } });
}
function rememberCatalog(key: string, models: ProviderModelConfig[], windows?: DiscoveredContextWindows): void {
  const rows = structuredClone(models);
  for (const row of rows) {
    Object.freeze(row.input); Object.freeze(row.cost);
    if (row.thinking) { Object.freeze(row.thinking.efforts); Object.freeze(row.thinking); }
    Object.freeze(row);
  }
  liveCatalogs.set(key, { rows: Object.freeze(rows), windows });
}
function publishedModels(key: string): ProviderModelConfig[] {
  const models = new Map<string, ProviderModelConfig>();
  for (const [source, { rows }] of liveCatalogs) for (const row of rows) {
    const previous = models.get(row.id);
    const name = source === key ? row.name : previous?.name ?? `${row.name} [configuration-specific availability]`;
    const efforts = row.reasoning && row.thinking
      ? row.thinking.efforts.filter(effort => !previous || (previous.reasoning && previous.thinking?.efforts.includes(effort))) : [];
    const preferredDefault = previous && previous.thinking?.defaultLevel !== row.thinking?.defaultLevel ? undefined : row.thinking?.defaultLevel;
    const thinking = efforts.length ? { mode: "effort" as const, efforts,
      ...(preferredDefault && efforts.includes(preferredDefault) ? { defaultLevel: preferredDefault } : {}) } : undefined;
    models.set(row.id, { ...row, name, cost: { ...row.cost },
      reasoning: !!thinking, thinking,
      input: previous ? previous.input.filter(type => row.input.includes(type)) : [...row.input],
      contextWindow: previous ? Math.min(previous.contextWindow, row.contextWindow) : row.contextWindow,
      maxTokens: previous ? Math.min(previous.maxTokens, row.maxTokens) : row.maxTokens });
  }
  return [...models.values()];
}

/** OMP rebinds this factory for children; no controller or queue lives at module scope. */
export default async function extension(pi: ExtensionAPI): Promise<void> {
  const runtime = new ProviderRuntime(readConfig());
  runtime.getPublishedContextWindows = version => {
    const windows = liveCatalogs.get(catalogKey(runtime.config))?.windows;
    return windows?.version === version ? windows : undefined;
  };
  const debug = new DebugTrace();
  runtime.debug = debug;
  if (runtime.config.debug) await debug.enable(runtime.config.debug.directory, runtime.config.debug.mode);
  const quota = createQuotaProvider(runtime.config.runner ?? {});
  const display = createStatusDisplay(() => runtime.displayState(), quota);
  pi.on("context", event => { runtime.captureContextImages(event.messages); });
  const toolOrigins = new Map<string, { name: string; source: SourceInfo }>();
  pi.on("tool_call", event => {
    if (!event.toolCallId.startsWith("omp_agy_")) return;
    const tool = pi.getAllTools().find(tool => tool.name === event.toolName);
    if (!tool) return;
    if (toolOrigins.size >= 128) toolOrigins.delete(toolOrigins.keys().next().value!);
    toolOrigins.set(event.toolCallId, { name: event.toolName, source: { ...tool.sourceInfo } });
  });
  runtime.resultForTool = (name, result) => {
    const origin = toolOrigins.get(result.toolCallId);
    toolOrigins.delete(result.toolCallId);
    return encodeHostToolResult(result, origin?.name === name ? origin.source : undefined);
  };
  // OMP spreads the command context, taking a snapshot of its live model getter.
  // Keep the lifecycle context (which preserves the getter) for persistent UI.
  let sessionContext: ExtensionContext | undefined;
  let displaySuspended = false;
  const attachDisplay = () => { if (sessionContext && !displaySuspended) display.bind(sessionContext); };
  let discoveryError: string | undefined;
  const restoreQuarantine = (ctx: ExtensionContext) => {
    const records = ctx.sessionManager.getBranch().flatMap(entry =>
      entry.type === "custom" && entry.customType === "omp-agy-steering-uncertain" ? [entry.data] : []);
    // A valid UNKNOWN identity can survive in a restored queue or effective
    // history even when /tree omits its later marker. Only malformed off-branch
    // records are ignored; marker absence never authorizes replay.
    const historicalRecords = ctx.sessionManager.getEntries().flatMap(entry =>
      entry.type === "custom" && entry.customType === "omp-agy-steering-uncertain" ? [entry.data] : []);
    if (!runtime.syncSteeringQuarantine(records, ctx.sessionManager.getSessionId(), historicalRecords)) {
      ctx.ui.notify("An AGY steering quarantine record is invalid; review this session before resuming its pending input.", "warning");
    }
  };
  runtime.onUncertainSteering = record => {
    if (sessionContext && record.sessionId === sessionContext.sessionManager.getSessionId()) {
      pi.appendEntry("omp-agy-steering-uncertain", record);
      restoreQuarantine(sessionContext);
      sessionContext.ui.notify("AGY steering delivery is UNKNOWN, not successful. The sent input is quarantined; remove its pending OMP entry manually before submitting fresh input. It will not be automatically sent to AGY again.", "error");
    } else {
      sessionContext?.ui.notify("An earlier session has uncertain AGY steering. It remains quarantined in this runtime, but could not be persisted into that session after the session changed. Do not replay its pending input.", "error");
    }
  };
  runtime.onDiagnostic = message => {
    sessionContext?.ui.notify(message, "warning");
  };
  const publish = () => pi.registerProvider(PROVIDER_ID, {
    api: API_ID, baseUrl: runtime.config.runner?.mode === "native" ? "acp://agy-native" : "acp://omp-agy-wsl", apiKey: "official-cli-session", authHeader: false,
    models: publishedModels(catalogKey(runtime.config)), streamSimple: routeProviderStream,
    usage: quota,
  });
  const register = async () => {
    if (catalogLoginInProgress) throw new Error("AGY account login is in progress. Run /agy-discover after the terminal closes.");
    const epoch = catalogEpoch;
    const key = catalogKey(runtime.config);
    const models = await runtime.discover();
    if (epoch !== catalogEpoch) throw new Error("An AGY account login attempt invalidated this discovery. Run /agy-discover again after the terminal closes.");
    rememberCatalog(key, models, runtime.discoveredContextWindows);
    publish(); discoveryError = undefined;
    return models;
  };
  // No fetchDynamicModels callback: OMP runs that on unrelated session startup
  // and persists its output in a provider-keyed SQLite cache with a 24-hour TTL.
  publish();
  pi.registerCommand("agy", {
    description: "Discover live AGY models and select an exact model ID without submitting a task",
    handler: async (args, ctx) => {
      const id = args.trim();
      if (!id) { ctx.ui.notify("Usage: /agy <exact-model-id>. Use /agy-discover to list live models first; discovery does not generate text.", "info"); return; }
      try {
        const models = await register();
        if (!models.some(model => model.id === id)) throw new Error(`AGY model ${JSON.stringify(id)} was not advertised by this live configuration. Use /agy-discover and choose an exact ID; no fallback model was selected.`);
        const model = ctx.modelRegistry.find(PROVIDER_ID, id);
        if (!model) throw new Error("OMP did not register the selected live AGY model; no model was selected");
        if (!await pi.setModel(model)) throw new Error("OMP refused the selected live AGY model; check its provider availability");
        ctx.ui.notify(`Selected AGY model ${id} from a verified live discovery. Submit a new explicit input to start AGY.`, "info");
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    },
  });
  pi.registerCommand("agy-status", {
    description: "Show bounded redacted AGY activation, cleanup, model and context-usage state",
    handler: async (_args, ctx) => { ctx.ui.notify(JSON.stringify(runtime.snapshot()), "info"); },
  });
  pi.registerCommand("agy-discover", {
    description: "Refresh models from a real ACP session, without generation or cached model guesses",
    handler: async (_args, ctx) => {
      try {
        const models = await register();
        const observed = runtime.discoveredContextWindows;
        const rows = models.map(({ id, contextWindow }) => {
          const window = observed?.get(id);
          return `${id}: OMP ${contextWindow}${window === undefined ? "" : ` (AGY observed ${window})`}`;
        });
        ctx.ui.notify(`AGY live model catalog refreshed for this configuration${observed ? ` (CLI ${observed.version})` : ""}:\n${rows.join("\n")}\nUse /agy <exact-model-id> to select.`, "info");
      }
      catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    },
  });
  pi.registerCommand("agy-profile", {
    description: "Select the AGY prompt profile for this extension session only",
    handler: async (args, ctx) => {
      const profile = args.trim();
      if (!isRunnerProfile(profile)) {
        ctx.ui.notify(`Usage: /agy-profile ${RUNNER_PROFILES.join("|")}. No global settings are changed.`, "info"); return;
      }
      try {
        await runtime.setProfile(profile);
        if (profile === "omp-system") ctx.ui.notify("This opt-in sends the OMP system prompt, which can include project rules, memories and extension instructions, to AGY on the next model input.", "warning");
        await register();
        ctx.ui.notify(`AGY profile is ${profile}. Effective history will rebuild on the next explicit input.`, "info");
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    },
  });
  pi.registerCommand("agy-login", {
    description: "Replace the dedicated WSL default AGY login using its official local terminal flow",
    handler: async (args, ctx) => {
      if (args.trim()) { ctx.ui.notify("/agy-login takes no arguments. Never paste an authorization code into OMP chat.", "warning"); return; }
      const idle = () => {
        if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("Account switching requires an idle OMP session with no queued input. No task was stopped.");
        runtime.assertLoginIdle();
      };
      try {
        validateAccountLogin(ctx, runtime.config.runner);
        idle();
        if (!await ctx.ui.confirm("Replace the default AGY account?", "This affects all OMP sessions using omp-agy-wsl. In the official CLI, /logout removes the old login even if you cancel the new one. Continuing an existing chat can send its history to the new account. Open the login terminal?")) return;
        idle();
        const result = await runtime.withAccountLogin(async () => {
          if (catalogLoginInProgress) throw new Error("AGY account login is already in progress in this OMP process.");
          catalogLoginInProgress = displaySuspended = true;
          try {
            display.dispose();
            // Cancellation after native /logout is not evidence the old account survived.
            catalogEpoch++;
            liveCatalogs.clear();
            // OMP treats models: [] as an override with no new rows, not removal.
            pi.unregisterProvider(PROVIDER_ID);
            await quota.invalidate();
            await ctx.modelRegistry.authStorage.usage.invalidate(PROVIDER_ID);
            return await openAccountLogin(ctx, runtime.config.runner);
          } finally {
            catalogLoginInProgress = displaySuspended = false;
            publish(); // Restore the stream and usage registration, not old model rows.
            attachDisplay();
          }
        });
        if (result.exitCode === 75) ctx.ui.notify("AGY login is busy or another activation still exists. Close its owning session before retrying; no worker was killed.", "warning");
        else if (result.exitCode !== 0) ctx.ui.notify(`AGY login terminal exited (${result.exitCode}); login was not verified. Run /agy-discover to check access and refresh the model list.`, "warning");
        else ctx.ui.notify("AGY login terminal closed. Run /agy-discover to verify access and refresh the model list. No task was submitted.", "info");
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "AGY login could not start", "error"); }
    },
  });
  pi.registerCommand("agy-stop", {
    description: "Revoke AGY capabilities and confirm Linux cleanup; never replay the stopped task",
    handler: async (_args, ctx) => {
      ctx.abort();
      try { await runtime.stop("Explicit /agy-stop"); ctx.ui.notify("AGY producer cleaned up. Existing tool effects were not rolled back; submit a new explicit input to continue.", "warning"); }
      catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    },
  });
  pi.registerCommand("agy-reset", {
    description: "Recover stale AGY registry entries only after Linux identity checks confirm no owned process survives",
    handler: async (_args, ctx) => {
      try {
        if (runtime.config.runner?.mode === "native") throw new Error("/agy-reset manages the dedicated WSL registry only; no native processes were changed.");
        const report = await runtime.reset();
        ctx.ui.notify(`AGY recovery verified: ${JSON.stringify(report)}. Existing tool effects were not rolled back and tasks were not replayed. Use /agy-discover or submit a new explicit input to continue.`, "info");
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    },
  });
  pi.registerCommand("agy-debug", {
    description: "Enable bounded metadata/content tracing, disable it, or inspect trace status",
    handler: async (args, ctx) => {
      const match = /^(on|content|off|status)(?:\s+([\s\S]+))?$/.exec(args.trim() || "status");
      if (!match || ((match[1] === "off" || match[1] === "status") && match[2])) {
        ctx.ui.notify("Usage: /agy-debug on [directory] | content [directory] | off | status", "info"); return;
      }
      try {
        if (match[1] === "off") await debug.disable();
        else if (match[1] !== "status") {
          const mode = match[1] === "content" ? "content" : "metadata";
          if (mode === "content") ctx.ui.notify("Content tracing can retain sensitive task text despite redaction. Protect the local trace files; images and credentials are not recorded verbatim.", "warning");
          await debug.enable(resolve(ctx.cwd, match[2]?.trim() || join(".omp", "agy-debug")), mode);
        }
        ctx.ui.notify(JSON.stringify(debug.status()), "info");
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    sessionContext = ctx;
    bindProviderSession(ctx.sessionManager.getSessionId(), runtime);
    restoreQuarantine(ctx);
    attachDisplay();
    const trace = debug.status();
    if (trace.state === "failed") ctx.ui.notify(`AGY debug tracing failed: ${trace.error ?? "unknown error"}`, "warning");
    else if (trace.state === "enabled" && !trace.truncated && trace.mode === "content") ctx.ui.notify("AGY content tracing is enabled; local trace files can contain sensitive task text despite redaction.", "warning");
    if (discoveryError) ctx.ui.notify(`AGY live discovery failed: ${discoveryError}. No fabricated models were registered. Check the selected runner, then use /agy-discover.`, "error");
  });
  const rebuildForHistory = async (ctx: ExtensionContext, reason: string) => {
    sessionContext = ctx; bindProviderSession(ctx.sessionManager.getSessionId(), runtime);
    await runtime.stop(`OMP ${reason}: rebuild from effective history`, false);
    if (sessionContext !== ctx) return; // A newer lifecycle attachment or shutdown owns the display.
    restoreQuarantine(ctx);
    // History navigation can clear host widgets even when cached rows are unchanged.
    attachDisplay();
  };
  pi.on("session_switch", async (_event, ctx) => { await rebuildForHistory(ctx, "session_switch"); });
  pi.on("session_branch", async (_event, ctx) => { await rebuildForHistory(ctx, "session_branch"); });
  pi.on("session_compact", async (_event, ctx) => { await rebuildForHistory(ctx, "session_compact"); });
  pi.on("session_tree", async (_event, ctx) => { await rebuildForHistory(ctx, "session_tree"); });
  pi.on("agent_end", async event => {
    if (!event.willContinue && runtime.snapshot().phase === "active") await runtime.stop("OMP agent ended with unfinished ACP/MCP work");
    if (!event.willContinue) toolOrigins.clear();
    void display.refresh();
  });
  pi.on("session_shutdown", async () => {
    sessionContext = undefined;
    display.dispose(); toolOrigins.clear();
    unbindProviderSession(runtime);
    try { await runtime.stop("OMP extension session shutdown"); }
    finally { await debug.close(); }
  });
  if (runtime.config.discovery === "startup" && !liveCatalogs.has(catalogKey(runtime.config))) {
    try { await register(); }
    catch (error) { discoveryError = error instanceof Error ? error.message : String(error); }
  }
}

export { ProviderRuntime, SessionController, discoverModels, readConfig };
