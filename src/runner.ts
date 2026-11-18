import { networkInterfaces } from "node:os";
import { isIP } from "node:net";
import { bootstrapNativeRunner } from "./runner-native.ts";
import { deadline, operationWithDeadline } from "./runner-io.ts";

export const RUNNER_PROFILES = Object.freeze(["custom-clean", "default-agy", "omp-system"] as const);
export type RunnerProfile = (typeof RUNNER_PROFILES)[number];
export function isRunnerProfile(value: string): value is RunnerProfile {
  return RUNNER_PROFILES.some(profile => profile === value);
}
export type RunnerMode = "wsl" | "native";
export interface RunnerConfig {
  /** Native is explicit and non-isolated. Omission always selects fixed WSL. */
  mode?: RunnerMode;
  wslPath?: string;
  distribution?: string;
  user?: string;
  cli?: string;
  home?: string;
  accountDirectory?: string;
  xdgConfigHome?: string;
  xdgCacheHome?: string;
  xdgDataHome?: string;
  startupTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  stderrLimitBytes?: number;
}
export const DEFAULT_RUNNER_CONFIG = Object.freeze({
  wslPath: "C:\\Windows\\System32\\wsl.exe",
  distribution: "omp-agy-wsl",
  user: "agy",
  cli: "/home/agy/.local/bin/agy",
  home: "/home/agy",
  accountDirectory: "/home/agy/.gemini/antigravity-cli",
  xdgConfigHome: "/home/agy/.config",
  xdgCacheHome: "/home/agy/.cache",
  xdgDataHome: "/home/agy/.local/share",
  startupTimeoutMs: 30_000,
  cleanupTimeoutMs: 15_000,
  stderrLimitBytes: 65_536,
});

export function runnerCapabilities(config: RunnerConfig = {}): Readonly<{ quota: boolean; reset: boolean }> {
  if (config.mode === "native") return { quota: false, reset: false };
  if (config.mode === undefined || config.mode === "wsl") return { quota: true, reset: true };
  throw new Error("Unknown runner mode; select wsl or native explicitly");
}
export interface WorkerEvidence {
  pid: number;
  startTime: string;
  pgid: number;
  parentPid: number;
  state: "observed" | "exited" | "alive";
}
export interface CleanupReport {
  status: "stopped" | "cleanup_failed";
  generation: string;
  workers: WorkerEvidence[];
  errors: string[];
  /** Native verifies only its supervised POSIX process group, not detached escapees. */
  scope?: "native-process-group";
  producerExit?: number;
  /** Cross-boot recovery confirms termination, not an invented exit code. */
  termination?: "boot_ended";
}
export interface RunnerEvidence {
  mode?: RunnerMode;
  generation: string;
  distribution: string;
  user: string;
  uid: number;
  gid: number;
  groups: string;
  home: string;
  cli: string;
  version: string;
  kernel: string;
  mounts: string;
  sharedDirectories: string;
  interop: string;
  permissions: string;
  route: string;
  gateway: string;
  sourceAddress: string;
  workspace: string;
  windowsInterface: string;
  /** Durable WSL receipt; empty for native, which does not publish one. */
  cleanupReceiptPath: string;
  supervisorPid?: number;
  supervisorStartTime?: string;
  producerPid?: number;
  producerStartTime?: string;
  pgid?: number;
  profile?: RunnerProfile;
  stderr: string;
  stderrTruncated: boolean;
  workers: WorkerEvidence[];
  cleanup?: CleanupReport;
}
export interface RunnerStartOptions {
  url: string;
  token: string;
  aliases: readonly string[];
  profile: RunnerProfile;
  instructions?: string;
  /** Only for omp-system; staged in the private agent file, never sent via ACP. */
  hostSystemPrompt?: string;
  /** Original OMP names keyed by advertised alias, when available from the bridge catalog. */
  originalToolNames?: ReadonlyMap<string, string>;
}
export interface RunningRunner {
  stdout: ReadableStream<Uint8Array>;
  stdin: WritableStream<Uint8Array>;
  exited: Promise<number>;
  evidence: RunnerEvidence;
  /** Explicit user instructions for the official session/new append capability. */
  appendInstructions?: string;
  stop(): Promise<CleanupReport>;
}
export interface RunningUsage {
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  evidence: RunnerEvidence;
  stop(): Promise<CleanupReport>;
}
export interface PreparedRunner {
  gateway: string;
  sourceAddress: string;
  workspace: string;
  evidence: RunnerEvidence;
  start(options: RunnerStartOptions): Promise<RunningRunner>;
  /** Fixed, non-generative /usage command; never accepts user prompt text. */
  startUsage(): Promise<RunningUsage>;
  stop(): Promise<CleanupReport>;
}

/** Injectable runner entry point shared by OMP and other ACP hosts. */
export type RunnerFactory = (config?: RunnerConfig, signal?: AbortSignal) => Promise<PreparedRunner>;

