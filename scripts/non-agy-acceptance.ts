import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FileSink } from "bun";
import { ptree, removeWithRetries } from "@oh-my-pi/pi-utils";
import { RpcFrameDecoder, MAX_RPC_FRAME_BYTES } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame";
import { redact } from "./acceptance.ts";

// Real-account, original @task acceptance. No execution on import.
// Supply --api-key-env with the original provider's API-key variable name (not
// its value), and --expected-base-url with the reviewed HTTPS endpoint.
// Only the parent is selected as omp-agy; the bundled task agent and its original
// role/fallback metadata remain unchanged. No forced failures or fallback claim.
type Frame = Record<string, any>;
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
async function bounded<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(() => deadline.reject(new Error(`${label} deadline`)), ms);
  try { return await Promise.race([work, deadline.promise]); }
  finally { clearTimeout(timer); }
}
async function writeEvidence(path: string, value: unknown, roots: string[]): Promise<void> {
  const serialized = JSON.stringify(redact(value, roots), null, 2) + "\n";
  assert(Buffer.byteLength(serialized) <= 8 * 1024 * 1024, "Retained evidence exceeds the 8MiB per-file limit");
  await writeFile(path, serialized);
}

/** Standalone variant of acceptance.ts's actual installed-protocol RPC driver. */
class Host {
  child?: ptree.ChildProcess<"pipe">;
  private sequence = 0;
  private fatal?: Error;
  private closing = false;
  private closePromise?: Promise<void>;
  private listeners = new Set<(frame: Frame) => void>();
  private ready?: Frame;
  private terminals = new Map<string, Frame>();
  private decoder = new RpcFrameDecoder();
  private sink: FileSink;
  private bytes = 0;
  truncated = false;
  readonly lifecycle: Frame[] = [];
  readonly snapshots: Frame[] = [];
  readonly cleanup: Frame = {};
  constructor(trace: string, readonly roots: string[], readonly deadlineMs: number) { this.sink = Bun.file(trace).writer(); }
  record(direction: string, frame: unknown): void {
    if (this.truncated) return;
    const line = JSON.stringify({ at: new Date().toISOString(), direction, frame: redact(frame, this.roots) }) + "\n";
    this.bytes += Buffer.byteLength(line);
    if (this.bytes > 32 * 1024 * 1024) { this.truncated = true; this.sink.write('{"type":"trace_limit","limitBytes":33554432}\n'); return; }
    this.sink.write(line);
  }
  private fail(error: unknown): void {
    if (this.closing) return;
    this.fatal = new Error(errorText(error));
    for (const listener of this.listeners) listener({ type: "transport_error", error: this.fatal.message });
  }
  async start(executable: string, project: string, env: Record<string, string>, args: string[]): Promise<void> {
    this.record("launch", { executable, args, cwd: project, isolation: "temporary home/agent/config/project/session; inherited API key remains in environment only" });
    this.child = ptree.spawn([executable, ...args], { cwd: project, env, stdin: "pipe" });
    void this.child.exited.then(code => this.fail(new Error(`OMP exited (${code})`)), error => this.fail(error));
    void this.consume(this.child.stdout).catch(error => this.fail(error));
    const ready = this.ready ?? await this.wait(frame => frame.type === "ready", 120_000);
    if (ready.supportedProtocolVersions?.includes(2)) await this.request({ type: "negotiate_protocol", protocolVersion: 2 });
  }
  private async consume(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader(); const decoder = new TextDecoder(); let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const newline = buffer.indexOf("\n"); if (newline < 0) break;
          const line = buffer.slice(0, newline).replace(/\r$/, ""); buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          assert(Buffer.byteLength(line) <= MAX_RPC_FRAME_BYTES, "RPC frame exceeded installed limit");
          const frame = this.decoder.push(JSON.parse(line)) as Frame | null;
          if (!frame) continue;
          this.record("out", frame);
          if (frame.type === "ready") this.ready = frame;
          if (frame.type === "prompt_result") this.terminals.set(frame.id, frame);
          if (frame.type.startsWith("subagent_")) this.lifecycle.push(frame);
          if (frame.type === "extension_ui_request" && frame.method === "notify") {
            try { const status = JSON.parse(frame.message); if (status.type === "omp-agy-status") this.snapshots.push(status); } catch { /* ordinary notification */ }
          }
          for (const listener of this.listeners) listener(frame);
        }
        assert(Buffer.byteLength(buffer) <= MAX_RPC_FRAME_BYTES, "Unterminated RPC frame exceeded installed limit");
      }
      assert(!buffer.trim(), "RPC stream ended mid-frame");
      if (!this.closing) this.fail(new Error("OMP stdout closed"));
    } finally { reader.releaseLock(); }
  }
  private wait(predicate: (frame: Frame) => boolean, ms = this.deadlineMs): Promise<Frame> {
    if (this.fatal) return Promise.reject(this.fatal);
    const result = Promise.withResolvers<Frame>();
    const timer = setTimeout(() => { this.listeners.delete(listener); result.reject(new Error("Expected OMP RPC event not observed before deadline")); }, ms);
    const listener = (frame: Frame) => {
      if (frame.type !== "transport_error" && !predicate(frame)) return;
      clearTimeout(timer); this.listeners.delete(listener);
      if (frame.type === "transport_error") result.reject(new Error(frame.error)); else result.resolve(frame);
    };
    this.listeners.add(listener); void result.promise.catch(() => {}); return result.promise;
  }
  async request(command: Frame, timeout = 30_000): Promise<Frame> {
    assert(this.child, "OMP not launched"); const id = `original_role_${++this.sequence}`;
    const response = this.wait(frame => frame.type === "response" && frame.id === id, timeout);
    this.record("in", { ...command, id }); this.child.stdin.write(JSON.stringify({ ...command, id }) + "\n");
    const frame = await response; assert(frame.success, `${command.type}: ${frame.error ?? "RPC rejected"}`);
    return command.type === "prompt" ? { id, admission: frame.data } : frame.data;
  }
  async prompt(message: string, timeout = this.deadlineMs): Promise<Frame> {
    const admission = await this.request({ type: "prompt", message }, timeout);
    if (admission.admission?.agentInvoked === false) return admission;
    return this.terminals.get(admission.id) ?? await this.wait(frame => frame.type === "prompt_result" && frame.id === admission.id, timeout);
  }
  async status(): Promise<Frame | undefined> {
    const start = this.snapshots.length; await this.prompt("/agy-status", 5_000); return this.snapshots.slice(start).at(-1);
  }
  async settled(): Promise<Frame> {
    const end = Date.now() + 30_000;
    for (;;) {
      const state = await this.request({ type: "get_state" }); if (state.isSettled) return state;
      assert(Date.now() < end, "Parent did not settle after task"); await Bun.sleep(100);
    }
  }
  close(): Promise<void> { return this.closePromise ??= this.closeOwnedTree(); }
  private async closeOwnedTree(): Promise<void> {
    try {
      if (this.child && !this.fatal) {
        try {
          const state = await this.request({ type: "get_state" }, 5_000);
          if (!state.isSettled) { this.cleanup.abort = await this.request({ type: "abort" }, 90_000); await this.settled(); }
          this.cleanup.before = await this.status();
          this.cleanup.stop = await this.prompt("/agy-stop", 90_000);
          this.cleanup.after = await this.status();
        } catch (error) { this.cleanup.error = errorText(error); }
      }
    } finally {
      this.closing = true;
      if (this.child) {
        try { this.child.stdin.end(); this.cleanup.exitCode = await bounded(this.child.exited, 5_000, "OMP EOF shutdown"); }
        catch {
          this.child.kill(undefined, 1_000);
          try { this.cleanup.exitCode = await bounded(this.child.exited, 8_000, "owned OMP tree termination"); }
          catch (error) { this.cleanup.treeError = errorText(error); }
        }
        this.record("stderr", this.child.peekStderr());
      }
      this.record("cleanup", this.cleanup);
      for (const listener of this.listeners) listener({ type: "transport_error", error: "Acceptance closed" });
      this.listeners.clear(); await this.sink.end();
    }
  }
}

