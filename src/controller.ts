import * as acp from "@agentclientprotocol/sdk";
import { createBridge, type Bridge, type PendingCall } from "./bridge.ts";
import type { ToolDefinition } from "./catalog.ts";
import { bootstrapRunner, DEFAULT_RUNNER_CONFIG, validateHostSystemPrompt, type PreparedRunner, type RunningRunner, type CleanupReport, type RunnerFactory } from "./runner.ts";
import { discoveryConfig, ThinkingSelectionError, type SessionConfig, type SteeringReceipt, type ThoughtOptions } from "./protocol.ts";
import type { TrustedResult } from "./results.ts";
import { debugEvent, type DebugContext, type DebugObserver } from "./debug.ts";

export interface AdvertisedModel { id: string; name: string; thinking?: ThoughtOptions }
export interface ModelDiscovery { models: AdvertisedModel[]; images: boolean; evidence: Record<string, unknown> }
export type ControllerEvent = { type: "text" | "thinking"; text: string } | { type: "image"; data: string; mimeType: string };
export interface ReportedTool { server?: string; name?: string; conflict: boolean; closed: boolean }
interface Candidate {
  text: string;
  echo: string;
  echoMismatch: boolean;
  deadlineAt: number;
  receipt?: SteeringReceipt;
  settled: boolean;
  acknowledged: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
  cancelDeadline?: () => void;
}
export interface ControllerCallbacks {
  debug?: DebugObserver;
  debugContext?: () => DebugContext;
  diagnostic?: (message: string) => void;
  failed?: (error: Error) => void;
  /** Opt in only for a dedicated, no-tool model discovery activation. */
  observeModelWindows?: boolean;
}
export class ActivationCleanupError extends Error {
  constructor(readonly report: CleanupReport | undefined, reason: string) { super(`cleanup_failed: ${reason}`); }
}
const errorOf = (error: unknown): Error => error instanceof Error ? error : new Error(String(error));
const metadataText = (meta: Record<string, unknown> | null | undefined, keys: string[]): string | undefined => {
  for (const key of keys) if (typeof meta?.[key] === "string" && meta[key]) return meta[key] as string;
};

const WINDOW_DISCOVERY_MS = 3_000;
const WINDOW_STEP_MS = 200;
const WINDOW_SETTLE_MS = 30;
interface WindowObservation {
  model: string;
  configId: string;
  fromSize?: number;
  expectedSize?: number;
  configSeen?: boolean;
  size?: number;
  settleAt?: number;
  invalid?: boolean;
}
function windowModelSelector(options: acp.SessionConfigOption[]) {
  let selector: Extract<acp.SessionConfigOption, { type: "select" }> | undefined;
  for (const option of options) {
    if (option.category !== "model" && option.id !== "model") continue;
    if (selector || option.type !== "select") return undefined;
    selector = option;
  }
  return selector;
}
function confirmsWindowModel(options: acp.SessionConfigOption[], observation: WindowObservation): boolean {
  const selector = windowModelSelector(options);
  return selector?.id === observation.configId && selector.currentValue === observation.model;
}

/** Merge only structured identities; human-readable titles and raw arguments never authorize. */
export function mergeToolReport(previous: ReportedTool | undefined, tool: acp.ToolCallUpdate, publishedNames: ReadonlyMap<string, string>): ReportedTool {
  const report = { ...(previous ?? { conflict: false, closed: false }) };
  const alias = tool.name ? publishedNames.get(tool.name) : undefined;
  if (tool.name && !alias) report.conflict = true;
  const identities = [
    ["server", metadataText(tool._meta, ["mcpServerName", "serverName", "server"])],
    ["name", metadataText(tool._meta, ["mcpToolName", "toolName", "tool"])],
    ["server", alias ? "omp_agy_bridge" : undefined], ["name", alias],
  ] as const;
  for (const [key, value] of identities) {
    if (!value) continue;
    if (report[key] && report[key] !== value) report.conflict = true;
    else report[key] = value;
  }
  if (tool.status === "completed" || tool.status === "failed") report.closed = true;
  return report;
}

/** Permission grants only allow the request to reach the caller's bridge execution policy. */
export function permissionOutcome(request: acp.RequestPermissionRequest, state: {
  sessionId: string; active: boolean; report?: ReportedTool; registered: boolean;
}): acp.RequestPermissionResponse {
  const report = state.report;
  const server = metadataText(request.toolCall._meta, ["mcpServerName", "serverName", "server"]);
  const name = metadataText(request.toolCall._meta, ["mcpToolName", "toolName", "tool"]);
  const allowed = state.active && request.sessionId === state.sessionId && !!report && !report.closed && !report.conflict &&
    report.server === "omp_agy_bridge" && !!report.name && state.registered &&
    (!server || server === report.server) && (!name || name === report.name) &&
    (!request.toolCall.name || request.toolCall.name === `mcp_omp_agy_bridge_${report.name}`) &&
    request.toolCall.status !== "completed" && request.toolCall.status !== "failed";
  const option = request.options.find(option => option.kind === (allowed ? "allow_once" : "reject_once"));
  return { outcome: option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } };
}