type Config = Required<Omit<RunnerConfig, "mode">>;
const blockedTargets = new Set<string>();
const encoder = new TextEncoder();
const base64 = (text: string) => Buffer.from(text).toString("base64");
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const targetKey = (config: Config) => `${config.wslPath}\0${config.distribution}\0${config.user}\0${config.home}\0${config.accountDirectory}`;

const MAX_HOST_SYSTEM_PROMPT_BYTES = 1_048_576;
const MAX_TOOL_MAPPING_BYTES = 16_384;
const CLEAN_AGENT_FRONTMATTER = "---\nname: omp-agy-clean\ndescription: OMP client tool bridge\ntools: []\nexcludeDefaultComponents: true\nmainAgent: true\n---\n";

/** Check before starting a backend in the controller and again at the runner boundary. */
export function validateHostSystemPrompt(profile: RunnerProfile, prompt: string | undefined): string | undefined {
  if (profile !== "omp-system") {
    if (prompt !== undefined) throw new Error("A host system prompt is only allowed with the omp-system profile");
    return undefined;
  }
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("The omp-system profile requires a nonblank OMP host system prompt");
  if (prompt.includes("\0") || Buffer.byteLength(prompt, "utf8") > MAX_HOST_SYSTEM_PROMPT_BYTES) {
    throw new Error("The OMP host system prompt must be NUL-free and at most 1 MiB in UTF-8");
  }
  return prompt;
}

/** Remove Unicode space separators after commas, preserving tabs and line breaks. */
export function normalizeOmpSystemPrompt(prompt: string): string {
  return prompt.replace(/([,，])\p{Zs}+/gu, "$1");
}

function ompSystemAgent(prompt: string, options: RunnerStartOptions, workspaceLabel: string): string {
  const mappings: string[] = [];
  let mappingBytes = 0;
  for (const alias of options.aliases) {
    const original = options.originalToolNames?.get(alias);
    if (original === undefined || original === alias) continue;
    if (original.length > MAX_TOOL_MAPPING_BYTES - mappingBytes) throw new Error("OMP tool name mappings exceed their resource bound");
    // Keep names with control characters or backticks on a single Markdown line.
    const name = JSON.stringify(original).replaceAll("`", "\\u0060");
    const mapping = `- \`${name}\` → \`mcp_omp_agy_bridge_${alias}\`\n`;
    mappingBytes += Buffer.byteLength(mapping, "utf8");
    if (mappingBytes > MAX_TOOL_MAPPING_BYTES) throw new Error("OMP tool name mappings exceed their resource bound");
    mappings.push(mapping);
  }
  const instructions = options.instructions === undefined ? "" : `${options.instructions}\n\n`;
  const bridgeNote = "## OMP tool bridge\n\n" +
    "When OMP instructions name a tool, use the matching advertised MCP tool from `omp_agy_bridge` (normally `mcp_omp_agy_bridge_<name>`). " +
    "If there is no advertised match, the capability is unavailable; do not invent tools or capabilities. " +
    `Use OMP's tools for all project filesystem operations. The ${workspaceLabel} cwd is staging, not the user's project.\n`;
  const body = `# System Prompt\n\n${prompt}\n\n${instructions}${bridgeNote}${mappings.length ? `\nRenamed tools:\n${mappings.join("")}` : ""}`;
  return CLEAN_AGENT_FRONTMATTER + normalizeOmpSystemPrompt(body);
}

function stageRunnerStart(options: RunnerStartOptions, gateway: string, mode: RunnerMode) {
  // Exact authority comparison rejects empty userinfo, normalized alternate IP
  // spellings and paths that URL parsing would silently canonicalize.
  let endpoint: URL;
  try { endpoint = new URL(options.url); }
  catch { throw new Error("Invalid private MCP endpoint"); }
  if (endpoint.hostname !== gateway || !endpoint.port || options.url !== `http://${gateway}:${endpoint.port}/mcp`) {
    throw new Error(`Bridge endpoint must be the current ${mode === "wsl" ? "Windows WSL gateway" : "native loopback"} /mcp endpoint`);
  }
  if (!isRunnerProfile(options.profile)) throw new Error("Unknown runner profile");
  const hostSystemPrompt = validateHostSystemPrompt(options.profile, options.hostSystemPrompt);
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(options.token)) throw new Error("Bridge token must be a high-entropy private bearer");
  if (new Set(options.aliases).size !== options.aliases.length || options.aliases.some(alias => !/^[A-Za-z0-9_-]{1,64}$/.test(alias))) throw new Error("Bridge aliases must be unique published tool names");
  if (options.instructions !== undefined && (options.instructions.includes("\0") || encoder.encode(options.instructions).byteLength > 1_048_576)) throw new Error("Invalid explicit agent instructions");
  const profile = options.profile === "omp-system" ? "custom-clean" : options.profile;
  const label = mode === "wsl" ? "Linux" : "native";
  const agent = hostSystemPrompt !== undefined ? ompSystemAgent(hostSystemPrompt, options, label) :
    profile === "custom-clean" ? `${CLEAN_AGENT_FRONTMATTER}Use the supplied OMP MCP tools for project operations. The ${label} workspace is staging, not the user's project.\n${options.instructions ?? ""}\n` : "";
  const tools = Object.fromEntries(options.aliases.map(alias => [alias, { eager: true }]));
  const mcp = JSON.stringify({ mcpServers: { omp_agy_bridge: { serverUrl: options.url, headers: { Authorization: `Bearer ${options.token}` }, timeoutSeconds: -1, tools } } });
  return { profile, mcp, agent, appendInstructions: options.profile === "default-agy" ? options.instructions : undefined };
}

