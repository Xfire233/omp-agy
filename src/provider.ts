import { createHash } from "node:crypto";
import {
  createAssistantMessageEventStream,
  type Api, type AssistantMessage, type AssistantMessageEventStream, type Context, type LiveSteerClaim,
  type DeveloperMessage, type Model, type SimpleStreamOptions, type ToolCall, type ToolResultMessage, type UserMessage,
} from "@oh-my-pi/pi-ai";
import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import { providerImageBudget } from "@oh-my-pi/snapcompact/snapcompact";
import Ajv from "ajv";
import { assertJsonValue, type ToolDefinition } from "./catalog.ts";
import { ActivationCleanupError, SessionController, type ModelDiscovery, type ControllerEvent } from "./controller.ts";
import { ContextLedger, canonical, encodeMessages, messageKey, steeringText, validateMessages, type HostContextImageMessage } from "./ledger.ts";
import type { AgyConfig } from "./config.ts";
import type { TrustedResult } from "./results.ts";
import { normalizeOmpSystemPrompt, resetRunner, type RunnerResetReport } from "./runner.ts";
import { ContextLimitError, contextLimitFor, resolveContextWindow } from "./context-limits.ts";
import { thinkingMetadata } from "./thinking.ts";
import { discoveryConfig, ThinkingSelectionError } from "./protocol.ts";
import { debugEvent, type DebugObserver } from "./debug.ts";

export const PROVIDER_ID = "omp-agy";
export const API_ID = "omp-agy-acp";
export const SYSTEM_PROMPT_BOUNDARY = "D04: standalone context.systemPrompt is not sent. OMP child role/spawn instructions and online title instructions are system-prompt-only in upstream 18.13.1; those semantics are NOT supported unless separately present in effective messages. Compaction has additional user-message instructions but loses its separate system semantics. Mounted MCP xd:// route catalogs and server instructions are also omitted when only present in that system prompt. Configure auxiliary/role providers in OMP explicitly; omp-agy never modifies them.";

interface InputAttempt {
  sessionId: string | undefined;
  currentInput: string[];
  inputs: Set<string>;
}

export interface SteeringQuarantineRecord {
  version: 1;
  sessionId?: string;
  messages: readonly (UserMessage | DeveloperMessage)[];
  reason: string;
  recordedAt: number;
}

/** Persisted history is untrusted data, not a cast back to provider messages. */
export const isSteeringQuarantineRecord = new Ajv().compile<SteeringQuarantineRecord>({
  type: "object", required: ["version", "messages", "reason", "recordedAt"],
  properties: {
    version: { const: 1 }, sessionId: { type: "string" }, reason: { type: "string" }, recordedAt: { type: "number" },
    messages: { type: "array", minItems: 1, items: {
      type: "object", required: ["role", "content", "timestamp"],
      properties: {
        role: { enum: ["user", "developer"] }, timestamp: { type: "number" },
        content: { anyOf: [{ type: "string" }, { type: "array", items: { anyOf: [
          { type: "object", required: ["type", "text"], properties: { type: { const: "text" }, text: { type: "string" } } },
          { type: "object", required: ["type", "data", "mimeType"], properties: { type: { const: "image" }, data: { type: "string" }, mimeType: { type: "string" } } },
        ] } }] },
      },
    } },
  },
});
const steeringIdentity = (message: UserMessage | DeveloperMessage): string => canonical({ timestamp: message.timestamp, message: messageKey(message) });

/** Live status ownership only; discovery evidence and stopped activations are absent. */
export interface ProviderDisplayState {
  generation: number;
  sessionId?: string;
  modelId?: string;
  phase: "idle" | "active";
  contextUsage?: Readonly<{ used: number; size: number }>;
}

/** All mutable state is factory-local. Prepared child factories construct a new instance. */
export class ProviderRuntime {
  private controller?: SessionController;
  private ledger = new ContextLedger();
  private binding?: string;
  private ompSystemPromptDigest?: string;
  private ompSystemPromptDeferred = false;
  private busy = false;
  private accountLogin = false;
  // Missing identity is a stable, runtime-local direct-call bucket. The production
  // router still requires a real host session ID before reaching this runtime.
  private dirtyInputs = new Map<string | undefined, Set<string>>();
  private steeringQuarantine = new Map<string | undefined, Set<string>>();
  private invalidSteeringQuarantine = new Set<string | undefined>();
  private inputOwner?: InputAttempt;
  private cleanupBlocked?: ActivationCleanupError;
  private systemDiagnosticShown = false;
  private invocations = 0;
  private rebuilds = 0;
  private lastDiscovery?: ModelDiscovery;
  private diagnostics: string[] = [];
  private expectedTool?: { id: string; name: string; arguments: Record<string, unknown> };
  private deferredInput: (UserMessage | DeveloperMessage)[] = [];
  private auxiliaries = new Set<ProviderRuntime>();
  private auxiliaryOwner?: ProviderRuntime;
  private auxiliaryAbort?: AbortController;
  private operation?: { abort: AbortController; done: Promise<void>; kind?: "profile" };
  private stopBarrier?: Promise<void>;
  private epoch = 0;
  onDiagnostic?: (message: string) => void;
  onUncertainSteering?: (record: SteeringQuarantineRecord) => void;
  resultForTool?: (toolName: string, result: ToolResultMessage) => TrustedResult;
  debug?: DebugObserver;