/** One controller owns one CLI, one ACP session and one notification consumer. */
export class SessionController {
  readonly events: ControllerEvent[] = [];
  readonly reports = new Map<string, ReportedTool>();
  readonly counters = { providerInvocations: 0, ignoredCommandUpdates: 0, steeringAccepted: 0, steeringDeferred: 0, steeringUncertain: 0, peakPending: 0 };
  bridge!: Bridge;
  runner!: RunningRunner;
  sessionId = "";
  models: AdvertisedModel[] = [];
  selectedModel?: string;
  capabilities: acp.PromptCapabilities = {};
  contextUsage?: { used: number; size: number; cost?: acp.Cost | null };
  cleanup?: CleanupReport;
  phase: "starting" | "idle" | "active" | "stopping" | "stopped" | "cleanup_failed" = "starting";
  failure?: Error;
  private connection?: acp.ClientConnection;
  private configOptions: acp.SessionConfigOption[] = [];
  private thoughtOptions?: ThoughtOptions;
  private thoughtError?: ThinkingSelectionError;
  private selectingConfig = false;
  private readonly observedWindows = new Map<string, number>();
  private windowObservation?: WindowObservation;
  private earlyWindowUpdates?: acp.SessionNotification[] | null;
  private windowDiscovery = false;
  private discoverySignal?: AbortSignal;
  private generatedModel?: string;
  private flights = new Map<number, Promise<void>>();
  private flightSequence = 0;
  private lastResult?: acp.PromptResponse;
  private candidate?: Candidate;
  private queueBytes = 0;
  private revision = 0;
  private waiters = new Set<() => void>();
  private stopPromise?: Promise<void>;
  private setupAbort = new AbortController();
  private prepared?: PreparedRunner;
  private permissionDiagnostics = 0;
  private publishedNames = new Map<string, string>();

  private constructor(readonly config: SessionConfig, readonly callbacks: ControllerCallbacks) {}

