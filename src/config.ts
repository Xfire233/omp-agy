import { isRunnerProfile, RUNNER_PROFILES, type RunnerConfig, type RunnerProfile } from "./runner.ts";

export interface AgyConfig {
  profile: RunnerProfile;
  /** No WSL activity at load by default; startup is an explicit CLI model-resolution opt-in. */
  discovery: "ondemand" | "startup";
  instructions?: string;
  allowedModels?: readonly string[];
  /** Opt-in local protocol diagnostics; never part of the model/activation identity. */
  debug?: { directory: string; mode: "metadata" | "content" };
  /** Explicit WSL-only overrides; omitted fields retain the runner's fixed defaults. */
  runner?: RunnerConfig;
  /** Optional requested budget, capped by a known ceiling; unknown capacity defaults to 400000 when omitted. */
  contextWindow?: number;
  maxTokens: number;
  /** Receipt idle window extended only by official session text/thought progress; not a total-time guarantee. */
  steeringConfirmationMs: number;
}
function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${name} must be a positive safe integer`);
  return number;
}
function runnerConfig(environment: Record<string, string | undefined>): RunnerConfig | undefined {
  const runner: RunnerConfig = {};
  const mode = environment.OMP_AGY_RUNNER_MODE;
  if (mode !== undefined && mode !== "wsl" && mode !== "native") throw new Error("OMP_AGY_RUNNER_MODE must be wsl or native; no implicit fallback");
  if (mode !== undefined) runner.mode = mode;
  const strings = {
    OMP_AGY_WSL_PATH: "wslPath", OMP_AGY_WSL_DISTRIBUTION: "distribution", OMP_AGY_WSL_USER: "user",
    OMP_AGY_CLI: "cli", OMP_AGY_HOME: "home", OMP_AGY_ACCOUNT_DIRECTORY: "accountDirectory",
    OMP_AGY_XDG_CONFIG_HOME: "xdgConfigHome", OMP_AGY_XDG_CACHE_HOME: "xdgCacheHome", OMP_AGY_XDG_DATA_HOME: "xdgDataHome",
  } as const;
  for (const [name, key] of Object.entries(strings)) {
    const value = environment[name];
    if (value === undefined) continue;
    if (!value || /[\0\r\n]/.test(value)) throw new Error(`${name} must be a nonempty explicit runner value without control characters`);
    runner[key] = value;
  }
  if (mode === "native") {
    if (!runner.cli?.startsWith("/") || !runner.accountDirectory?.startsWith("/")) throw new Error("Native AGY requires absolute POSIX OMP_AGY_CLI and OMP_AGY_ACCOUNT_DIRECTORY");
    if (runner.wslPath || runner.distribution || runner.user || runner.home || runner.xdgConfigHome || runner.xdgCacheHome || runner.xdgDataHome) throw new Error("Native AGY does not accept WSL identity, HOME or XDG overrides");
  }
  const integers = {
    OMP_AGY_STARTUP_TIMEOUT_MS: "startupTimeoutMs", OMP_AGY_CLEANUP_TIMEOUT_MS: "cleanupTimeoutMs", OMP_AGY_STDERR_LIMIT_BYTES: "stderrLimitBytes",
  } as const;
  for (const [name, key] of Object.entries(integers)) {
    const value = environment[name];
    if (value === undefined || value === "") continue;
    runner[key] = positiveInteger(value, 0, name);
  }
  return Object.keys(runner).length ? runner : undefined;
}
export function readConfig(environment: Record<string, string | undefined> = process.env): AgyConfig {
  const profile = environment.OMP_AGY_PROFILE ?? "custom-clean";
  if (!isRunnerProfile(profile)) throw new Error(`OMP_AGY_PROFILE must be one of ${RUNNER_PROFILES.join(", ")}`);
  const discovery = environment.OMP_AGY_DISCOVERY ?? "ondemand";
  if (discovery !== "ondemand" && discovery !== "startup") throw new Error("OMP_AGY_DISCOVERY must be ondemand or startup");
  const allowedModels = environment.OMP_AGY_MODELS?.split(",").map(value => value.trim()).filter(Boolean);
  const runner = runnerConfig(environment);
  const contextWindowValue = environment.OMP_AGY_CONTEXT_WINDOW?.trim();
  const contextWindow = contextWindowValue ? Number(contextWindowValue) : undefined;
  if (contextWindow !== undefined && (!Number.isSafeInteger(contextWindow) || contextWindow <= 0)) throw new Error("OMP_AGY_CONTEXT_WINDOW must be a positive safe integer");
  const debugDirectory = environment.OMP_AGY_DEBUG_DIR;
  const debugMode = environment.OMP_AGY_DEBUG_MODE ?? "metadata";
  if (debugDirectory !== undefined && (!debugDirectory.trim() || /[\0\r\n]/.test(debugDirectory))) throw new Error("OMP_AGY_DEBUG_DIR must be a nonempty local directory path");
  if (debugMode !== "metadata" && debugMode !== "content") throw new Error("OMP_AGY_DEBUG_MODE must be metadata or content");
  return {
    profile, discovery,
    ...(environment.OMP_AGY_INSTRUCTIONS ? { instructions: environment.OMP_AGY_INSTRUCTIONS } : {}),
    ...(allowedModels?.length ? { allowedModels: [...new Set(allowedModels)] } : {}),
    ...(runner ? { runner } : {}),
    ...(debugDirectory ? { debug: { directory: debugDirectory, mode: debugMode } } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    maxTokens: positiveInteger(environment.OMP_AGY_MAX_TOKENS, 8192, "OMP_AGY_MAX_TOKENS"),
    steeringConfirmationMs: positiveInteger(environment.OMP_AGY_STEERING_CONFIRMATION_MS, 30000, "OMP_AGY_STEERING_CONFIRMATION_MS"),
  };
}