  constructor(public config: AgyConfig) {}
  /** Only invalid active-branch records block all admission. Exact UNKNOWN inputs
   * remain fenced across tree navigation, pending-queue restoration and reloads. */
  syncSteeringQuarantine(records: readonly unknown[], currentSessionId?: string, historicalRecords: readonly unknown[] = []): boolean {
    const owner = this.auxiliaryOwner ?? this;
    let valid = true;
    for (const record of records) {
      if (!isSteeringQuarantineRecord(record)) { valid = false; continue; }
      owner.rememberSteeringQuarantine(record, currentSessionId);
    }
    for (const record of historicalRecords) {
      if (isSteeringQuarantineRecord(record)) owner.rememberSteeringQuarantine(record, currentSessionId);
    }
    if (valid) owner.invalidSteeringQuarantine.delete(currentSessionId);
    else owner.invalidSteeringQuarantine.add(currentSessionId);
    return valid;
  }
  private rememberSteeringQuarantine(record: SteeringQuarantineRecord, sessionId: string | undefined): void {
    let identities = this.steeringQuarantine.get(sessionId);
    if (!identities) this.steeringQuarantine.set(sessionId, identities = new Set());
    for (const message of record.messages) identities.add(steeringIdentity(message));
  }
  private isQuarantined(sessionId: string | undefined, message: UserMessage | DeveloperMessage): boolean {
    return (this.auxiliaryOwner ?? this).steeringQuarantine.get(sessionId)?.has(steeringIdentity(message)) ?? false;
  }
  private quarantineSteering(sessionId: string | undefined, messages: readonly (UserMessage | DeveloperMessage)[], error: Error): void {
    const owner = this.auxiliaryOwner ?? this;
    const record: SteeringQuarantineRecord = { version: 1, sessionId, messages: structuredClone(messages), reason: error.message, recordedAt: Date.now() };
    // Fence synchronously before notifying the host. Missing/failed persistence,
    // navigation and settled operations never authorize replay of this identity.
    owner.rememberSteeringQuarantine(record, sessionId);
    owner.onUncertainSteering?.(record);
    owner.diagnostic("Native steering receipt is unknown, not delivered. The exact sent input is quarantined from AGY. OMP may restore its pending entry; clear that entry manually, then submit fresh explicit input. Historical unknown input remains excluded from AGY rebuilds.");
  }
  private diagnostic(message: string): void {
    this.diagnostics.push(message);
    if (this.diagnostics.length > 12) this.diagnostics.shift();
    this.onDiagnostic?.(message);
  }
  private markDirty(attempt: InputAttempt | undefined): void {
    if (!attempt) return;
    let inputs = this.dirtyInputs.get(attempt.sessionId);
    if (!inputs) this.dirtyInputs.set(attempt.sessionId, inputs = new Set());
    for (const input of attempt.inputs) inputs.add(input);
  }
  async discover(): Promise<ProviderModelConfig[]> {
    while (this.stopBarrier) await this.stopBarrier;
    if (this.busy || this.auxiliaries.size || this.controller?.phase === "active") throw new Error("Model discovery requires an idle provider boundary; no active task is cancelled implicitly");
    if (this.cleanupBlocked) throw this.cleanupBlocked;
    if (this.controller?.phase === "cleanup_failed") throw this.controller.failure;
    const done = Promise.withResolvers<void>();
    const operation = { abort: new AbortController(), done: done.promise };
    this.operation = operation; this.busy = true; this.epoch++;
    let controller: SessionController | undefined;
    try {
      const previous = this.controller;
      if (previous) {
        await previous.stop(new Error("Explicit live model rediscovery"));
        if (previous.phase === "cleanup_failed") throw previous.failure;
        operation.abort.signal.throwIfAborted();
      }
      this.expectedTool = undefined; this.deferredInput = []; this.binding = undefined; this.ledger.clear();
      controller = await SessionController.open(discoveryConfig(this.config), [], { debug: this.debug }, operation.abort.signal);
      this.controller = controller;
      operation.abort.signal.throwIfAborted();
      const discovery: ModelDiscovery = { models: await controller.discoverModelOptions(), images: !!controller.capabilities.image, evidence: {} };
      operation.abort.signal.throwIfAborted();
      await controller.stop(new Error("Live model discovery complete"));
      if (controller.phase === "cleanup_failed") throw controller.failure;
      operation.abort.signal.throwIfAborted();
      discovery.evidence = controller.snapshot(); this.controller = undefined;
      const version = controller.runner.evidence.version;
      const models: ProviderModelConfig[] = [];
      let adjustments = 0;
      for (const model of discovery.models) {
        const contextWindow = resolveContextWindow(version, model.id, this.config.contextWindow);
        const limit = contextLimitFor(version, model.id);
        if (!limit || (this.config.contextWindow !== undefined && contextWindow < this.config.contextWindow)) {
          if (++adjustments <= 8) this.diagnostic(`AGY context budget for ${JSON.stringify(model.id.slice(0, 128))} (CLI ${JSON.stringify(version.slice(0, 128))}): ${!limit
            ? `capacity unknown; using local budget ${contextWindow}, not a verified native ceiling.`
            : `requested ${this.config.contextWindow} clamped to known ceiling ${contextWindow}.`}`);
        }
        models.push({ id: model.id, name: `${model.name} (AGY ACP)`,
          ...thinkingMetadata(model.thinking), input: discovery.images ? ["text", "image"] : ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow, maxTokens: this.config.maxTokens });
      }
      if (adjustments > 8) this.diagnostic(`AGY context budgets: ${adjustments - 8} additional clamped or capacity-unknown live models; only the first 8 details are shown.`);
      if (!models.length) throw new Error("No models were advertised by this live AGY configuration. No fallback model was registered.");
      this.lastDiscovery = discovery;
      this.diagnostic("Live ACP models discovered. Known context ceilings use version-pinned table evidence; unknown capacities use local fallback budgets, not native-capacity claims. Pricing and billed usage are unavailable.");
      return models;
    } catch (error) {
      if (error instanceof ActivationCleanupError) this.cleanupBlocked = error;
      if (controller) {
        await controller.stop(error instanceof Error ? error : new Error(String(error)));
        if (controller.phase === "cleanup_failed") {
          this.cleanupBlocked = controller.failure instanceof ActivationCleanupError ? controller.failure :
            new ActivationCleanupError(controller.cleanup, controller.failure?.message ?? "Unconfirmed discovery cleanup");
          throw this.cleanupBlocked;
        }
        if (controller.phase === "stopped" && this.controller === controller) this.controller = undefined;
      }
      throw error;
    } finally {
      this.busy = false; if (this.operation === operation) this.operation = undefined; done.resolve();
    }
  }
  /** Attest host-owned image history before OMP applies per-request image caps. */
  captureContextImages(messages: readonly HostContextImageMessage[]): void {
    this.ledger.captureContextImages(messages);
  }
  displayState(): ProviderDisplayState | undefined {
    const controller = this.controller;
    if (!this.binding || !controller || (controller.phase !== "idle" && controller.phase !== "active")) return undefined;
    return { generation: this.epoch, sessionId: this.inputOwner?.sessionId, modelId: controller.selectedModel,
      phase: controller.phase, contextUsage: controller.contextUsage };
  }
  snapshot(): Record<string, unknown> {
    return { type: "omp-agy-status", providerInvocations: this.invocations, rebuilds: this.rebuilds,
      busy: this.busy, auxiliaryActivations: this.auxiliaries.size, requiresNewInput: this.dirtyInputs.size > 0, expectedToolId: this.expectedTool?.id,
      ...this.lastDiscovery?.evidence, ...this.controller?.snapshot(), advertisedModels: this.controller?.models ?? this.lastDiscovery?.models ?? [],
      diagnostics: [...this.diagnostics], profile: this.config.profile, ...(this.cleanupBlocked ? { phase: "cleanup_failed", failure: this.cleanupBlocked.message } : {}) };
  }
  stop(reason: string, dirty = true): Promise<void> {
    this.auxiliaryAbort?.abort(new Error(reason));
    if (dirty && (this.controller?.phase === "active" || (this.busy && this.operation?.kind !== "profile"))) this.markDirty(this.inputOwner);
    this.operation?.abort.abort(new DOMException(reason, "AbortError"));
    if (this.stopBarrier) return this.stopBarrier;
    // Invalidate old callbacks now; a new invocation cannot enter until cleanup and
    // the old consumer (including cold setup) have both crossed this barrier.
    this.epoch++;
    const operation = this.operation;
    const controller = this.controller;
    const auxiliaryStops = [...this.auxiliaries].map(auxiliary => auxiliary.stop(reason, dirty));
    const barrier = Promise.resolve().then(async () => {
      const results = await Promise.allSettled([
        ...auxiliaryStops,
        (async () => {
          try { await controller?.stop(new Error(reason)); }
          finally { await operation?.done; }
          if (this.controller?.phase === "cleanup_failed") throw this.controller.failure;
        })(),
      ]);
      for (const result of results) if (result.status === "rejected") {
        if (result.reason instanceof ActivationCleanupError) this.cleanupBlocked = result.reason;
        throw result.reason;
      }
      if (this.cleanupBlocked) throw this.cleanupBlocked;
      this.expectedTool = undefined; this.deferredInput = []; this.binding = undefined; this.ledger.clear();
    }).finally(() => { if (this.stopBarrier === barrier) this.stopBarrier = undefined; });
    this.stopBarrier = barrier;
    return barrier;
  }
  async reset(): Promise<RunnerResetReport> {
    if (this.stopBarrier || this.busy || this.auxiliaries.size || this.controller?.phase === "active" || this.controller?.phase === "stopping") throw new Error("AGY reset requires host idle; stop outstanding work first");
    const done = Promise.withResolvers<void>();
    const operation = { abort: new AbortController(), done: done.promise };
    this.operation = operation; this.busy = true; this.epoch++;
    try {
      if (this.controller?.phase === "idle") {
        try { await this.controller.stop(new Error("Explicit verified AGY recovery")); }
        catch (error) {
          if (!(error instanceof ActivationCleanupError)) throw error;
          this.cleanupBlocked = error;
        }
      }
      operation.abort.signal.throwIfAborted();
      const report = await resetRunner(this.config.runner);
      operation.abort.signal.throwIfAborted();
      // Runner recovery has verified ownership and absence of live workers. It
      // alone can release the cleanup fence; dirty input identities remain fenced.
      this.cleanupBlocked = undefined; this.controller = undefined;
      this.expectedTool = undefined; this.deferredInput = []; this.binding = undefined; this.ledger.clear();
      return report;
    } finally {
      this.busy = false; if (this.operation === operation) this.operation = undefined; done.resolve();
    }
  }
  assertLoginIdle(): void {
    if (this.cleanupBlocked) throw this.cleanupBlocked;
    if (this.busy || this.stopBarrier || this.auxiliaries.size || this.expectedTool || this.deferredInput.length ||
      (this.controller && this.controller.phase !== "idle" && this.controller.phase !== "stopped")) {
      throw new Error("Account switching requires an idle AGY provider with no pending work. No task was stopped.");
    }
  }