  static async open(config: SessionConfig, tools: readonly ToolDefinition[], callbacks: ControllerCallbacks = {}, signal?: AbortSignal, hostSystemPrompt?: string, bootstrap: RunnerFactory = bootstrapRunner): Promise<SessionController> {
    const controller = new SessionController(config, callbacks);
    try {
      signal?.throwIfAborted();
      validateHostSystemPrompt(config.profile, hostSystemPrompt);
      // Abort a pending bootstrap, but don't let its signal stop a running producer
      // behind the controller's back: cleanup must revoke the bridge first.
      const bootstrapAbort = signal ? new AbortController() : undefined;
      const abortBootstrap = () => bootstrapAbort?.abort(signal?.reason);
      signal?.addEventListener("abort", abortBootstrap, { once: true });
      try { controller.prepared = await bootstrap(config.runner, bootstrapAbort?.signal); }
      finally { signal?.removeEventListener("abort", abortBootstrap); }
      signal?.throwIfAborted();
      controller.bridge = await createBridge({
        hostname: controller.prepared.gateway, sourceAddress: controller.prepared.sourceAddress, tools,
        debug: callbacks.debug, debugContext: () => ({ ...callbacks.debugContext?.(), activationGeneration: controller.runner?.evidence.generation ?? controller.prepared?.evidence.generation, ...(controller.sessionId ? { acpSessionId: controller.sessionId } : {}) }),
        onActivity: () => { controller.counters.peakPending = Math.max(controller.counters.peakPending, controller.bridge?.pendingCount ?? 0); controller.wake(); }, onFatal: error => { void controller.fail(error); },
      });
      signal?.throwIfAborted();
      for (const alias of controller.bridge.aliases) controller.publishedNames.set(`mcp_omp_agy_bridge_${alias}`, alias);
      controller.runner = await controller.prepared.start({ url: controller.bridge.url, token: controller.bridge.token,
        aliases: controller.bridge.aliases, profile: config.profile, instructions: config.instructions,
        ...(hostSystemPrompt !== undefined ? { hostSystemPrompt, originalToolNames: controller.bridge.catalog.aliasToOriginal } : {}) });
      signal?.throwIfAborted();
      void controller.runner.exited.then(code => {
        if (controller.phase !== "stopping" && controller.phase !== "stopped" && controller.phase !== "cleanup_failed") void controller.fail(new Error(`AGY supervisor exited (${code}); no automatic replay`));
      });
      const app = acp.client({ name: "omp-agy" })
        .onNotification(acp.methods.client.session.update, ({ params }) => controller.update(params))
        .onRequest(acp.methods.client.session.requestPermission, ({ params }) => controller.permission(params));
      const stream = acp.ndJsonStream(controller.runner.stdin, controller.runner.stdout, { maxMessageBytes: 8 * 1024 * 1024 });
      const observe = (direction: "in" | "out", message: unknown) => {
        // Observe the SDK's real JSON-RPC envelopes, not guessed request counters.
        // The callback remains inert when debug is disabled, including context lookup.
        debugEvent(callbacks.debug, `acp.${direction}`, message, () => {
          const envelope = message as { id?: string | number; result?: { sessionId?: string }; params?: { sessionId?: string; update?: { toolCallId?: string }; toolCall?: { toolCallId?: string } } };
          return {
            ...callbacks.debugContext?.(),
            activationGeneration: controller.runner?.evidence.generation ?? controller.prepared?.evidence.generation,
            ...(envelope.params?.sessionId || envelope.result?.sessionId || controller.sessionId ? { acpSessionId: envelope.params?.sessionId ?? envelope.result?.sessionId ?? controller.sessionId } : {}),
            ...(envelope.id !== undefined ? { requestId: envelope.id } : {}),
            ...(envelope.params?.update?.toolCallId || envelope.params?.toolCall?.toolCallId ? { toolCallId: envelope.params?.update?.toolCallId ?? envelope.params?.toolCall?.toolCallId } : {}),
          };
        });
      };
      const writer = stream.writable.getWriter();
      controller.connection = app.connect({
        readable: stream.readable.pipeThrough(new TransformStream({ transform(message, output) { observe("in", message); output.enqueue(message); } })),
        writable: new WritableStream({
          async write(message) { await writer.write(message); observe("out", message); },
          async close() { try { await writer.close(); } finally { writer.releaseLock(); } },
          async abort(reason) { try { await writer.abort(reason); } finally { writer.releaseLock(); } },
        }),
      });
      void controller.connection.closed.then(() => {
        if (controller.phase !== "stopping" && controller.phase !== "stopped" && controller.phase !== "cleanup_failed") void controller.fail(new Error("ACP connection closed unexpectedly; no automatic replay"));
      });
      const initialized = await controller.setupRequest(() => controller.connection!.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION, clientInfo: { name: "omp-agy", title: "Antigravity ACP bridge", version: "0.1.0" },
        clientCapabilities: {},
      }), signal);
      if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) throw new Error(`Unsupported ACP protocol version ${initialized.protocolVersion}`);
      if (!initialized.agentCapabilities?.mcpCapabilities?.http) throw new Error("ACP agent does not advertise HTTP MCP support");
      controller.capabilities = initialized.agentCapabilities?.promptCapabilities ?? {};
      const append = config.profile === "default-agy" ? controller.runner.appendInstructions : undefined;
      if (append) {
        const meta = initialized.agentCapabilities?._meta?.antigravity as { systemPrompt?: { append?: boolean } } | undefined;
        if (!meta?.systemPrompt?.append) throw new Error("default-agy explicit instructions require the advertised antigravity.systemPrompt.append capability");
      }
      const observeWindows = !!callbacks.observeModelWindows && !tools.length && hostSystemPrompt === undefined;
      if (observeWindows) controller.earlyWindowUpdates = [];
      const session = await controller.setupRequest(() => controller.connection!.agent.request(acp.methods.agent.session.new, {
        cwd: controller.prepared!.workspace, mcpServers: [],
        ...(append ? { _meta: { antigravity: { systemPrompt: { append } } } } : {}),
      }), signal);
      controller.sessionId = session.sessionId;
      controller.configOptions = session.configOptions ?? [];
      controller.refreshModels();
      if (observeWindows) {
        controller.windowDiscovery = true;
        controller.discoverySignal = signal;
        const selector = windowModelSelector(controller.configOptions);
        if (selector && controller.earlyWindowUpdates) {
          controller.windowObservation = { model: selector.currentValue, configId: selector.id };
          for (const notification of controller.earlyWindowUpdates) controller.observeWindowUpdate(notification);
        }
        controller.earlyWindowUpdates = undefined;
      }
      if (!controller.models.length) throw new Error("Live ACP session advertised no permitted model choices; no fallback model was invented");
      await controller.waitForBridgeReady(signal);
      signal?.throwIfAborted();
      controller.setupAbort.signal.throwIfAborted();
      controller.phase = "idle";
      return controller;
    } catch (error) {
      await controller.stop(errorOf(error));
      if (controller.phase === "cleanup_failed") throw new ActivationCleanupError(controller.cleanup, controller.failure?.message ?? "unconfirmed activation cleanup");
      throw error;
    }
  }

  private async waitForBridgeReady(signal?: AbortSignal): Promise<void> {
    const notReady = "Private MCP bridge is not ready: authenticated initialization and tools/list are required before session admission";
    await this.setupRequest(async signal => {
      for (;;) {
        // Capture revision before inspecting readiness so an activity signal between
        // the snapshot and wait registration cannot be lost.
        const previous = this.version;
        signal.throwIfAborted();
        if (this.failure) throw this.failure;
        const bridge = this.bridge.snapshot();
        if (!bridge.accepting || bridge.revoked) throw new Error(notReady);
        if (bridge.initialized && bridge.catalogReadCount > 0) return;
        await this.wait(previous, signal);
      }
    }, signal, `${notReady}; ACP setup timed out; activation must be stopped`);
  }

  private async setupRequest<T>(request: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal,
    timeoutMessage = "ACP setup timed out; activation must be stopped"): Promise<T> {
    const deadline = new AbortController();
    const interrupted = Promise.withResolvers<never>();
    const combined = AbortSignal.any([deadline.signal, this.setupAbort.signal, ...(signal ? [signal] : [])]);
    const abort = () => interrupted.reject(errorOf(combined.reason));
    const timer = setTimeout(() => deadline.abort(new Error(timeoutMessage)), this.config.runner?.startupTimeoutMs ?? DEFAULT_RUNNER_CONFIG.startupTimeoutMs);
    combined.addEventListener("abort", abort, { once: true });
    try {
      combined.throwIfAborted();
      return await Promise.race([request(combined), interrupted.promise]);
    } finally {
      clearTimeout(timer);
      combined.removeEventListener("abort", abort);
      // Also detach a pending controller.wait when the deadline/owner wins the race.
      deadline.abort();
    }
  }

  private modelSelector(): Extract<acp.SessionConfigOption, { type: "select" }> | undefined {
    const option = this.configOptions.find(option => option.category === "model" || option.id === "model");
    return option?.type === "select" ? option : undefined;
  }
  private refreshModels(): void {
    const selector = this.modelSelector();
    const options = selector?.options.flatMap(option => "options" in option ? option.options : [option]) ?? [];
    this.models = options.filter(option => !this.config.allowedModels || this.config.allowedModels.includes(option.value))
      .map(option => ({ id: option.value, name: option.name }));
    if (this.selectedModel !== selector?.currentValue) {
      this.contextUsage = undefined;
      this.generatedModel = undefined;
    }
    this.selectedModel = selector?.currentValue;
    this.thoughtOptions = undefined;
    this.thoughtError = undefined;
    for (const option of this.configOptions) {
      if (option.category !== "thought_level" && option.id !== "thought_level") continue;
      if (this.thoughtOptions || this.thoughtError || option.type !== "select") {
        this.thoughtError = new ThinkingSelectionError("ACP thought selector is ambiguous or is not a select option");
        this.thoughtOptions = undefined;
        continue;
      }
      const options = option.options.flatMap(entry => "options" in entry ? entry.options : [entry])
        .map(entry => ({ value: entry.value, name: entry.name }));
      const values = new Set<string>();
      for (const entry of options) {
        if (values.has(entry.value)) this.thoughtError = new ThinkingSelectionError(`ACP thought selector '${option.id}' advertises duplicate value '${entry.value}'`);
        values.add(entry.value);
      }
      this.thoughtOptions = { configId: option.id, currentValue: option.currentValue, options };
    }
  }
  async selectModel(id: string): Promise<void> {
    if (this.phase !== "idle") throw new Error("ACP model selection requires an idle activation");
    if (this.selectingConfig) throw new Error("ACP configuration selection is already in progress");
    this.windowObservation = undefined; // A caller selection ends the untouched startup baseline.
    this.selectingConfig = true;
    try { await this.selectModelOption(id); }
    finally { this.selectingConfig = false; }
  }

  private async selectModelOption(id: string, signal?: AbortSignal, force = false, observation?: WindowObservation): Promise<void> {
    signal?.throwIfAborted();
    if (this.phase !== "idle") throw new Error("ACP model selection requires an idle activation");
    if (!this.models.some(model => model.id === id)) throw new Error(`Model '${id}' is not advertised by this live ACP session`);
    const selector = this.modelSelector();
    if (!selector || !this.connection) throw new Error("ACP model selector unavailable");
    if (!force && selector.currentValue === id) return;
    if (!observation) {
      this.contextUsage = undefined;
      this.generatedModel = undefined;
      this.wake();
    }
    const response = await this.setupRequest(combined => this.connection!.agent.request(acp.methods.agent.session.setConfigOption, {
      sessionId: this.sessionId, configId: selector.id, value: id,
    }, signal ? { cancellationSignal: combined, stopWaitingOnCancel: true } : undefined), signal);
    signal?.throwIfAborted();
    this.setupAbort.signal.throwIfAborted();
    if (observation && !confirmsWindowModel(response.configOptions, observation)) throw new Error("ACP window transition was not confirmed");
    this.configOptions = response.configOptions;
    this.refreshModels();
    if (this.selectedModel !== id || !this.models.some(model => model.id === id)) throw new Error(`ACP did not confirm model '${id}'; no fallback was selected`);
  }

  get thinking(): ThoughtOptions | undefined {
    if (this.thoughtError) throw this.thoughtError;
    return this.thoughtOptions;
  }

  /** Exact empirical empty-session windows, not backend limits or generated usage. */
  get modelContextWindows(): ReadonlyMap<string, number> { return this.observedWindows; }

  async discoverModelOptions(): Promise<AdvertisedModel[]> {
    if (this.phase !== "idle") throw new Error("ACP model discovery requires an idle activation");
    if (this.selectingConfig) throw new Error("ACP configuration selection is already in progress");
    // Model selection replaces the live list; iterate only the initially permitted inventory.
    const models = this.models.map(model => ({ id: model.id, name: model.name }));
    const signal = this.discoverySignal;
    this.discoverySignal = undefined;
    this.selectingConfig = true;
    try {
      signal?.throwIfAborted();
      const windowsSettled = !this.windowObservation || await this.discoverWindows(models, this.windowObservation, signal);
      const discovered: AdvertisedModel[] = [];
      for (const model of models) {
        // If a probe failed, never trust a config snapshot that might still describe a late transition.
        await this.selectModelOption(model.id, signal, !windowsSettled);
        const thought = this.thinking;
        discovered.push({ ...model, ...(thought ? { thinking: thought } : {}) });
      }
      signal?.throwIfAborted();
      this.setupAbort.signal.throwIfAborted();
      return discovered;
    } finally { this.windowObservation = undefined; this.selectingConfig = false; }
  }

  private async discoverWindows(models: AdvertisedModel[], initial: WindowObservation, owner?: AbortSignal): Promise<boolean> {
    const signal = AbortSignal.any([this.setupAbort.signal, ...(owner ? [owner] : [])]);
    const deadline = performance.now() + WINDOW_DISCOVERY_MS;
    let attemptedSwitch = false;
    try {
      const ids = [...new Set(models.map(model => model.id))];
      const alternate = ids.at(-1) === initial.model ? ids.at(-2) : ids.at(-1);
      if (ids.length < 2 || alternate === undefined || initial.invalid) return true;
      let current = { id: initial.model, size: await this.observeWindowStep(initial, deadline, signal) };
      const move = async (id: string, expectedSize?: number) => {
        if (this.windowObservation?.invalid || this.selectedModel !== current.id || this.modelSelector()?.id !== initial.configId || id === current.id) {
          throw new Error("ACP lost its observed window baseline");
        }
        attemptedSwitch = true;
        const observation = { model: id, configId: initial.configId, fromSize: current.size, expectedSize };
        current = { id, size: await this.observeWindowStep(observation, deadline, signal) };
        return current;
      };

      // The unswitched default is a starting measurement even if it is excluded by policy.
      // Never switch back to it unless it is in the permitted inventory.
      let anchor = current;
      let other = await move(alternate);
      if (!ids.includes(anchor.id)) {
        anchor = other;
        other = await move(ids.find(id => id !== anchor.id)!);
      }
      await move(anchor.id, anchor.size);
      await move(other.id, other.size);
      this.observedWindows.set(other.id, other.size);
      await move(anchor.id, anchor.size);
      this.observedWindows.set(anchor.id, anchor.size);

      // Use the smaller measured anchor for unknown targets. Silence is not a measurement,
      // so a failed transition ends this pass rather than risking attribution on another one.
      const baseline = anchor.size < other.size ? anchor : other;
      for (const id of ids) {
        if (this.observedWindows.has(id)) continue;
        if (current.id !== baseline.id) await move(baseline.id, baseline.size);
        const first = await move(id);
        await move(baseline.id, baseline.size);
        await move(id, first.size);
        this.observedWindows.set(id, first.size);
      }
      return true;
    } catch {
      signal.throwIfAborted();
      return !attemptedSwitch;
    } finally { this.windowObservation = undefined; }
  }

  private async observeWindowStep(observation: WindowObservation, deadline: number, signal: AbortSignal): Promise<number> {
    const timeout = Math.min(deadline, performance.now() + WINDOW_STEP_MS);
    const cutoff = new AbortController();
    const step = AbortSignal.any([signal, cutoff.signal]);
    const advance = () => cutoff.abort(new Error("ACP window observation timed out"));
    this.windowObservation = observation;
    if (performance.now() >= timeout) advance();
    const timer = setTimeout(advance, Math.max(0, Math.ceil(timeout - performance.now())));
    try {
      step.throwIfAborted();
      if (observation.fromSize !== undefined) {
        await this.selectModelOption(observation.model, step, true, observation);
        // A notification received before the response still needs the exact RPC confirmation.
        if (observation.size !== undefined) observation.settleAt = performance.now() + WINDOW_SETTLE_MS;
      }
      for (;;) {
        const previous = this.version;
        if (performance.now() >= timeout) advance();
        step.throwIfAborted();
        if (observation.invalid) throw new Error("ACP window evidence is ambiguous");
        if (observation.size === undefined) { await this.wait(previous, step); continue; }
        const remaining = observation.settleAt! - performance.now();
        if (remaining <= 0) return observation.size;
        // Keep the same observation open briefly to catch contradictions before sending another switch.
        const quiet = new AbortController();
        const settleTimer = setTimeout(() => quiet.abort(), Math.ceil(remaining));
        try { await this.wait(previous, AbortSignal.any([step, quiet.signal])); }
        finally { clearTimeout(settleTimer); }
      }
    } finally { clearTimeout(timer); }
  }

  private observeWindowUpdate({ sessionId, update }: acp.SessionNotification): void {
    const observation = this.windowObservation;
    if (!observation || observation.invalid) return;
    if (sessionId !== this.sessionId) observation.invalid = true;
    else if (update.sessionUpdate === "config_option_update") {
      if (!confirmsWindowModel(update.configOptions, observation)) observation.invalid = true;
      else observation.configSeen = true;
    } else if (update.sessionUpdate === "usage_update") {
      if (update.used !== 0 || !Number.isSafeInteger(update.size) || update.size <= 0 ||
          (observation.fromSize !== undefined && (!observation.configSeen || update.size === observation.fromSize || observation.size !== undefined)) ||
          (observation.size !== undefined && update.size !== observation.size) ||
          (observation.expectedSize !== undefined && update.size !== observation.expectedSize)) observation.invalid = true;
      else {
        observation.size = update.size;
        observation.settleAt = performance.now() + WINDOW_SETTLE_MS;
      }
    }
    this.wake();
  }

  async selectThinking(options: { reasoning?: string; disableReasoning?: boolean }): Promise<void> {
    try {
      if (this.phase !== "idle") throw new ThinkingSelectionError("ACP thinking selection requires an idle activation");
      if (this.selectingConfig) throw new ThinkingSelectionError("ACP configuration selection is already in progress");
      const value = options.disableReasoning ? "off" : options.reasoning;
      if (value === undefined) return; // No explicit request: preserve the live agent's choice.
      const thought = this.thinking;
      if (!thought || !this.connection) throw new ThinkingSelectionError(`ACP thought selector unavailable; cannot select '${value}'`);
      if (!thought.options.some(option => option.value === value)) throw new ThinkingSelectionError(`Thought level '${value}' is not advertised by this live ACP model`);
      const model = this.selectedModel;
      if (!model || !this.models.some(option => option.id === model)) throw new ThinkingSelectionError("ACP model is not confirmed for thinking selection");
      if (thought.currentValue === value) return;
      this.windowObservation = undefined;
      this.selectingConfig = true;
      try {
        const response = await this.setupRequest(() => this.connection!.agent.request(acp.methods.agent.session.setConfigOption, {
          sessionId: this.sessionId, configId: thought.configId, value,
        }));
        this.configOptions = response.configOptions;
        this.refreshModels();
        const confirmed = this.thinking;
        if (this.selectedModel !== model || !this.models.some(option => option.id === model)) throw new ThinkingSelectionError(`ACP did not preserve model '${model}' during thinking selection`);
        if (!confirmed || confirmed.configId !== thought.configId || confirmed.currentValue !== value || !confirmed.options.some(option => option.value === value)) {
          throw new ThinkingSelectionError(`ACP did not confirm thought level '${value}'; no fallback was selected`);
        }
      } finally { this.selectingConfig = false; }
    } catch (error) {
      if (error instanceof ThinkingSelectionError) throw error;
      throw new ThinkingSelectionError(errorOf(error).message, { cause: error });
    }
  }

  get version(): number { return this.revision; }
  get activeFlights(): number { return this.flights.size; }
  get hasCandidate(): boolean { return this.candidate !== undefined; }
  get stopReason(): acp.StopReason | undefined { return this.lastResult?.stopReason; }
  wake(): void { this.revision++; for (const wake of this.waiters) wake(); this.waiters.clear(); }
  async wait(previous: number, signal?: AbortSignal): Promise<void> {
    if (previous !== this.revision || signal?.aborted) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    const done = () => { this.waiters.delete(done); signal?.removeEventListener("abort", done); resolve(); };
    this.waiters.add(done); signal?.addEventListener("abort", done, { once: true });
    if (previous !== this.revision || signal?.aborted) done();
    await promise;
  }
  shiftEvent(): ControllerEvent | undefined {
    const event = this.events.shift();
    if (event) this.queueBytes -= event.type === "image" ? event.data.length : event.text.length;
    return event;
  }
  private enqueue(event: ControllerEvent): void {
    this.queueBytes += event.type === "image" ? event.data.length : event.text.length;
    if (this.queueBytes > 8 * 1024 * 1024 || this.events.length >= 8192) { void this.fail(new Error("ACP output queue exceeded resource limit during host handoff")); return; }
    this.events.push(event); this.wake();
  }

  begin(prompt: acp.ContentBlock[]): void {
    if (this.phase !== "idle") throw new Error(`Cannot start ACP turn while ${this.phase}`);
    if (this.selectingConfig) throw new Error("Cannot start ACP turn before configuration selection is confirmed");
    this.windowObservation = undefined;
    this.windowDiscovery = false;
    this.discoverySignal = undefined;
    this.generatedModel = this.selectedModel;
    this.bridge.beginTurn(); this.phase = "active"; this.reports.clear();
    try { this.launch(prompt); }
    catch (error) { void this.fail(errorOf(error)); throw error; }
  }
  private launch(prompt: acp.ContentBlock[], candidate?: Candidate): void {
    if (!this.connection || this.phase !== "active") throw new Error("ACP activation is not active");
    // No invocation signal or per-flight timeout: session cancellation belongs to stop().
    const request = this.connection.agent.request(acp.methods.agent.session.prompt, { sessionId: this.sessionId, prompt });
    const sequence = ++this.flightSequence;
    this.lastResult = undefined;
    const flight = request
      .then(response => {
        if (this.phase !== "active") return;
        // Only the latest submitted prompt owns the turn outcome, even when it
        // cancelled and an obsolete owner returned success.
        if (sequence === this.flightSequence) this.lastResult = response;
        if (candidate && response.stopReason !== "cancelled") this.acknowledge(candidate);
        else if (candidate && !candidate.acknowledged) this.uncertain(candidate, new Error("Native steering prompt was cancelled before receipt could be confirmed"));
      }, error => {
        if (this.phase !== "active") return;
        if (candidate && !candidate.acknowledged) this.uncertain(candidate, errorOf(error));
        else if ((!candidate || candidate.acknowledged) && sequence < this.flightSequence && error instanceof acp.RequestError && error.code === -32800) {
          // A native takeover may finish the owner flight; the replacement flight owns the result.
          this.callbacks.diagnostic?.("ACP owner prompt ended during native steering; waiting for the same-session replacement flight.");
        } else void this.fail(errorOf(error));
      }).finally(() => { this.flights.delete(sequence); this.wake(); });
    this.flights.set(sequence, flight); this.wake();
  }

  /** Submit a prepared replacement to the current ACP turn and wait for receipt. */
  async steer(prompt: acp.ContentBlock[], receipt?: SteeringReceipt): Promise<void> {
    if (this.candidate) { receipt?.onUnsent?.(); throw new Error("Only one native steering candidate is permitted"); }
    if (this.phase !== "active" || !this.flights.size || this.lastResult?.stopReason === "cancelled") {
      receipt?.onUnsent?.(); throw new Error("ACP turn already ended; input must be submitted as the next turn");
    }
    const text = prompt.filter(block => block.type === "text").map(block => block.text).join("");
    if (!prompt.length || (!text && prompt.every(block => block.type === "text"))) {
      receipt?.onUnsent?.(); throw new Error("Empty native steering candidate is not submitted");
    }
    // Only a text-only prompt can be confirmed by a text echo. Mixed media
    // requires a response; a text echo cannot prove its attachments arrived.
    const echoMismatch = prompt.some(block => block.type !== "text");
    const window = this.config.steeringConfirmationMs ?? 30_000;
    const { promise: confirmed, resolve, reject } = Promise.withResolvers<void>();
    const candidate: Candidate = { text, echo: "", echoMismatch,
      deadlineAt: performance.now() + window, receipt, resolve, reject, settled: false, acknowledged: false };
    this.candidate = candidate;
    let timer: ReturnType<typeof setTimeout>;
    const checkReceipt = () => {
      if (candidate.settled) return;
      const remaining = candidate.deadlineAt - performance.now();
      if (remaining > 0) timer = setTimeout(checkReceipt, remaining);
      else this.uncertain(candidate, new Error("Native steering receipt is uncertain: no official echo or successful response within the confirmation idle window without official session text/thought progress"));
    };
    timer = setTimeout(checkReceipt, window);
    candidate.cancelDeadline = () => clearTimeout(timer);
    try { this.launch(prompt, candidate); }
    catch (error) {
      candidate.cancelDeadline(); this.candidate = undefined;
      candidate.settled = true;
      receipt?.onUnsent?.();
      throw error;
    }
    return confirmed;
  }
  private acknowledge(candidate: Candidate): void {
    if (candidate.settled) return;
    candidate.settled = true; candidate.acknowledged = true; candidate.cancelDeadline?.();
    this.candidate = undefined;
    this.counters.steeringAccepted++;
    try { candidate.receipt?.onReceived?.(); candidate.resolve(); }
    catch (error) { candidate.reject(errorOf(error)); void this.fail(errorOf(error)); }
    this.wake();
  }
  private uncertain(candidate: Candidate, error: Error): void {
    if (candidate.settled) return;
    candidate.settled = true; candidate.cancelDeadline?.();
    // A sent-unknown receipt is neither delivered nor safe to send again.
    let failure = error;
    try { candidate.receipt?.onUncertain?.(error); }
    catch (recordError) { failure = new Error(`${error.message}. Unknown receipt recording failed: ${errorOf(recordError).message}`); }
    this.counters.steeringUncertain++; candidate.reject(failure);
    this.candidate = undefined; void this.fail(new Error(`${failure.message}. Sent input may have been applied; activation stopped. Input is not confirmed delivered. No automatic AGY replay.`));
  }
  guardToolHandoff(): void {
    const candidate = this.candidate;
    if (candidate && !candidate.settled) this.uncertain(candidate, new Error("Native steering receipt is uncertain at MCP tool handoff: the sent prompt has no official echo or successful response, and awaiting its receipt would block the original MCP result needed to make progress"));
  }

  private update(notification: acp.SessionNotification): void {
    const kind = notification.update.sessionUpdate;
    if (kind === "usage_update" || kind === "config_option_update") {
      if (this.earlyWindowUpdates !== undefined) {
        // Notifications can precede session/new's response. Do not bind a session ID by arrival order.
        if (this.earlyWindowUpdates && this.earlyWindowUpdates.length < 8) this.earlyWindowUpdates.push(notification);
        else this.earlyWindowUpdates = null; // Overflow invalidates the startup observation.
        return;
      }
      this.observeWindowUpdate(notification);
      if (this.windowDiscovery && notification.sessionId !== this.sessionId) return;
      // Use RPC responses as the live config snapshot throughout dedicated discovery, including fallback.
      if (this.windowDiscovery && this.selectingConfig) return;
    }
    if (this.sessionId && notification.sessionId !== this.sessionId) { void this.fail(new Error("ACP session notification identity mismatch")); return; }
    const update = notification.update;
    switch (update.sessionUpdate) {
      case "available_commands_update": this.counters.ignoredCommandUpdates++; return;
      case "usage_update":
        // The generation display is separate from empty-session window observations.
        if (this.selectingConfig || !this.selectedModel || this.generatedModel !== this.selectedModel || (this.phase !== "active" && this.phase !== "idle")) return;
        this.contextUsage = { used: update.used, size: update.size, cost: update.cost }; this.wake(); return;
      case "config_option_update": this.configOptions = update.configOptions; this.refreshModels(); this.wake(); return;
      case "tool_call": case "tool_call_update":
        if (this.phase === "active") this.recordTool(update);
        return;
      case "user_message_chunk": {
        const candidate = this.candidate;
        if (candidate && !candidate.echoMismatch && update.content.type === "text") {
          if (candidate.echo.length + update.content.text.length > candidate.text.length) candidate.echoMismatch = true;
          else {
            candidate.echo += update.content.text;
            if (!candidate.text.startsWith(candidate.echo)) candidate.echoMismatch = true;
            else if (candidate.text && candidate.echo === candidate.text) this.acknowledge(candidate);
          }
        }
        return;
      }
      case "agent_message_chunk": case "agent_thought_chunk": {
        if (this.phase !== "active") return;
        // ACP content updates belong to the session, not a prompt flight. The target
        // may settle the old RPC while its model output is still streaming. Progress
        // extends receipt idleness but never acknowledges delivery of the candidate.
        if (this.candidate && update.content.type === "text" && update.content.text.length) {
          this.candidate.deadlineAt = performance.now() + (this.config.steeringConfirmationMs ?? 30_000);
        }
        if (update.content.type === "text") this.enqueue({ type: update.sessionUpdate === "agent_thought_chunk" ? "thinking" : "text", text: update.content.text });
        else if (update.content.type === "image" && update.sessionUpdate === "agent_message_chunk") this.enqueue({ type: "image", data: update.content.data, mimeType: update.content.mimeType });
        else void this.fail(new Error(`Unsupported ACP output content '${update.content.type}'; content was not silently discarded`));
        return;
      }
      default: return; // Plans/mode/session UI state do not execute host commands or tools.
    }
  }
  private recordTool(tool: acp.ToolCallUpdate): void {
    this.reports.set(tool.toolCallId, mergeToolReport(this.reports.get(tool.toolCallId), tool, this.publishedNames));
  }
  private permission(request: acp.RequestPermissionRequest): acp.RequestPermissionResponse {
    const prior = this.reports.get(request.toolCall.toolCallId);
    if (prior) this.recordTool(request.toolCall);
    const report = this.reports.get(request.toolCall.toolCallId);
    const response = permissionOutcome(request, { sessionId: this.sessionId, active: this.phase === "active", report: prior ? report : undefined,
      registered: !!report?.name && this.bridge.catalog.resolve(report.name) !== undefined });
    const denied = response.outcome.outcome === "cancelled" || !request.options.some(option => option.kind === "allow_once" &&
      response.outcome.outcome === "selected" && option.optionId === response.outcome.optionId);
    if (denied && this.permissionDiagnostics++ < 4) {
      const meta = request.toolCall._meta;
      const metadataShape = Object.fromEntries(Object.keys(meta ?? {}).slice(0, 16).map(key => {
        const value = meta![key];
        return [key.slice(0, 128), value && typeof value === "object" && !Array.isArray(value)
          ? Object.keys(value).slice(0, 16).map(key => key.slice(0, 128)) : typeof value];
      }));
      this.callbacks.diagnostic?.("ACP permission denied structure: " + JSON.stringify({
        sessionMatches: request.sessionId === this.sessionId, phase: this.phase, knownReport: !!prior,
        toolKeys: Object.keys(request.toolCall).slice(0, 24), metadataShape,
        tool: { id: request.toolCall.toolCallId.slice(0, 128), name: request.toolCall.name?.slice(0, 128),
          kind: request.toolCall.kind, status: request.toolCall.status,
          server: metadataText(meta, ["mcpServerName", "serverName", "server"])?.slice(0, 128),
          nameFromMetadata: metadataText(meta, ["mcpToolName", "toolName", "tool"])?.slice(0, 128) },
        report: report ? { ...report, server: report.server?.slice(0, 128), name: report.name?.slice(0, 128) } : undefined,
        registered: !!report?.name && this.bridge.catalog.resolve(report.name) !== undefined,
        options: request.options.slice(0, 16).map(option => ({ kind: option.kind, id: option.optionId.slice(0, 128) })),
        outcome: response.outcome,
      }));
    }
    if (denied) {
      this.callbacks.diagnostic?.("Denied ACP native/unregistered permission request; only structured live bridge identities can receive offered allow-once options.");
    }
    return response;
  }

  takeNext(): PendingCall | undefined { return this.phase === "active" && !this.failure ? this.bridge.takeNext() : undefined; }
  complete(id: string, result: TrustedResult): Promise<void> { return this.bridge.complete(id, result); }
  finishTurn(): Exclude<acp.StopReason, "cancelled"> {
    if (this.phase !== "active" || this.flights.size || this.candidate || this.events.length || this.bridge.pendingCount) throw new Error("ACP turn has not drained");
    if (!this.lastResult || this.lastResult.stopReason === "cancelled") throw new Error("ACP turn ended without a successful owner/replacement prompt response");
    this.bridge.endTurn(); this.phase = "idle"; this.wake();
    return this.lastResult.stopReason;
  }
  async fail(error: Error): Promise<void> {
    const firstActiveFailure = !this.failure && this.phase === "active";
    this.failure ??= error;
    if (firstActiveFailure) {
      try { this.callbacks.failed?.(error); }
      catch (callbackError) { this.failure = new Error(`${error.message}. Failure recording failed: ${errorOf(callbackError).message}`, { cause: error }); }
    }
    this.wake();
    try { await this.stop(error); }
    catch (cleanupError) { this.failure = errorOf(cleanupError); }
  }
  stop(reason = new Error("AGY activation stopped")): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.windowObservation = undefined;
    this.earlyWindowUpdates = undefined;
    this.discoverySignal = undefined;
    this.phase = "stopping"; this.setupAbort.abort(reason); this.wake();
    this.stopPromise = Promise.resolve().then(async () => {
      const candidate = this.candidate;
      if (candidate && !candidate.settled) this.uncertain(candidate, reason);
      // Capability revocation precedes ACP cancellation and Linux producer cleanup.
      let revokeError: Error | undefined;
      try { await this.bridge?.revoke(reason); } catch (error) { revokeError = errorOf(error); }
      if (this.connection && this.sessionId) {
        void this.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: this.sessionId }).catch(() => {});
      }
      this.connection?.close(reason);
      this.cleanup = await (this.runner?.stop() ?? this.prepared?.stop());
      if (this.cleanup?.status === "cleanup_failed" || revokeError) {
        this.phase = "cleanup_failed";
        this.failure = new ActivationCleanupError(this.cleanup, [revokeError?.message, ...(this.cleanup?.errors ?? [])].filter(Boolean).join("; "));
      } else this.phase = "stopped";
      this.wake();
    }).catch(error => { this.phase = "cleanup_failed"; this.failure = error instanceof ActivationCleanupError ? error : new ActivationCleanupError(this.cleanup, errorOf(error).message); this.wake(); throw this.failure; });
    return this.stopPromise;
  }

  snapshot(): Record<string, unknown> {
    return { phase: this.phase, profile: this.config.profile, model: this.selectedModel, acpSessionId: this.sessionId,
      advertisedModels: this.models, thinking: this.thoughtOptions, activeFlights: this.flights.size, candidate: !!this.candidate,
      pending: this.bridge?.pendingCount ?? 0, delivered: this.bridge?.deliveredCount ?? 0,
      bridge: this.bridge?.snapshot(),
      counters: { ...this.counters }, contextUsage: this.contextUsage, billingUsage: "unavailable; context usage is not billed tokens",
      generation: this.runner?.evidence.generation ?? this.prepared?.evidence.generation,
      supervisorPid: this.runner?.evidence.supervisorPid, producerPid: this.runner?.evidence.producerPid, pgid: this.runner?.evidence.pgid,
      workers: this.runner?.evidence.workers.slice(0, 128) ?? [], cleanup: this.cleanup ? { ...this.cleanup, workers: this.cleanup.workers.slice(0, 128), errors: this.cleanup.errors.slice(0, 16) } : undefined,
      failure: this.failure?.message };
  }
}

/** Discover against a real no-generation session; cleanup is mandatory before returning. */
export async function discoverModels(config: SessionConfig, { bootstrap, signal }: { bootstrap?: RunnerFactory; signal?: AbortSignal } = {}): Promise<ModelDiscovery> {
  const controller = await SessionController.open(discoveryConfig(config), [], { observeModelWindows: true }, signal, undefined, bootstrap);
  let result: ModelDiscovery;
  try {
    result = { models: await controller.discoverModelOptions(), images: !!controller.capabilities.image, evidence: {} };
  } finally {
    await controller.stop(new Error("Live model discovery complete"));
    if (controller.phase === "cleanup_failed") throw new ActivationCleanupError(controller.cleanup, controller.failure?.message ?? "unconfirmed discovery cleanup");
  }
  result.evidence = controller.snapshot();
  return result;
}