/** Retain a UTF-8 suffix without decoding a partial leading code point. */
export function utf8Tail(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  let start = bytes.byteLength - maxBytes;
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start++;
  return new TextDecoder().decode(bytes.subarray(start));
}
function redact(text: string, secret?: string): string {
  if (secret) text = text.replaceAll(secret, "[redacted]");
  return text.replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(/((?:access_token|refresh_token|id_token|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1[redacted]")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[account]");
}

/** Byte-bounded diagnostic suffix plus an unexposed, token-bounded overlap. */
export class RunnerDiagnosticCapture {
  private readonly decoder = new TextDecoder();
  private raw = "";
  private pendingToken = "";
  truncated = false;
  constructor(private readonly limit: number, private readonly secret: () => string | undefined = () => undefined) {}
  get text(): string {
    const redacted = redact(this.raw, this.secret()) + (this.pendingToken ? "[redacted]" : "");
    const bounded = utf8Tail(redacted, this.limit);
    this.truncated ||= bounded !== redacted;
    return bounded;
  }
  append(text: string): void {
    let committed = this.pendingToken + text;
    this.pendingToken = "";
    const secret = this.secret();
    if (secret) {
      // Full tokens must disappear BEFORE the suffix cap can cut them apart.
      committed = committed.replaceAll(secret, "[redacted]");
      // Retain only a possible unfinished token, even if it exceeds the capture
      // cap. Getters mask it; a later mismatch releases ordinary diagnostics.
      // Scan at most token.length - 1 characters, allocating only candidates
      // beginning with its first character rather than one string per byte.
      for (let start = Math.max(0, committed.length - secret.length + 1); start < committed.length; start++) {
        if (committed.charCodeAt(start) !== secret.charCodeAt(0)) continue;
        const suffix = committed.slice(start);
        if (!secret.startsWith(suffix)) continue;
        this.pendingToken = suffix;
        committed = committed.slice(0, start);
        break;
      }
    }
    const combined = this.raw + committed;
    this.raw = utf8Tail(combined, this.limit);
    this.truncated ||= this.raw !== combined;
  }
  appendBytes(bytes: Uint8Array): void { this.append(this.decoder.decode(bytes, { stream: true })); }
  appendEvent(line: string): void {
    // The supervisor reads at most 3072 raw bytes per diagnostic event.
    const frame = /^OMP_AGY_EVENT\tdiagnostic\t([A-Za-z0-9+/=]*)$/.exec(line);
    if (!frame || frame[1]!.length > 4096) throw new Error("Invalid Linux diagnostic event frame");
    const bytes = Buffer.from(frame[1]!, "base64");
    if (bytes.toString("base64") !== frame[1]) throw new Error("Invalid Linux diagnostic event encoding");
    this.appendBytes(bytes);
  }
  finish(): void { this.append(this.decoder.decode()); }
}
function resolveConfig(input: RunnerConfig): Config {
  const config = { ...DEFAULT_RUNNER_CONFIG, ...input, ...runnerLimits(input) };
  for (const key of ["wslPath", "distribution", "user", "cli", "home", "accountDirectory", "xdgConfigHome", "xdgCacheHome", "xdgDataHome"] as const) {
    if (typeof config[key] !== "string" || !config[key] || /[\0\r\n]/.test(config[key])) throw new Error(`Invalid runner ${key}`);
  }
  if (!/^[A-Za-z]:[\\/]/.test(config.wslPath)) throw new Error("Runner wslPath must be an absolute Windows launcher path");
  if (config.user === "root") throw new Error("Runner user must not be root");
  for (const key of ["cli", "home", "accountDirectory", "xdgConfigHome", "xdgCacheHome", "xdgDataHome"] as const) {
    if (!config[key].startsWith("/") || /^\/mnt\/[a-z](?:\/|$)/i.test(config[key]) || config[key].split("/").includes("..")) throw new Error(`Runner ${key} must be an explicit Linux path, not a Windows project mount`);
  }
  if (!config.accountDirectory.startsWith(`${config.home}/`)) throw new Error("Stable account directory must be inside explicit HOME");
  return config;
}

function runnerLimits(input: RunnerConfig) {
  const limits = {
    startupTimeoutMs: input.startupTimeoutMs ?? DEFAULT_RUNNER_CONFIG.startupTimeoutMs,
    cleanupTimeoutMs: input.cleanupTimeoutMs ?? DEFAULT_RUNNER_CONFIG.cleanupTimeoutMs,
    stderrLimitBytes: input.stderrLimitBytes ?? DEFAULT_RUNNER_CONFIG.stderrLimitBytes,
  };
  for (const key of ["startupTimeoutMs", "cleanupTimeoutMs", "stderrLimitBytes"] as const) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1024 || limits[key] > 2_147_483_647) throw new Error(`Invalid runner ${key}`);
  }
  return limits;
}
function wslArgs(config: Config, command: string[]): string[] {
  return [config.wslPath, "--distribution", config.distribution, "--user", config.user, "--cd", config.home, "--exec", ...command];
}
function terminateLauncher(child: { exitCode: number | null; kill(signal: "SIGKILL"): void }): void {
  try { if (child.exitCode === null) child.kill("SIGKILL"); }
  catch { /* Launcher signals never prove Linux cleanup. */ }
}
async function boundedText(stream: ReadableStream<Uint8Array>, max: number, signal?: AbortSignal): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "", bytes = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  if (signal?.aborted) cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      const next = await reader.read();
      signal?.throwIfAborted();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > max) throw new Error("WSL control output exceeded its resource bound");
      text += decoder.decode(next.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}