  async withAccountLogin<T>(open: () => Promise<T>): Promise<T> {
    this.assertLoginIdle();
    this.busy = true; this.accountLogin = true; this.epoch++;
    try {
      await this.controller?.stop(new Error("Closing idle AGY session before explicit account switch"));
      if (this.controller?.phase === "cleanup_failed") throw this.controller.failure;
      this.controller = undefined; this.lastDiscovery = undefined;
      this.binding = undefined; this.ledger.clear();
      // Quarantine and already-attempted input identities survive account changes.
      return await open();
    } catch (error) {
      if (error instanceof ActivationCleanupError) this.cleanupBlocked = error;
      throw error;
    } finally { this.accountLogin = false; this.busy = false; }
  }

  async setProfile(profile: AgyConfig["profile"]): Promise<void> {
    if (this.stopBarrier || this.busy || this.auxiliaries.size || this.controller?.phase === "active" || this.controller?.phase === "stopping") throw new Error("Profile changes require host idle; use /agy-stop to cancel outstanding work first");
    if (this.cleanupBlocked) throw this.cleanupBlocked;
    const done = Promise.withResolvers<void>();
    const operation = { abort: new AbortController(), done: done.promise, kind: "profile" as const };
    this.operation = operation; this.busy = true; this.epoch++;
    try {
      // Own cleanup directly: runtime.stop would capture this operation and wait
      // for its done promise, creating a self-wait. External stop may still abort
      // this reservation and await it before releasing its own barrier.
      await this.controller?.stop(new Error("Explicit AGY profile change"));
      if (this.controller?.phase === "cleanup_failed") throw this.controller.failure;
      operation.abort.signal.throwIfAborted();
      this.expectedTool = undefined; this.deferredInput = []; this.binding = undefined; this.ledger.clear();
      this.config = { ...this.config, profile };
    } catch (error) {
      if (error instanceof ActivationCleanupError) this.cleanupBlocked = error;
      throw error;
    } finally {
      this.busy = false; if (this.operation === operation) this.operation = undefined; done.resolve();
    }
  }