function environment(root: string, apiKeyEnv: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (key.toUpperCase() !== apiKeyEnv && /(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH_BROKER|AUTH_GATEWAY)/i.test(key)) continue;
    if (/^(?:OMP_PROFILE|PI_PROFILE|PI_CODING_AGENT_DIR|PI_CODING_AGENT_SESSION_DIR|PI_CONFIG_DIR|PI_PROJECT_DIR|OMP_AGY_.*|CLAUDE_CONFIG_DIR|CODEX_HOME|GEMINI_CLI_HOME|XDG_.*)$/i.test(key)) continue;
    result[key] = value;
  }
  const home = join(root, "home");
  return { ...result, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"), PI_CODING_AGENT_DIR: join(root, "agent"), PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"), OMP_AGY_PROFILE: "custom-clean", OMP_AGY_DISCOVERY: "startup", NO_COLOR: "1" };
}
function selectorParts(selector: string): { provider: string; id: string } {
  const slash = selector.indexOf("/"); assert(slash > 0, "Original role lacks provider selector");
  return { provider: selector.slice(0, slash), id: selector.slice(slash + 1).replace(/:(?:minimal|low|medium|high|xhigh|max)$/, "") };
}
function text(messages: Frame[]): string {
  return messages.flatMap(message => Array.isArray(message.content) ? message.content.filter((block: Frame) => block.type === "text").map((block: Frame) => String(block.text)) : []).join("\n");
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    assert(["--out", "--omp", "--deadline-seconds", "--original-agent", "--api-key-env", "--expected-base-url"].includes(argv[i]!), "Unknown argument");
    assert(argv[i + 1] && !argv[i + 1]!.startsWith("--"), `Missing value for ${argv[i]}`); options.set(argv[i]!, argv[i + 1]!);
  }
  const apiKeyEnv = options.get("--api-key-env");
  assert(apiKeyEnv && /^[A-Z][A-Z0-9_]*_API_KEY$/.test(apiKeyEnv), "Supply --api-key-env with the original provider's environment variable name, not its value");
  const expectedBaseUrl = options.get("--expected-base-url");
  assert(expectedBaseUrl && URL.canParse(expectedBaseUrl), "Supply --expected-base-url with the reviewed HTTPS endpoint");
  const endpoint = new URL(expectedBaseUrl);
  assert(endpoint.protocol === "https:" && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash, "Expected base URL must be HTTPS and contain no credentials, query or fragment");
  const out = resolve(options.get("--out") ?? ".acceptance/non-agy-original-role");
  const deadlineMs = Number(options.get("--deadline-seconds") ?? 360) * 1000;
  assert(Number.isFinite(deadlineMs) && deadlineMs >= 30_000 && deadlineMs <= 900_000, "Deadline must be 30..900 seconds");
  const executable = options.get("--omp") ?? Bun.which("omp.exe") ?? Bun.which("omp"); assert(executable, "Actual omp executable unavailable");
  const originalAgent = resolve(options.get("--original-agent") ?? join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".omp", "agent"));
  await mkdir(out, { recursive: true });
  assert(!await Bun.file(join(out, "report.json")).exists(), "Refusing to overwrite preserved acceptance evidence");
  const root = await mkdtemp(join(tmpdir(), "omp-agy-original-role-"));
  const host = new Host(join(out, "trace.jsonl"), [root, process.env.USERPROFILE ?? "", process.env.HOME ?? "", endpoint.origin], deadlineMs);
  const report: Frame = { schemaVersion: 1, generatedAt: new Date().toISOString(), classification: "failed", scope: "A11 original HTTP @task child under AGY parent", driverReadOrCopiedCredentialFiles: false, normalExistingAuthenticationOperationAllowed: true, noForcedFailure: true, fallbackExecutionClaimed: false, trace: "trace.jsonl" };
  const onInterrupt = () => { report.interrupted = true; void host.close(); };
  process.once("SIGINT", onInterrupt); process.once("SIGTERM", onInterrupt);
  try {
    assert(Boolean(process.env[apiKeyEnv]?.trim()), "The selected API key environment variable is absent; no credential-file fallback is permitted");
    report.authentication = { apiKeyReferenceName: apiKeyEnv, inheritedKeyPresent: true, credentialValueRecorded: false };
    const originalConfig = Bun.YAML.parse(await readFile(join(originalAgent, "config.yml"), "utf8")) as Frame;
    const sourceModels = Bun.YAML.parse(await readFile(join(originalAgent, "models.yml"), "utf8")) as Frame;
    const modelRoles = structuredClone(originalConfig.modelRoles);
    const fallbackChains = structuredClone(originalConfig.retry?.fallbackChains ?? {});
    report.originalSelectionMetadata = { modelRoles, fallbackChains, copiedFrom: "original config.yml nonsecret modelRoles and retry.fallbackChains only" };
    const target = selectorParts(modelRoles.task);
    assert(target.provider !== "omp-agy", "Original task role must target a non-AGY provider");
    const source = sourceModels.providers[target.provider];
    assert(source?.apiKey === apiKeyEnv, "Original provider must reference the named environment variable, not a literal key");
    assert(source.api === "openai-responses" && source.baseUrl === expectedBaseUrl, "Original task HTTP transport metadata does not match the reviewed endpoint");
    const selectors = new Set<string>();
    for (const value of [...Object.values(modelRoles), ...Object.keys(fallbackChains), ...Object.values(fallbackChains).flat()]) {
      if (typeof value === "string" && value.startsWith(`${target.provider}/`)) selectors.add(selectorParts(value).id);
    }
    const models = source.models.filter((model: Frame) => selectors.has(model.id));
    assert(models.some((model: Frame) => model.id === target.id), "Original task model missing from original models.yml");
    // Copy only this provider's nonsecret model metadata. No discovery, other
    // providers, headers, credential files, or literal credential values.
    const provider = { baseUrl: source.baseUrl, apiKey: apiKeyEnv, api: source.api, auth: source.auth, models,
      modelOverrides: Object.fromEntries(Object.entries<Frame>(source.modelOverrides ?? {}).filter(([id]) => selectors.has(id))) };
    assert(!JSON.stringify(provider).match(/Bearer\s|sk-[a-zA-Z0-9]{12}/), "Unexpected secret-shaped model metadata");
    const project = join(root, "project"); const agent = join(root, "agent"); const sessions = join(root, "sessions"); const config = join(root, "config.yml");
    await Promise.all([project, agent, sessions, join(root, "home")].map(path => mkdir(path, { recursive: true })));
    const metadata = { modelRoles, retry: { fallbackChains } };
    await writeFile(config, Bun.YAML.stringify(metadata));
    await writeFile(join(agent, "models.yml"), Bun.YAML.stringify({ providers: { [target.provider]: provider } }));
    const marker = `CHILD_ORIGINAL_${crypto.randomUUID().replaceAll("-", "")}`;
    const markerFile = `child-${crypto.randomUUID()}.txt`; await writeFile(join(project, markerFile), marker + "\n");
    const args = ["--mode", "rpc", "--no-title", "--no-prewalk", "--no-extensions", "--session-dir", sessions, "--config", config, "-e", join(repository, "index.ts")];
    await bounded((async () => {
      await host.start(executable, project, environment(root, apiKeyEnv), args);
      await host.request({ type: "set_auto_compaction", enabled: false });
      await host.request({ type: "set_cache_warming", mode: "off" });
      // Deliberately no set_auto_retry: preserve role/fallback behavior.
      const available = await host.request({ type: "get_available_models" });
      const discovered = available.models.find((model: Frame) => model.provider === target.provider && model.id === target.id);
      const expected = { api: provider.api, baseUrl: provider.baseUrl, ...models.find((model: Frame) => model.id === target.id), ...provider.modelOverrides[target.id] };
      assert(expected.api === "openai-responses" && expected.baseUrl === expectedBaseUrl, "Original task model override changes the reviewed route");
      assert(discovered && discovered.api === expected.api && discovered.baseUrl === expected.baseUrl, "Discovered original task model API/baseUrl differ from original metadata; generation refused");
      report.preGeneration = { originalTaskSelector: modelRoles.task, target, discovered, expectedTransport: { api: expected.api, baseUrl: expected.baseUrl }, apiAndBaseUrlMatch: true };
      const parent = available.models.find((model: Frame) => model.provider === "omp-agy"); assert(parent, "Actual AGY parent model not advertised");
      await host.request({ type: "set_model", provider: parent.provider, modelId: parent.id });
      const before = await host.request({ type: "get_state" }); assert(before.model?.provider === "omp-agy", "Parent not using AGY");
      assert(before.dumpTools?.some((tool: Frame) => tool.name === "task"), "Actual parent tool catalog lacks task");
      await host.request({ type: "set_subagent_subscription", level: "events" });
      const parentStatusBefore = await host.status();
      const assignment = { context: "Read-only original-role acceptance", tasks: [{ name: "ReadOriginalMarker", agent: "task", solutionSpace: "Read the assigned file and return its exact marker", task: `Use OMP read to read ${markerFile} in this project and return the exact file marker. Do not use other tools.` }] };
      const result = await host.prompt(`Call the actual OMP task tool exactly once using these argument fields unchanged, adding only the required intent field: ${JSON.stringify(assignment)}. In particular do NOT add a tools field (that field is for eval-defined tools, not built-in tools), any model or role override, or a custom agent definition. The bundled task agent must use its configured @task role and fallback unchanged. Do not read the file yourself or use bash. If task is detached, use OMP wait to consume its actual result. If any call fails, report failure without retrying. After the child completes, report its exact returned marker.`);
      report.promptResult = result;
      const after = await host.settled();
      const parentHistory = await host.request({ type: "get_messages" });
      await writeEvidence(join(out, "parent-transcript.json"), parentHistory, host.roots);
      const assistants = parentHistory.messages.filter((message: Frame) => message.role === "assistant");
      const calls = assistants.flatMap((message: Frame) => (message.content ?? []).filter((block: Frame) => block.type === "toolCall"));
      const taskCalls = calls.filter((call: Frame) => call.name === "task");
      const noOverride = taskCalls.length === 1 && !Object.hasOwn(taskCalls[0].arguments, "model") && !Object.hasOwn(taskCalls[0].arguments, "role") && taskCalls[0].arguments.tasks?.length === 1 && taskCalls[0].arguments.tasks.every((task: Frame) => task.agent === "task" && !Object.hasOwn(task, "model") && !Object.hasOwn(task, "role"));
      const lifecycle = host.lifecycle.filter(frame => frame.type === "subagent_lifecycle" && frame.payload.agent === "task");
      const children = [...new Map(lifecycle.map(frame => [frame.payload.id, frame.payload])).values()];
      const childEvidence: Frame[] = [];
      for (const child of children) {
        const history = await host.request({ type: "get_subagent_messages", subagentId: child.id });
        const transcriptFile = `child-transcript-${childEvidence.length + 1}.json`;
        await writeEvidence(join(out, transcriptFile), history, host.roots);
        const childAssistants = history.messages.filter((message: Frame) => message.role === "assistant");
        const readResults = history.messages.filter((message: Frame) => message.role === "toolResult" && message.toolName === "read" && !message.isError);
        const sessionInit = history.entries?.find((entry: Frame) => entry.type === "session_init");
        childEvidence.push({ child, transcriptFile, sessionInitSelection: { agent: sessionInit?.agent, modelRole: sessionInit?.modelRole, resolvedModel: sessionInit?.resolvedModel }, originalBundledRole: child.agentSource === "bundled" && sessionInit?.agent === "task" && sessionInit?.modelRole === "task" && sessionInit?.resolvedModel === modelRoles.task, observedModels: childAssistants.map((message: Frame) => ({ api: message.api, provider: message.provider, model: message.model })), modelsMatch: childAssistants.length > 0 && childAssistants.every((message: Frame) => message.api === discovered.api && message.provider === target.provider && message.model === target.id), readResultObserved: text(readResults).includes(marker), readResults, answerObserved: text(childAssistants).includes(marker) });
      }
      report.execution = { parent, parentStatusBefore, parentStatusAfter: await host.status(), parentModelAfter: after.model, parentModelsMatch: assistants.length > 0 && assistants.every((message: Frame) => message.provider === "omp-agy" && message.model === parent.id), parentAnswerObserved: text(assistants).includes(marker), actualParentCalls: calls, noTaskModelOrRoleOverride: noOverride, lifecycle, childEvidence, parentTranscript: "parent-transcript.json" };
      assert(result.status === "completed" && after.model?.provider === "omp-agy", "Parent generation did not complete under AGY");
      const parentToolErrors = parentHistory.messages.filter((message: Frame) => message.role === "toolResult" && message.isError === true);
      report.execution.parentToolErrors = parentToolErrors;
      assert(report.execution.parentModelsMatch && report.execution.parentAnswerObserved && noOverride && calls.every((call: Frame) => call.name === "task" || call.name === "wait") && parentToolErrors.length === 0, "Parent route, actual task call, override policy, tool failure, or marker failed");
      assert(childEvidence.length === 1 && childEvidence.every(child => child.child.status === "completed" && child.originalBundledRole && child.modelsMatch && child.readResultObserved && child.answerObserved), "Original HTTP child role/model, actual read, retained answer, or completed lifecycle missing");
      const finalConfig = Bun.YAML.parse(await readFile(config, "utf8")) as Frame;
      const finalModels = Bun.YAML.parse(await readFile(join(agent, "models.yml"), "utf8")) as Frame;
      const metadataUnchanged = JSON.stringify(finalConfig.modelRoles) === JSON.stringify(modelRoles) && JSON.stringify(finalConfig.retry?.fallbackChains) === JSON.stringify(fallbackChains);
      const apiKeyNameUnchanged = finalModels.providers[target.provider].apiKey === apiKeyEnv;
      report.selectionMetadata = { modelRoles, fallbackChains, metadataUnchanged, apiKeyReferenceName: finalModels.providers[target.provider].apiKey, apiKeyNameUnchanged, taskRoleChain: fallbackChains.task ?? null, defaultRoleChain: fallbackChains.default ?? null, modelSpecificChain: fallbackChains[`${target.provider}/${target.id}`] ?? null, fallbackExecuted: "not claimed; no failure induced; successful primary observed" };
      assert(metadataUnchanged && apiKeyNameUnchanged, "Temporary original role/fallback or key-reference metadata was altered");
      report.classification = "observed";
    })(), deadlineMs, "Original-role real acceptance");
  } catch (error) { report.error = errorText(error); }
  finally {
    await host.close();
    report.routingClassification = report.classification;
    report.fixtureCleanupContext = { driverCwd: process.cwd(), traceSinkEnded: true, method: "pi-utils removeWithRetries after explicit ACP stop, process exit and trace sink end" };
    report.cleanup = host.cleanup;
    const cleanup = host.cleanup.after?.cleanup; const bridge = host.cleanup.after?.bridge;
    report.cleanupConfirmed = cleanup?.status === "stopped" && cleanup.errors?.length === 0 && cleanup.workers?.every((worker: Frame) => worker.state === "exited") && bridge?.revoked === true && bridge.accepting === false && bridge.activeTurn === false && bridge.sessionCount === 0 && bridge.connections === 0 && bridge.pendingCount === 0 && bridge.queuedCount === 0 && bridge.dispatchedCount === 0 && bridge.deliveringCount === 0;
    if (!report.cleanupConfirmed || host.cleanup.error || host.cleanup.treeError || host.truncated) report.classification = "failed";
    try { await removeWithRetries(root); report.temporaryFixturesRemoved = true; }
    catch (error) { report.temporaryFixturesRemoved = false; report.fixtureCleanupError = errorText(error); report.classification = "failed"; }
    process.removeListener("SIGINT", onInterrupt); process.removeListener("SIGTERM", onInterrupt);
    report.evidenceTruncated = host.truncated;
    await writeEvidence(join(out, "report.json"), report, host.roots);
  }
  console.log(`Original-role child acceptance: ${report.classification}; evidence ${join(out, "report.json")}`);
  if (report.error) console.log(redact(report.error, host.roots));
  process.exitCode = report.classification === "observed" ? 0 : 1;
}
if (import.meta.main) main().catch(error => { console.error(redact(errorText(error), [process.env.USERPROFILE ?? "", process.env.HOME ?? ""])); process.exitCode = 1; });