async function finite(config: Config, command: string[], input: string, signal?: AbortSignal, ms = config.startupTimeoutMs): Promise<string> {
  return operationWithDeadline(ms, "WSL control operation deadline exceeded", async cancellation => {
    const child = Bun.spawn(wslArgs(config, command), { stdin: encoder.encode(input), stdout: "pipe", stderr: "pipe" });
    const streams = new AbortController();
    const cancel = () => { streams.abort(); terminateLauncher(child); };
    cancellation.addEventListener("abort", cancel, { once: true });
    try {
      const [stdout, stderr, code] = await Promise.all([
        boundedText(child.stdout, 1_048_576, streams.signal), boundedText(child.stderr, config.stderrLimitBytes, streams.signal), child.exited,
      ]);
      cancellation.throwIfAborted();
      if (code !== 0) throw new Error(`WSL runner operation failed (${code}): ${redact(stderr).trim()}`);
      return stdout;
    } catch (error) { cancel(); throw error; }
    finally { streams.abort(); cancellation.removeEventListener("abort", cancel); }
  }, signal);
}

/** Both the source consumed by bash and the stored copy need Unix line endings. */
export function wslScriptSource(source: string): string {
  return source.replaceAll("\r\n", "\n");
}

export interface RunnerResetReport { recovered: string[] }
/** Recover only identities Linux can prove stopped; never kill or bypass a fence. */
export async function resetRunner(input: RunnerConfig = {}, signal?: AbortSignal): Promise<RunnerResetReport> {
  if (!runnerCapabilities(input).reset) throw new Error("Runner reset is unavailable in native mode; no WSL operation was attempted");
  const config = resolveConfig(input);
  if (process.platform !== "win32") throw new Error("omp-agy requires the explicit Windows WSL2 runner; no local fallback exists");
  const result = await operationWithDeadline(config.startupTimeoutMs, "WSL reset staging deadline exceeded", async cancellation => {
    const source = wslScriptSource(await Bun.file(new URL("../scripts/bootstrap.sh", import.meta.url)).text());
    cancellation.throwIfAborted();
    return finite(config, ["/usr/bin/bash", "-s", "--", "reset", config.user, config.home, config.distribution], `bootstrap_source='${base64(source)}'\n${source}`, cancellation);
  }, signal);
  const recovered = result.trimEnd() ? result.trimEnd().split("\n").map(line => {
    const match = /^recovered\t([A-Za-z0-9+/=]+)$/.exec(line);
    if (!match) throw new Error("Invalid Linux recovery evidence frame");
    return Buffer.from(match[1]!, "base64").toString("utf8");
  }) : [];
  blockedTargets.delete(targetKey(config));
  return { recovered };
}
function parseBootstrap(output: string): Record<string, string> {
  const values: Record<string, string> = Object.create(null);
  for (const line of output.trimEnd().split("\n")) {
    const match = /^([A-Za-z]+)\t([A-Za-z0-9+/=]*)$/.exec(line);
    if (!match || Object.hasOwn(values, match[1]!)) throw new Error("Invalid WSL bootstrap evidence frame");
    values[match[1]!] = Buffer.from(match[2]!, "base64").toString("utf8");
  }
  for (const key of ["generation", "user", "uid", "gid", "groups", "home", "cli", "version", "mounts", "sharedDirectories", "interop", "kernel", "gateway", "sourceAddress", "workspace", "runtime", "cleanupReceiptPath", "permissions", "route"]) {
    if (!Object.hasOwn(values, key)) throw new Error(`Missing WSL bootstrap evidence: ${key}`);
  }
  return values;
}
/** Parse the supervisor's private, generation-owned report, never ACP stdout. */
export function parseCleanupReport(text: string, generation: string): CleanupReport {
  const lines = text.trimEnd().split("\n");
  const status = lines.shift();
  if (status !== "stopped" && status !== "cleanup_failed") throw new Error("Invalid Linux cleanup status");
  const report: CleanupReport = { status, generation, workers: [], errors: [] };
  let exitSeen = false, generationSeen = false;
  for (const line of lines) {
    const fields = line.split("\t");
    if (fields[0] === "producer_exit" && fields.length === 2 && !exitSeen) {
      exitSeen = true;
      if (fields[1] === "unknown") report.errors.push("Producer exit is unconfirmed");
      else if (fields[1] === "boot_ended") report.termination = "boot_ended";
      else if (/^\d+$/.test(fields[1]!)) report.producerExit = Number(fields[1]);
      else throw new Error("Invalid producer exit status");
    } else if (fields[0] === "worker" && fields.length === 6 && fields.slice(1, 5).every(value => /^\d+$/.test(value)) && ["exited", "alive"].includes(fields[5]!)) {
      report.workers.push({ pid: Number(fields[1]), startTime: fields[2]!, pgid: Number(fields[3]), parentPid: Number(fields[4]), state: fields[5] as "exited" | "alive" });
    } else if (fields[0] === "error" && fields.length === 2) report.errors.push(fields[1]!);
    else if (fields[0] === "generation" && fields.length === 2 && !generationSeen) {
      generationSeen = true;
      if (fields[1] !== generation) throw new Error("Linux cleanup generation mismatch");
    }
    else throw new Error("Invalid Linux cleanup evidence frame");
  }
  if (!exitSeen) throw new Error("Missing Linux producer exit confirmation");
  if (report.workers.some(worker => worker.state === "alive") || report.errors.length) report.status = "cleanup_failed";
  return report;
}