  stream(model: Model<Api>, context: Context, options: SimpleStreamOptions = {}): AssistantMessageEventStream {
    // OMP 18.13.1 supplies this canonical operation classification to both
    // parallel portable summary calls, including for non-Codex providers.
    // Never infer an auxiliary from prompt text or an empty tool catalog.
    if (!this.auxiliaryOwner && !this.cleanupBlocked && !this.accountLogin && this.operation?.kind !== "profile" && options.codexCompaction?.implementation === "responses") {
      const auxiliary = new ProviderRuntime({ ...this.config });
      auxiliary.auxiliaryOwner = this; auxiliary.auxiliaryAbort = new AbortController();
      auxiliary.onDiagnostic = message => this.diagnostic(message);
      auxiliary.resultForTool = this.resultForTool;
      auxiliary.debug = this.debug;
      this.auxiliaries.add(auxiliary);
      return auxiliary.stream(model, context, { ...options, signal: options.signal
        ? AbortSignal.any([options.signal, auxiliary.auxiliaryAbort.signal]) : auxiliary.auxiliaryAbort.signal });
    }
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: Date.now() };
    stream.push({ type: "start", partial: message });
    const work = this.run(model, context, options, stream, message);
    void work.catch(error => {
      message.stopReason = options.signal?.aborted || message.stopReason === "aborted" ? "aborted" : "error";
      message.errorMessage = error instanceof Error ? error.message : String(error);
      debugEvent(this.debug, "omp.provider.output", message, { ompSessionId: options.sessionId, activationGeneration: this.controller?.runner?.evidence.generation, acpSessionId: this.controller?.sessionId });
      stream.push({ type: "error", reason: message.stopReason, error: message }); stream.end();
    });
    return stream;
  }

  private async run(model: Model<Api>, context: Context, options: SimpleStreamOptions, stream: AssistantMessageEventStream, message: AssistantMessage): Promise<void> {
    try {
      while (this.auxiliaryOwner?.stopBarrier) await this.auxiliaryOwner.stopBarrier;
      while (this.stopBarrier) await this.stopBarrier;
      if (this.auxiliaryOwner?.cleanupBlocked) throw this.auxiliaryOwner.cleanupBlocked;
    } catch (error) { this.auxiliaryOwner?.auxiliaries.delete(this); throw error; }
    if (this.busy) throw new Error("Concurrent provider consumers for the same extension session are not allowed");
    const done = Promise.withResolvers<void>();
    const operation = { abort: new AbortController(), done: done.promise };
    this.operation = operation;
    this.busy = true; this.invocations++;
    const hostSignal = options.signal;
    const signal = hostSignal ? AbortSignal.any([hostSignal, operation.abort.signal]) : operation.abort.signal;
    options = { ...options, signal };
    let invocation = new AbortController();
    let steeringLoop: Promise<void> | undefined;
    let submitted = false;
    let controller: SessionController | undefined;
    let attempt: InputAttempt | undefined;
    const abort = () => {
      invocation.abort(signal.reason);
      if (controller && hostSignal?.aborted) void controller.fail(new Error("Active OMP provider signal aborted; activation stopped conservatively, effects may already exist"));
      else controller?.wake();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) throw new Error("OMP provider invocation was already aborted; no input submitted");
      if (this.cleanupBlocked) throw this.cleanupBlocked;
      if ((this.auxiliaryOwner ?? this).invalidSteeringQuarantine.has(options.sessionId)) throw new Error("Saved unknown-receipt steering quarantine is invalid. AGY admission is blocked for this session; review the saved quarantine record before continuing.");
      validateMessages(context.messages);
      const explicit = context.messages.filter((entry): entry is UserMessage | DeveloperMessage => (entry.role === "user" || entry.role === "developer") && !entry.synthetic);
      const latest = explicit.at(-1);
      if (latest && this.isQuarantined(options.sessionId, latest)) throw new Error("Unknown-receipt steering input is quarantined, not confirmed delivered. No AGY request was sent. Clear its pending OMP entry manually and submit fresh explicit input; do not resubmit the quarantined original.");
      // Preserve OMP history, but never rebuild AGY with an input whose effects
      // are unknown. A later fresh input does not release this quarantine.
      context = { ...context, messages: context.messages.filter(entry => (entry.role !== "user" && entry.role !== "developer") || !this.isQuarantined(options.sessionId, entry)) };
      this.ledger.setImageBudget(model.input.includes("image") ? providerImageBudget(model) : Number.POSITIVE_INFINITY);
      debugEvent(this.debug, "omp.provider.input", () => ({ model: model.id, reasoning: options.reasoning, disableReasoning: options.disableReasoning, messages: context.messages, tools: context.tools }),
        { ompSessionId: options.sessionId, activationGeneration: this.controller?.runner?.evidence.generation, acpSessionId: this.controller?.sessionId });
      const diagnosticOwner = this.auxiliaryOwner ?? this;
      const useOmpSystemPrompt = this.config.profile === "omp-system";
      const ompSystemPrompt = useOmpSystemPrompt && context.systemPrompt
        ? normalizeOmpSystemPrompt(context.systemPrompt.join("\n\n")) : undefined;
      const nextPromptDigest = ompSystemPrompt?.trim() ? createHash("sha256").update(ompSystemPrompt).digest("hex") : undefined;
      if (!useOmpSystemPrompt && context.systemPrompt?.length && !diagnosticOwner.systemDiagnosticShown) {
        diagnosticOwner.systemDiagnosticShown = true; diagnosticOwner.diagnostic(SYSTEM_PROMPT_BOUNDARY);
      }
      if (this.controller?.failure) this.markDirty(this.inputOwner);
      const currentInput = this.ledger.explicitInputKeys(context.messages);
      const input = canonical(currentInput);
      const dirtyInputs = this.dirtyInputs.get(options.sessionId);
      if (dirtyInputs) {
        if (dirtyInputs.has(input)) throw new Error("Previous AGY attempt stopped dirty or with unknown effects. Automatic replay is blocked; submit a new explicit input. Already executed tools are not rolled back.");
      }
      attempt = { sessionId: options.sessionId, currentInput, inputs: new Set([input]) };
      const tools: ToolDefinition[] = (context.tools ?? []).map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
      assertJsonValue(tools);
      signal.throwIfAborted();
      // Contract §4.3 requires model changes to rebuild; selectModel still applies
      // the requested model when session/new initially selects a different default.
      const binding = canonical({ sessionId: options.sessionId ?? null, cwd: options.cwd ?? process.cwd(), model: model.id,
        profile: this.config.profile, instructions: this.config.instructions, tools });
      const comparison = this.ledger.compare(context.messages);
      const previous = this.controller;
      const ompSystemPromptChanged = useOmpSystemPrompt && nextPromptDigest !== this.ompSystemPromptDigest;
      // A prompt-only change must neither abandon an original MCP request nor replay a completed turn.
      const promptRebuild = ompSystemPromptChanged && previous?.phase === "idle" && !this.expectedTool &&
        (this.deferredInput.length > 0 || comparison.appended.some(entry => entry.role === "user" || entry.role === "developer"));
      const rebuild = !previous || previous.phase === "stopped" || previous.phase === "stopping" || previous.phase === "cleanup_failed" ||
        previous.failure || binding !== this.binding || !comparison.continuous || promptRebuild;
      const promptDeferred = !rebuild && ompSystemPromptChanged && (previous?.phase === "active" || !!this.expectedTool);
      if (promptDeferred && !this.ompSystemPromptDeferred) {
        this.ompSystemPromptDeferred = true;
        this.diagnostic("OMP system prompt changed during an active AGY turn; the current MCP continuation retains its instructions. Changes apply at the next safe input boundary.");
      }
      debugEvent(this.debug, "omp.provider.rebuild", () => {
        const before = this.binding ? JSON.parse(this.binding) as Record<string, unknown> : undefined;
        const after = JSON.parse(binding) as Record<string, unknown>;
        return { rebuild: !!rebuild, controllerMissing: !previous, phase: previous?.phase, controllerFailed: !!previous?.failure,
          bindingChanged: binding !== this.binding, changedBindingKeys: before ? Object.keys(after).filter(key => canonical(before[key]) !== canonical(after[key])) : [],
          historyContinuous: comparison.continuous, ...(useOmpSystemPrompt ? { ompSystemPromptChanged, ompSystemPromptDeferred: promptDeferred } : {}), ledger: this.ledger.explain(context.messages) };
      }, { ompSessionId: options.sessionId, activationGeneration: previous?.runner?.evidence.generation, acpSessionId: previous?.sessionId });
      if (rebuild) {
        if (useOmpSystemPrompt && !nextPromptDigest) throw new Error("omp-system requires a nonempty OMP system prompt for this call; no AGY prompt was submitted.");
        const epoch = ++this.epoch;
        if (previous) {
          await previous.stop(new Error(promptRebuild ? "OMP system prompt changed; rebuilding for new input" : "Effective history, model, profile, session identity or tool catalog changed; rebuilding from OMP history"));
          if (previous.phase === "cleanup_failed") throw previous.failure;
          signal.throwIfAborted();
          this.rebuilds++;
          this.diagnostic("AGY rebuilt from current effective OMP history; original AGY hidden state is not restored. Historical tool calls are records, not replay requests.");
        }
        this.expectedTool = undefined; this.deferredInput = []; this.ledger.clear();
        this.inputOwner = attempt;
        controller = await SessionController.open(this.config, tools, {
          debug: this.debug, debugContext: () => ({ ompSessionId: options.sessionId }),
          diagnostic: text => { if (epoch === this.epoch) this.diagnostic(text); },
          failed: () => { if (epoch === this.epoch) this.markDirty(this.inputOwner); },
        }, signal, ompSystemPrompt);
        this.controller = controller; this.binding = binding;
        this.ompSystemPromptDigest = nextPromptDigest; this.ompSystemPromptDeferred = false;
        signal.throwIfAborted();
        this.validateContextWindow(controller, model);
        await controller.selectModel(model.id);
        signal.throwIfAborted();
        await controller.selectThinking(options);
        signal.throwIfAborted();
        const prompt = encodeMessages(context.messages, controller.capabilities, true);
        this.ledger.checkpoint(context.messages);
        if (dirtyInputs) this.dirtyInputs.delete(options.sessionId);
        controller.begin(prompt); submitted = true;
      } else {
        if (!previous) throw new Error("Provider activation missing");
        this.validateContextWindow(previous, model);
        controller = previous;
        const requestedThinking = options.disableReasoning ? "off" : options.reasoning;
        if (controller.phase === "active" && requestedThinking !== undefined) {
          let changed = true;
          try { changed = requestedThinking !== controller.thinking?.currentValue; }
          catch (error) {
            if (!(error instanceof ThinkingSelectionError)) throw error;
            this.diagnostic(`AGY active thinking metadata is unavailable: ${error.message}. The original MCP continuation is preserved; validation remains required before the next idle prompt.`);
          }
          if (changed) this.diagnostic(`AGY thinking request ${JSON.stringify(requestedThinking)} is deferred: the active ACP turn and its original MCP continuation retain their current setting. The request is not applied or confirmed; it will be validated before the next idle prompt if still requested.`);
        }
        this.inputOwner = attempt;
        const appended = comparison.appended;
        const boundaryInput = appended.filter(entry => entry.role === "user" || entry.role === "developer");
        const results = appended.filter(entry => entry.role === "toolResult");
        let boundaryDelivered = false;
        if (this.expectedTool) {
          const pending = this.expectedTool;
          const matching = results.filter(result => result.toolCallId === pending.id);
          if (matching.length !== 1 || matching[0]!.toolName !== pending.name) throw new Error("Missing, conflicting, or duplicate final OMP tool result; original MCP pending was not consumed");
          const historicalCall = context.messages.flatMap(entry => entry.role === "assistant" ? entry.content.filter(block => block.type === "toolCall" && block.id === pending.id) : []);
          if (historicalCall.length !== 1 || historicalCall[0]!.type !== "toolCall" || canonical(historicalCall[0]!.arguments) !== canonical(pending.arguments)) throw new Error("OMP tool identity/arguments changed before MCP completion; pending was not consumed");
          if (results.some(result => result.toolCallId !== pending.id)) throw new Error("Unknown tool result does not consume the dispatched MCP request");
          // Boundary inputs steer the still-active session before the original handler resumes.
          const boundarySteering = boundaryInput.length && controller.activeFlights ? this.steerBoundary(controller, boundaryInput, options.sessionId) : undefined;
          // The official replacement prompt can depend on the parked original MCP result.
          // Launch steering before completing that result, but do not deadlock awaiting it first.
          if (boundarySteering) void boundarySteering.catch(() => {});
          const result = matching[0]!;
          await controller.bridge.complete(pending.id, this.resultForTool?.(pending.name, result) ?? { source: "content", content: result.content, isError: result.isError });
          signal.throwIfAborted();
          if (boundarySteering) { await this.waitBoundarySteering(controller, boundarySteering, signal); boundaryDelivered = true; }
          signal.throwIfAborted();
          this.expectedTool = undefined;
        } else if (results.length) throw new Error("Unexpected tool result without a live MCP request; no tool was replayed");
        if (controller.phase !== "idle") this.ledger.checkpoint(context.messages);
        // Native boundary steering was already in host history, not a live claim: do not append it again after output.
        if (!boundaryDelivered && controller.phase === "active" && boundaryInput.length && !controller.activeFlights) {
          this.deferredInput.push(...boundaryInput);
          this.diagnostic("Queued input arrived after the ACP turn ended; it is preserved for the next turn after outstanding MCP work drains, not reported as real-time steering.");
        } else if (controller.phase === "idle") {
          const nextInput = [...this.deferredInput, ...boundaryInput];
          if (!nextInput.length) {
            if (!comparison.acceptedObserved) throw new Error("No new effective input; completed AGY task is not automatically resubmitted");
            const text = "[omp-agy: confirmed steering already delivered; no new ACP prompt sent.]";
            message.content.push({ type: "text", text });
            stream.push({ type: "text_start", contentIndex: 0, partial: message });
            stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
            stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
            controller.counters.providerInvocations++;
            this.ledger.checkpoint(context.messages);
            this.ledger.commitOutput(message);
            stream.push({ type: "done", reason: "stop", message }); stream.end(); return;
          }
          const prompt = encodeMessages(nextInput, controller.capabilities, false);
          await controller.selectThinking(options);
          signal.throwIfAborted();
          this.ledger.checkpoint(context.messages);
          if (dirtyInputs) this.dirtyInputs.delete(options.sessionId);
          controller.begin(prompt); submitted = true; this.deferredInput = [];
        } else if (!boundaryDelivered && boundaryInput.length && !this.expectedTool && results.length === 0) {
          await this.waitBoundarySteering(controller, this.steerBoundary(controller, boundaryInput, options.sessionId), signal);
          signal.throwIfAborted();
        }
      }
      controller.counters.providerInvocations++;
      steeringLoop = this.consumeSteering(controller, attempt, options, invocation.signal);
      let openIndex: number | undefined;
      const closeBlock = () => {
        if (openIndex === undefined) return;
        const block = message.content[openIndex]!;
        if (block.type === "text") stream.push({ type: "text_end", contentIndex: openIndex, content: block.text, partial: message });
        else if (block.type === "thinking") stream.push({ type: "thinking_end", contentIndex: openIndex, content: block.thinking, partial: message });
        openIndex = undefined;
      };
      const emit = (event: ControllerEvent) => {
        if (event.type === "image") {
          closeBlock(); const contentIndex = message.content.length;
          const content = { type: "image" as const, data: event.data, mimeType: event.mimeType };
          message.content.push(content); stream.push({ type: "image_end", contentIndex, content, partial: message }); return;
        }
        const block = openIndex === undefined ? undefined : message.content[openIndex];
        if (block?.type !== event.type) {
          closeBlock(); openIndex = message.content.length;
          message.content.push(event.type === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
          stream.push(event.type === "text" ? { type: "text_start", contentIndex: openIndex, partial: message } : { type: "thinking_start", contentIndex: openIndex, partial: message });
        }
        const current = message.content[openIndex!]!;
        if (current.type === "text") { current.text += event.text; stream.push({ type: "text_delta", contentIndex: openIndex!, delta: event.text, partial: message }); }
        else if (current.type === "thinking") { current.thinking += event.text; stream.push({ type: "thinking_delta", contentIndex: openIndex!, delta: event.text, partial: message }); }
      };
      while (true) {
        const version = controller.version;
        signal.throwIfAborted();
        if (controller.failure) throw controller.failure;
        let event: ControllerEvent | undefined;
        while ((event = controller.shiftEvent())) emit(event);
        if (controller.bridge.pendingCount > 0) {
          // The host cannot execute this MCP request until this provider returns.
          // A sent, unconfirmed live claim cannot safely span that return either.
          if (controller.hasCandidate) controller.guardToolHandoff();
          invocation.abort(); await steeringLoop;
          signal.throwIfAborted();
          if (controller.failure) throw controller.failure;
          const pending = controller.takeNext();
          if (pending) {
            closeBlock();
            const toolCall: ToolCall = { type: "toolCall", id: pending.id, name: pending.name, arguments: pending.arguments };
            const contentIndex = message.content.length; message.content.push(toolCall);
            stream.push({ type: "toolcall_start", contentIndex, partial: message });
            stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(toolCall.arguments), partial: message });
            stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: message });
            this.expectedTool = pending; message.stopReason = "toolUse"; break;
          }
        }
        if (!controller.activeFlights && !controller.hasCandidate && !controller.bridge.pendingCount) {
          invocation.abort(); await steeringLoop;
          signal.throwIfAborted();
          if (controller.failure) throw controller.failure;
          if (controller.events.length) continue;
          closeBlock(); controller.finishTurn();
          if (this.deferredInput.length) {
            const prompt = encodeMessages(this.deferredInput, controller.capabilities, false);
            await controller.selectThinking(options);
            signal.throwIfAborted();
            if (dirtyInputs) this.dirtyInputs.delete(options.sessionId);
            controller.begin(prompt); submitted = true; this.deferredInput = [];
            invocation = new AbortController();
            steeringLoop = this.consumeSteering(controller, attempt, options, invocation.signal);
            continue;
          }
          message.stopReason = controller.stopReason === "max_tokens" ? "length" : "stop"; break;
        }
        await controller.wait(version, signal);
      }
      signal.throwIfAborted();
      if (controller.contextUsage) message.usage.contextTokens = controller.contextUsage.used;
      this.ledger.commitOutput(message);
      if (this.auxiliaryOwner) {
        await controller.stop(new Error("Auxiliary compaction request completed"));
        if (controller.phase === "cleanup_failed") throw controller.failure;
        signal.throwIfAborted();
      }
      debugEvent(this.debug, "omp.provider.output", message, { ompSessionId: options.sessionId, activationGeneration: controller.runner?.evidence.generation, acpSessionId: controller.sessionId });
      stream.push({ type: "done", reason: message.stopReason as "stop" | "length" | "toolUse", message }); stream.end();
    } catch (error) {
      if (error instanceof ActivationCleanupError) this.cleanupBlocked = error;
      invocation.abort();
      if (signal.aborted) message.stopReason = "aborted";
      if (steeringLoop) await steeringLoop.catch(() => {});
      if (!(error instanceof ContextLimitError) && (submitted || this.expectedTool || controller?.phase === "active" || controller?.failure)) this.markDirty(attempt);
      if (controller) {
        await controller.stop(error instanceof Error ? error : new Error(String(error)));
        if (controller.phase === "cleanup_failed") {
          this.cleanupBlocked = controller.failure instanceof ActivationCleanupError ? controller.failure :
            new ActivationCleanupError(controller.cleanup, controller.failure?.message ?? "Unconfirmed activation cleanup");
          throw this.cleanupBlocked;
        }
      }
      throw error;
    } finally {
      this.ledger.discardCapturedSummaries();
      invocation.abort(); signal.removeEventListener("abort", abort); this.busy = false;
      if (this.operation === operation) this.operation = undefined;
      done.resolve();
      if (this.auxiliaryOwner) {
        if (this.cleanupBlocked) this.auxiliaryOwner.cleanupBlocked ??= this.cleanupBlocked;
        else if (this.controller?.phase === "cleanup_failed") this.auxiliaryOwner.cleanupBlocked ??=
          this.controller.failure instanceof ActivationCleanupError ? this.controller.failure :
            new ActivationCleanupError(this.controller.cleanup, this.controller.failure?.message ?? "Auxiliary cleanup was not confirmed");
        this.auxiliaryOwner.auxiliaries.delete(this);
      }
    }
  }

  private async steerBoundary(controller: SessionController, messages: readonly (UserMessage | DeveloperMessage)[], sessionId: string | undefined): Promise<void> {
    await controller.steer(encodeMessages(messages, controller.capabilities, false), {
      onUncertain: error => this.quarantineSteering(sessionId, messages, error),
    });
  }

  private async waitBoundarySteering(controller: SessionController, receipt: Promise<void>, signal: AbortSignal): Promise<void> {
    // Observe rejection even when cancellation or failure ends this wait first.
    void receipt.catch(() => {});
    while (controller.hasCandidate) {
      const version = controller.version;
      signal.throwIfAborted();
      if (controller.failure) throw controller.failure;
      // A new MCP request cannot execute until this provider returns. Apply the
      // same UNKNOWN guard as the main stream loop instead of waiting on itself.
      if (controller.bridge.pendingCount > 0) controller.guardToolHandoff();
      if (!controller.hasCandidate) break;
      await controller.wait(version, signal);
    }
    await receipt;
  }

  private validateContextWindow(controller: SessionController, model: Model<Api>): void {
    const version = controller.runner.evidence.version;
    const budget = resolveContextWindow(version, model.id, this.config.contextWindow);
    if (typeof model.contextWindow !== "number") throw new ContextLimitError("Selected AGY model has no numeric contextWindow. Refresh /agy-discover for this configuration; no prompt was submitted.");
    const selected = model.contextWindow;
    if (!Number.isSafeInteger(selected) || selected <= 0) throw new ContextLimitError("Selected AGY model contextWindow must be a positive safe integer; no prompt was submitted.");
    if (selected > budget) throw new ContextLimitError(`Selected AGY model contextWindow ${selected} exceeds this runtime's context budget ${budget}. Refresh /agy-discover for this configuration; no prompt was submitted.`);
    if (!controller.models.some(row => row.id === model.id)) throw new ContextLimitError("Selected AGY model is not advertised by this live ACP configuration. Refresh /agy-discover and choose a live model; no prompt was submitted.");
    const limit = contextLimitFor(version, model.id);
    if (!limit) this.diagnostic(`AGY context capacity unknown for ${JSON.stringify(model.id.slice(0, 128))} (CLI ${JSON.stringify(version.slice(0, 128))}); using local budget ${budget}, not a verified native ceiling.`);
    else if (this.config.contextWindow !== undefined && budget < this.config.contextWindow) this.diagnostic(`AGY requested context budget ${this.config.contextWindow} clamped to known ceiling ${budget} for ${JSON.stringify(model.id.slice(0, 128))}.`);
  }

  private async consumeSteering(controller: SessionController, attempt: InputAttempt, options: SimpleStreamOptions, signal: AbortSignal): Promise<void> {
    const channel = options.liveSteering;
    if (!channel) return;
    const epoch = this.epoch;
    while (!signal.aborted && controller.phase === "active" && controller.activeFlights) {
      // Tool/ask-stage input belongs to the host's next boundary, not a native
      // prompt whose receipt may depend on the parked original MCP response.
      if (this.expectedTool || controller.bridge.pendingCount) { controller.counters.steeringDeferred++; return; }
      let claim: LiveSteerClaim | undefined;
      let handedOff = false;
      try {
        await channel.wait(signal);
        if (signal.aborted || controller.failure) return;
        if (this.expectedTool || controller.bridge.pendingCount) { controller.counters.steeringDeferred++; return; }
        claim = await channel.claim(signal);
        if (!claim) { controller.counters.steeringDeferred++; return; }
        if (claim.messages.some(message => this.isQuarantined(options.sessionId, message))) {
          // Leave unknown originals unresolved: reject would request a retry and
          // accept would falsely acknowledge delivery. Host cleanup is explicit.
          handedOff = true;
          this.diagnostic("Blocked a restored unknown-receipt steering claim before AGY send. Clear its pending OMP entry manually; delivery remains unknown.");
          return;
        }
        if (signal.aborted || !controller.activeFlights || this.expectedTool || controller.bridge.pendingCount) {
          claim.reject(); controller.counters.steeringDeferred++; return;
        }
        const submittedClaim = claim;
        const { messages } = submittedClaim;
        let text: string;
        try { text = steeringText(messages); }
        catch (error) {
          claim.reject(); controller.counters.steeringDeferred++;
          this.diagnostic(error instanceof Error ? error.message : String(error)); return;
        }
        handedOff = true;
        await controller.steer([{ type: "text", text }], {
          onReceived: () => {
            // This receipt belongs to the attempt that sent it, including
            // during teardown; it cannot extend a later attempt's fence.
            const ownsInput = this.controller === controller && this.inputOwner === attempt;
            const current = ownsInput && epoch === this.epoch;
            if (current || (ownsInput && this.stopBarrier)) {
              attempt.currentInput.push(...this.ledger.explicitInputKeys(messages));
              attempt.inputs.add(canonical(attempt.currentInput));
              if (!current || controller.phase === "stopping" || controller.failure) this.markDirty(attempt);
            }
            submittedClaim.accept();
            if (current) this.ledger.acceptSteering(messages);
          },
          onUnsent: () => submittedClaim.reject(),
          onUncertain: error => this.quarantineSteering(attempt.sessionId, messages, error),
        });
      } catch (error) {
        if (claim && !handedOff) claim.reject();
        if (controller.failure) return;
        if (!signal.aborted) { await controller.fail(error instanceof Error ? error : new Error(String(error))); return; }
      }
    }
  }
}