const CONTROL_FRAME_LIMIT_BYTES = 1_048_576;
/** Terminal transport proof includes the full durable report and completion seal. */
export function parseCleanupEvent(line: string, generation: string): CleanupReport {
  if (line.length > CONTROL_FRAME_LIMIT_BYTES) throw new Error("Linux cleanup control frame exceeded its resource bound");
  const frame = /^OMP_AGY_EVENT\tcleanup\t([A-Za-z0-9+/=]+)$/.exec(line);
  if (!frame) throw new Error("Invalid Linux cleanup event frame");
  const bytes = Buffer.from(frame[1]!, "base64");
  if (bytes.toString("base64") !== frame[1]) throw new Error("Invalid Linux cleanup event frame encoding");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const seal = `\ncomplete\t${generation}`;
  if (!text.endsWith(seal)) throw new Error("Missing Linux cleanup completion seal or generation mismatch");
  const reportText = text.slice(0, -seal.length);
  if (!reportText.split("\n").includes(`generation\t${generation}`)) throw new Error("Missing Linux cleanup generation confirmation");
  return parseCleanupReport(reportText, generation);
}

export async function bootstrapRunner(input: RunnerConfig = {}, signal?: AbortSignal): Promise<PreparedRunner> {
  signal?.throwIfAborted();
  runnerCapabilities(input); // Validate runtime callers as well as typed callers.
  if (input.mode === "native") return bootstrapNativeRunner(input, runnerLimits(input), options => stageRunnerStart(options, "127.0.0.1", "native"), signal);
  const config = resolveConfig(input);
  if (process.platform !== "win32") throw new Error("omp-agy requires the explicit Windows WSL2 runner; no local fallback exists");
  const target = targetKey(config);
  if (blockedTargets.has(target)) throw new Error(`cleanup_failed: previous producer is unconfirmed; inspect ${config.home}/.cache/omp-agy and use /agy-reset for identity-checked recovery`);
  const generation = crypto.randomUUID();
  const startDeadline = performance.now() + config.startupTimeoutMs;
  const [bootstrap, supervisor] = await operationWithDeadline(config.startupTimeoutMs, "WSL script staging deadline exceeded", () => Promise.all([
    Bun.file(new URL("../scripts/bootstrap.sh", import.meta.url)).text().then(wslScriptSource),
    Bun.file(new URL("../scripts/supervisor.sh", import.meta.url)).text().then(wslScriptSource),
  ]), signal);
  signal?.throwIfAborted();
  const child = Bun.spawn(wslArgs(config, ["/usr/bin/bash", "-s", "--", "bootstrap", generation, config.user, config.cli, config.home, config.accountDirectory, config.xdgConfigHome, config.xdgCacheHome, config.xdgDataHome, config.distribution, String(config.startupTimeoutMs)]), { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let abortOperation: () => void;
  const onAbort = () => abortOperation();
  let closingBootstrap: Promise<unknown> | undefined;
  const closeBootstrap = () => closingBootstrap ??= Promise.resolve().then(() => child.stdin.end());
  abortOperation = () => { void closeBootstrap().catch(() => {}); };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const bootstrapReader = child.stderr.getReader();
  const bootstrapDecoder = new TextDecoder();
  const bootstrapLines: string[] = [];
  let bootstrapPending = "", bootstrapReady = "", bootstrapBytes = 0;
  let token: string | undefined;
  const diagnostics = new RunnerDiagnosticCapture(config.stderrLimitBytes, () => token);
  let data: Record<string, string>;
  const abandonBootstrap = async () => {
    signal?.removeEventListener("abort", onAbort);
    bootstrapReader.releaseLock();
    const cancellation = new AbortController();
    // Keep draining diagnostics while the Linux owner receives EOF and finalizes.
    void boundedText(child.stderr, 2_097_152, cancellation.signal).catch(() => {});
    try {
      await deadline(Promise.all([closeBootstrap(), child.exited]), config.cleanupTimeoutMs, "Failed WSL bootstrap cleanup deadline exceeded");
      return true;
    } catch {
      blockedTargets.add(target);
      terminateLauncher(child);
      return false;
    } finally { cancellation.abort(); }
  };
  try {
    // This pipe stays open: the final exec does not require EOF. ACP bytes use
    // a different process; only static shell source is staged on this pipe.
    await operationWithDeadline(Math.max(0, startDeadline - performance.now()), "WSL staging/supervisor readiness deadline exceeded", async cancellation => {
      await child.stdin.write(`supervisor_source='${base64(supervisor)}'\nbootstrap_source='${base64(bootstrap)}'\n${bootstrap}`);
      cancellation.throwIfAborted();
      await child.stdin.flush();
      cancellation.throwIfAborted();
      while (!bootstrapReady) {
        const next = await bootstrapReader.read();
        cancellation.throwIfAborted();
        if (next.done) {
          diagnostics.append(bootstrapPending + bootstrapDecoder.decode()); diagnostics.finish();
          throw new Error(`WSL bootstrap ended before supervisor ownership was ready: ${diagnostics.text.trim()}`);
        }
        bootstrapBytes += next.value.byteLength;
        if (bootstrapBytes > 2_097_152) throw new Error("WSL bootstrap evidence exceeded its resource bound");
        bootstrapPending += bootstrapDecoder.decode(next.value, { stream: true });
        let end: number;
        while ((end = bootstrapPending.indexOf("\n")) >= 0) {
          const line = bootstrapPending.slice(0, end);
          bootstrapPending = bootstrapPending.slice(end + 1);
          if (line.startsWith("OMP_AGY_BOOTSTRAP\t")) bootstrapLines.push(line.slice("OMP_AGY_BOOTSTRAP\t".length));
          else {
            const readyFrame = /^OMP_AGY_EVENT\tready\t([A-Za-z0-9+/=]+)$/.exec(line);
            if (readyFrame) { bootstrapReady = Buffer.from(readyFrame[1]!, "base64").toString("utf8"); break; }
            if (line.startsWith("OMP_AGY_EVENT\tdiagnostic\t")) diagnostics.appendEvent(line);
            else diagnostics.append(`${line}\n`);
          }
        }
      }
    }, signal);
    signal?.throwIfAborted();
    data = parseBootstrap(bootstrapLines.join("\n"));
    if (!/^\d+ \d+$/.test(bootstrapReady)) throw new Error("Invalid persistent supervisor process identity");
  } catch (error) {
    if (!await abandonBootstrap()) throw new Error(`${errorText(error)}; cleanup_failed: WSL bootstrap owner shutdown is unconfirmed`);
    // Dead owners without reports remain fenced by the persistent registry.
    throw error;
  }
  const runtime = data.runtime!;
  const cleanupReceiptPath = data.cleanupReceiptPath!;
  const expectedReceiptPath = `${config.home}/.cache/omp-agy/receipts/${generation}/cleanup`;
  if (cleanupReceiptPath !== expectedReceiptPath || !runtime.startsWith(`${config.home}/.cache/omp-agy/activation.`) || runtime.includes("/../")) {
    const confirmed = await abandonBootstrap();
    throw new Error(`Invalid Linux activation/receipt path${confirmed ? "" : "; cleanup_failed: WSL bootstrap owner shutdown is unconfirmed"}`);
  }
  const controlScript = `${cleanupReceiptPath.slice(0, -"cleanup".length)}bootstrap.sh`;
  const control = (mode: string, args: string[] = [], body = "", cancellation?: AbortSignal, ms?: number) =>
    finite(config, ["/usr/bin/bash", controlScript, mode, runtime, generation, ...args], body, cancellation, ms);
  const [supervisorPid, supervisorStartTime] = bootstrapReady.split(" ");
  let preparationError: Error | undefined;
  if (data.generation !== generation || data.user !== config.user || Number(data.uid) === 0 || !Number.isSafeInteger(Number(data.uid))) preparationError = new Error("WSL identity/generation mismatch");
  if (isIP(data.gateway!) !== 4 || isIP(data.sourceAddress!) !== 4 || data.gateway === data.sourceAddress) preparationError = new Error("WSL eth0 NAT gateway/source evidence is invalid");
  const matches = Object.entries(networkInterfaces()).filter(([, addresses]) => addresses?.some(address => address.family === "IPv4" && address.address === data.gateway && !address.internal));
  const evidence: RunnerEvidence = {
    mode: "wsl",
    generation, distribution: config.distribution, user: data.user!, uid: Number(data.uid), gid: Number(data.gid), groups: data.groups!, home: data.home!, cli: data.cli!, version: data.version!, kernel: data.kernel!, mounts: data.mounts!, sharedDirectories: data.sharedDirectories!, interop: data.interop!, permissions: data.permissions!, route: data.route!, gateway: data.gateway!, sourceAddress: data.sourceAddress!, workspace: data.workspace!, windowsInterface: matches[0]?.[0] ?? "", stderr: diagnostics.text, stderrTruncated: diagnostics.truncated, workers: [], supervisorPid: Number(supervisorPid), supervisorStartTime,
    cleanupReceiptPath,
  };
  let inputProcess: Bun.Subprocess<"pipe", "ignore", "pipe"> | undefined;
  const shutdown = new AbortController();
  const activationSignal = signal ? AbortSignal.any([signal, shutdown.signal]) : shutdown.signal;
  let stopping: Promise<CleanupReport> | undefined;
  let started = false;
  const { promise: producer, resolve: producerResolve } = Promise.withResolvers<void>();
  const { promise: terminalCleanup, resolve: terminalResolve } = Promise.withResolvers<CleanupReport | undefined>();
  let terminalReport: CleanupReport | undefined;
  let stderrFailure: string | undefined;
  const syncStderr = () => {
    evidence.stderr = diagnostics.text;
    evidence.stderrTruncated = diagnostics.truncated;
  };
  const appendStderr = (text: string) => { diagnostics.append(text); syncStderr(); };
  const consumeStderr = (async () => {
    const reader = bootstrapReader;
    const decoder = bootstrapDecoder;
    let pending = bootstrapPending;
    const line = (value: string) => {
      if (value.startsWith("OMP_AGY_EVENT\t") && value.length > CONTROL_FRAME_LIMIT_BYTES) {
        stderrFailure = "Linux control frame exceeded its resource bound";
        terminalResolve(undefined); appendStderr(`${stderrFailure}\n`); return;
      }
      if (value.startsWith("OMP_AGY_EVENT\tdiagnostic\t")) {
        diagnostics.appendEvent(value); syncStderr(); return;
      }
      if (value.startsWith("OMP_AGY_EVENT\tcleanup\t")) {
        diagnostics.finish(); syncStderr();
        try { terminalReport = parseCleanupEvent(value, generation); terminalResolve(terminalReport); }
        catch (error) { stderrFailure = errorText(error); terminalResolve(undefined); appendStderr(`${stderrFailure}\n`); }
        return;
      }
      const frame = /^OMP_AGY_EVENT\t([a-z]+)\t([A-Za-z0-9+/=]*)$/.exec(value);
      if (!frame) { appendStderr(`${value}\n`); return; }
      const payload = Buffer.from(frame[2]!, "base64").toString("utf8");
      if (frame[1] === "ready") { const [pid, start] = payload.split(" "); evidence.supervisorPid = Number(pid); evidence.supervisorStartTime = start; }
      else if (frame[1] === "producer") {
        const [pid, pgid, actualGeneration, startTime] = payload.split(" ");
        if (actualGeneration !== generation) { stderrFailure = "Supervisor generation changed"; return; }
        evidence.producerPid = Number(pid); evidence.pgid = Number(pgid); evidence.producerStartTime = startTime; producerResolve();
      } else if (frame[1] === "worker") {
        const [pid, startTime, pgid, parentPid] = payload.split(" ");
        evidence.workers.push({ pid: Number(pid), startTime: startTime!, pgid: Number(pgid), parentPid: Number(parentPid), state: "observed" });
      } else if (frame[1] === "fatal") { stderrFailure = redact(payload, token); appendStderr(`${payload}\n`); terminalResolve(undefined); }
    };
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        pending += decoder.decode(next.value, { stream: true });
        let end: number;
        while ((end = pending.indexOf("\n")) >= 0) { line(pending.slice(0, end)); pending = pending.slice(end + 1); }
        const controlPending = pending.startsWith("OMP_AGY_EVENT\t");
        const pendingLimit = controlPending ? CONTROL_FRAME_LIMIT_BYTES : config.stderrLimitBytes;
        if (pending.length > pendingLimit) {
          if (controlPending) { stderrFailure = "Linux control frame exceeded its resource bound"; terminalResolve(undefined); }
          appendStderr(pending); pending = "";
        }
      }
      pending += decoder.decode();
      if (pending) line(pending);
    } catch (error) { stderrFailure = errorText(error); }
    finally { diagnostics.finish(); syncStderr(); terminalResolve(undefined); reader.releaseLock(); }
  })();
  // Consumers can observe exit without waiting for stderr EOF, which a stray worker
  // could keep open. Stderr consumption is independently bounded and asynchronous.
  const exited = child.exited;
  const stop = (): Promise<CleanupReport> => stopping ??= (async () => {
    shutdown.abort(new Error("WSL runner is stopping"));
    // EOF on this existing liveness transport requests Linux-owned cleanup.
    // Its terminal report is emitted only after durable publication/removal;
    // neither stderr EOF nor launcher exit is required to receive that proof.
    let pipeCloseFailed = false;
    try {
      const input = inputProcess;
      await deadline(Promise.all([closeBootstrap(), input ? Promise.resolve().then(() => input.stdin.end()) : Promise.resolve()]), 1000, "Runner pipe close deadline exceeded");
    } catch { pipeCloseFailed = true; }
    let report = terminalReport;
    if (!report && !pipeCloseFailed) {
      try { report = await deadline(terminalCleanup, config.cleanupTimeoutMs, "Linux terminal cleanup frame deadline exceeded"); }
      catch { /* A missing terminal frame falls back to the durable receipt. */ }
    }
    if (!report) {
      try { report = parseCleanupReport(await control("stop-wait-report", [String(config.cleanupTimeoutMs)], "", undefined, Math.min(config.cleanupTimeoutMs + 1000, 2_147_483_647)), generation); }
      catch (error) { report = { status: "cleanup_failed", generation, workers: evidence.workers, errors: [errorText(error)] }; }
    }
    // A durable stopped receipt confirms Linux physical cleanup, not that an
    // interrupted Windows session_shutdown handler ever finished its callback.
    if (report.status === "cleanup_failed") {
      blockedTargets.add(target);
      try { await control("mark-failed", [], "", undefined, 1000); }
      catch (error) { report.errors.push(`Persistent cleanup failure marker: ${errorText(error)}`); }
    }
    evidence.cleanup = report;
    signal?.removeEventListener("abort", onAbort);
    evidence.workers = report.workers;
    // Never treat killing this launcher as evidence of Linux cleanup.
    terminateLauncher(child);
    if (inputProcess) terminateLauncher(inputProcess);
    return report;
  })();
  abortOperation = () => { void stop(); };
  const readiness = (label: string) => Promise.race([producer, exited.then(code => { throw new Error(stderrFailure ?? `Linux supervisor exited before ${label} (${code})`); })]);
  try {
    if (preparationError) throw preparationError;
    if (matches.length !== 1) throw new Error("Current Linux gateway does not uniquely match a Windows WSL IPv4 interface; refusing broad/loopback bind");
  } catch (error) { const report = await stop(); throw new Error(`${errorText(error)}; cleanup=${report.status}`); }
  // Keep the async stderr consumer observed, but never serialize protocol startup on it.
  void consumeStderr;
  return {
    gateway: evidence.gateway, sourceAddress: evidence.sourceAddress, workspace: evidence.workspace, evidence, stop,
    async startUsage() {
      signal?.throwIfAborted();
      if (config.accountDirectory !== `${config.home}/.gemini/antigravity-cli`) throw new Error("Usage print mode requires accountDirectory HOME/.gemini/antigravity-cli; refusing quota from a different account");
      if (started || stopping || child.exitCode !== null) throw new Error("Prepared runner may start only once while its supervisor is live");
      if (blockedTargets.has(target)) throw new Error("cleanup_failed: replacement producer is blocked");
      started = true;
      try {
        await operationWithDeadline(config.startupTimeoutMs, "WSL usage producer startup deadline exceeded", async cancellation => {
          await control("configure-usage", [], "", cancellation);
          cancellation.throwIfAborted();
          await readiness("usage producer start");
        }, activationSignal);
        activationSignal.throwIfAborted();
      } catch (error) { const report = await stop(); throw new Error(`${errorText(error)}; cleanup=${report.status}`); }
      return { stdout: child.stdout, exited, evidence, stop };
    },
    async start(options) {
      if (started || stopping || child.exitCode !== null) throw new Error("Prepared runner may start only once while its supervisor is live");
      if (blockedTargets.has(target)) throw new Error("cleanup_failed: replacement producer is blocked");
      signal?.throwIfAborted();
      const { profile: launchProfile, mcp, agent, appendInstructions } = stageRunnerStart(options, evidence.gateway, "wsl");
      started = true; token = options.token; evidence.profile = options.profile;
      try {
        await operationWithDeadline(config.startupTimeoutMs, "WSL ACP producer startup deadline exceeded", async cancellation => {
          await control("configure", [launchProfile], `${base64(mcp)}\n${base64(agent)}\n`, cancellation);
          cancellation.throwIfAborted();
          inputProcess = Bun.spawn(wslArgs(config, ["/usr/bin/bash", controlScript, "input", runtime, generation]), { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
          void boundedText(inputProcess.stderr, config.stderrLimitBytes, activationSignal).then(appendStderr, error => {
            if (!activationSignal.aborted) { stderrFailure = errorText(error); void stop(); }
          });
          await readiness("producer start");
        }, activationSignal);
        activationSignal.throwIfAborted();
      } catch (error) { const report = await stop(); throw new Error(`${redact(errorText(error), token)}; cleanup=${report.status}`); }
      const input = inputProcess;
      if (!input) throw new Error("ACP input transport was not started");
      return {
        stdout: child.stdout,
        stdin: new WritableStream<Uint8Array>({
          async write(chunk) {
            try {
              await operationWithDeadline(config.startupTimeoutMs, "WSL ACP input flush deadline exceeded", async cancellation => {
                await input.stdin.write(chunk);
                cancellation.throwIfAborted();
                await input.stdin.flush();
              }, activationSignal);
            } catch (error) { void stop(); throw error; }
          },
          async close() { await stop(); },
          async abort() { await stop(); },
        }),
        exited, evidence,
        appendInstructions,
        stop,
      };
    },
  };
}
