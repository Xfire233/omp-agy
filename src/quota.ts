import type { UsageProvider, UsageReport } from "@oh-my-pi/pi-ai";
import { bootstrapRunner, DEFAULT_RUNNER_CONFIG, type PreparedRunner, type RunnerConfig } from "./runner.ts";

export interface QuotaBucket {
  window: "five_hour" | "weekly";
  remainingFraction: number;
  resetAt: number;
}
export interface QuotaGroup {
  id: string;
  label: string;
  buckets: QuotaBucket[];
}
export interface QuotaSnapshot {
  source: "agy-print-usage";
  fetchedAt: number;
  cliVersion: string;
  groups: QuotaGroup[];
}
export type QuotaState = { status: "loading" } | { status: "unavailable"; reason: string } | { status: "ready"; snapshot: QuotaSnapshot };

export class QuotaReadError extends Error {}
const OUTPUT_LIMIT_BYTES = 262_144;
const QUOTA_DEADLINE_MS = 45_000;
export const QUOTA_FRESHNESS_MS = 60_000;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The observed 1.5.10 print contract, not ACP usage_update or token accounting. */
export function parseQuota(value: unknown, cliVersion: string, fetchedAt: number): QuotaSnapshot {
  const invalid = () => new QuotaReadError("AGY quota response has an unsupported or invalid schema");
  if (!object(value) || value.status !== "SUCCESS" || (value.num_turns !== undefined && value.num_turns !== 0)
    || !object(value.command) || !object(value.command.data) || !Array.isArray(value.command.data.groups)
    || value.command.data.groups.length === 0 || value.command.data.groups.length > 32) throw invalid();
  if (!Number.isSafeInteger(fetchedAt) || fetchedAt < 0 || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(cliVersion)) throw invalid();
  const labels = new Set<string>();
  const groups: QuotaGroup[] = value.command.data.groups.map((group, index) => {
    if (!object(group) || typeof group.name !== "string" || !/^[\p{L}\p{N} ()_.,+-]{1,120}$/u.test(group.name)
      || !group.name.trim() || labels.has(group.name) || !Array.isArray(group.buckets) || group.buckets.length === 0 || group.buckets.length > 8) throw invalid();
    labels.add(group.name);
    const windows = new Set<string>();
    const buckets: QuotaBucket[] = group.buckets.map(bucket => {
      if (!object(bucket) || (bucket.window !== "5h" && bucket.window !== "weekly") || windows.has(bucket.window)
        || typeof bucket.remaining_fraction !== "number" || !Number.isFinite(bucket.remaining_fraction)
        || bucket.remaining_fraction < 0 || bucket.remaining_fraction > 1 || bucket.disabled === true
        || typeof bucket.reset_time !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(bucket.reset_time)) throw invalid();
      const resetAt = Date.parse(bucket.reset_time);
      if (!Number.isSafeInteger(resetAt) || resetAt < 0 || new Date(resetAt).toISOString().slice(0, 19) !== bucket.reset_time.slice(0, 19)) throw invalid();
      windows.add(bucket.window);
      return { window: bucket.window === "5h" ? "five_hour" : "weekly", remainingFraction: bucket.remaining_fraction, resetAt };
    });
    // Only the published group label and quota fields cross this boundary.
    // Do not preserve account IDs, response text, or infer model membership.
    return { id: `group-${index + 1}`, label: group.name, buckets };
  });
  return { source: "agy-print-usage", fetchedAt, cliVersion, groups };
}

export interface QuotaFetchDependencies {
  bootstrap?: typeof bootstrapRunner;
  now?: () => number;
  deadlineMs?: number;
}

/** Exactly one official non-generative invocation, with Linux-owned cleanup on every path. */
export async function fetchQuota(config: RunnerConfig = {}, signal?: AbortSignal, dependencies: QuotaFetchDependencies = {}): Promise<QuotaSnapshot> {
  if (config.mode === "native") throw new QuotaReadError("AGY quota unavailable with the native runner; use /usage in your official CLI");
  const home = config.home ?? DEFAULT_RUNNER_CONFIG.home;
  const account = config.accountDirectory ?? DEFAULT_RUNNER_CONFIG.accountDirectory;
  if (account !== `${home}/.gemini/antigravity-cli`) throw new QuotaReadError("AGY quota requires accountDirectory HOME/.gemini/antigravity-cli; refusing a different account");
  signal?.throwIfAborted();
  const cancellation = new AbortController();
  let expired = false;
  const onAbort = () => cancellation.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) cancellation.abort();
  const timer = setTimeout(() => { expired = true; cancellation.abort(); }, dependencies.deadlineMs ?? QUOTA_DEADLINE_MS);
  let runner: PreparedRunner | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let result: QuotaSnapshot | undefined;
  let failure: unknown;
  const { promise: interrupted, reject } = Promise.withResolvers<never>();
  // An abort during owned bootstrap is handled there before this race begins.
  void interrupted.catch(() => {});
  const interrupt = () => reject(new QuotaReadError(expired ? "AGY quota read deadline exceeded" : "AGY quota read cancelled"));
  cancellation.signal.addEventListener("abort", interrupt, { once: true });
  // Bootstrap itself owns cancellation until it returns; never abandon it in a race.
  try {
    runner = await (dependencies.bootstrap ?? bootstrapRunner)(config, cancellation.signal);
    cancellation.signal.throwIfAborted();
    const operation = (async () => {
      const usage = await runner!.startUsage();
      reader = usage.stdout.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let text = "", bytes = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > OUTPUT_LIMIT_BYTES) throw new QuotaReadError("AGY quota output exceeded its byte bound");
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
      const code = await usage.exited;
      if (code !== 0) {
        // Preserve the useful CLI failure class without forwarding arbitrary CLI text.
        const diagnostic = usage.evidence.stderr.toLowerCase();
        const detail = diagnostic.includes("unknown flag") || diagnostic.includes("flag provided but not defined") ? "unsupported CLI flags"
          : diagnostic.includes("authentication required") || diagnostic.includes("not logged in") ? "authentication required; existing CLI login must be restored"
          : diagnostic.includes("expired or revoked") ? "existing CLI credentials expired or revoked"
          : diagnostic.includes("timed out") || diagnostic.includes("timeout") ? "upstream request timed out" : "official CLI operation failed";
        throw new QuotaReadError(`AGY quota unavailable (${code}): ${detail}`);
      }
      let value: unknown;
      try { value = JSON.parse(text); }
      catch { throw new QuotaReadError("AGY quota response is not valid JSON"); }
      return parseQuota(value, usage.evidence.version.trim(), (dependencies.now ?? Date.now)());
    })();
    result = await Promise.race([operation, interrupted]);
  } catch (error) {
    failure = error instanceof QuotaReadError ? error : new QuotaReadError(cancellation.signal.aborted
      ? expired ? "AGY quota read deadline exceeded" : "AGY quota read cancelled"
      : "AGY quota runner could not complete; inspect the runner cleanup diagnostics");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    cancellation.signal.removeEventListener("abort", interrupt);
    if (runner) {
      try {
        const report = await runner.stop();
        if (report.status !== "stopped") failure = new QuotaReadError("AGY quota cleanup_failed: Linux producer termination is unconfirmed");
      } catch { failure = new QuotaReadError("AGY quota cleanup_failed: Linux cleanup receipt could not be read"); }
    }
    if (reader) {
      try { await reader.cancel(); } catch { /* Linux cleanup is authoritative. */ }
      reader.releaseLock();
    }
  }
  if (failure) throw failure;
  if (!result) throw new QuotaReadError("AGY quota response unavailable");
  return result;
}

export interface QuotaProvider extends UsageProvider {
  refresh(signal?: AbortSignal): Promise<QuotaSnapshot>;
  snapshot(): QuotaState;
  invalidate(): Promise<void>;
}
export interface QuotaProviderOptions {
  onUpdate?: (state: QuotaState) => void;
  freshnessMs?: number;
  fetch?: typeof fetchQuota;
  now?: () => number;
}

/** Factory construction is inert. Only the active parent UI or explicit usage panel refreshes. */
export function createQuotaProvider(config: RunnerConfig, options: QuotaProviderOptions = {}): QuotaProvider {
  const freshnessMs = options.freshnessMs ?? QUOTA_FRESHNESS_MS;
  if (!Number.isSafeInteger(freshnessMs) || freshnessMs < 0) throw new Error("Invalid quota freshnessMs");
  const now = options.now ?? Date.now;
  let state: QuotaState = { status: "unavailable", reason: "AGY quota has not been read" };
  let pending: Promise<QuotaSnapshot> | undefined;
  let owned: AbortController | undefined;
  const publish = (next: QuotaState) => { state = next; options.onUpdate?.(next); };
  const refresh = (signal?: AbortSignal): Promise<QuotaSnapshot> => {
    if (signal?.aborted) return Promise.reject(new QuotaReadError("AGY quota read cancelled"));
    // A cancelled producer still owns Linux cleanup. A new caller waits for that
    // barrier, then starts a new read instead of inheriting the cancelled result.
    if (pending && owned?.signal.aborted) return pending.catch(() => {}).then(() => refresh(signal));
    if (!pending && state.status === "ready" && now() - state.snapshot.fetchedAt >= 0 && now() - state.snapshot.fetchedAt < freshnessMs) return Promise.resolve(state.snapshot);
    const ownsRead = !pending;
    if (!pending) {
      owned = new AbortController();
      publish({ status: "loading" });
      const current = owned;
      pending = Promise.resolve().then(() => (options.fetch ?? fetchQuota)(config, current.signal)).then(snapshot => {
        if (current.signal.aborted) throw new QuotaReadError("AGY quota read cancelled");
        publish({ status: "ready", snapshot });
        return snapshot;
      }).catch(error => {
        publish({ status: "unavailable", reason: error instanceof QuotaReadError ? error.message : "AGY quota read failed" });
        throw error;
      }).finally(() => { pending = undefined; owned = undefined; });
    }
    const request = pending;
    // A joining status UI must not cancel an explicit usage-panel owner's read.
    if (!ownsRead) return request;
    const current = owned!;
    const abort = () => current.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    return request.finally(() => signal?.removeEventListener("abort", abort));
  };
  return {
    id: "omp-agy",
    cacheVersion: 3, // Retire reports that lack the AGY sample timestamp note.
    retainLastGoodOnFailure: false,
    validatesCredentials: false,
    snapshot: () => {
      if (state.status === "ready" && (now() - state.snapshot.fetchedAt < 0 || now() - state.snapshot.fetchedAt >= freshnessMs)) {
        state = { status: "unavailable", reason: "AGY quota reading is stale" };
      }
      return state;
    },
    refresh,
    async invalidate() {
      owned?.abort();
      await pending?.catch(() => {}); // The old producer owns its Linux cleanup.
      publish({ status: "unavailable", reason: "AGY account quota must be read again" });
    },
    async fetchUsage(params): Promise<UsageReport | null> {
      const snapshot = await refresh(params.signal);
      return {
        provider: "omp-agy", fetchedAt: snapshot.fetchedAt,
        limits: snapshot.groups.flatMap(group => group.buckets.map(bucket => ({
          id: `${group.id}:${bucket.window}`, label: `${group.label} · ${bucket.window === "five_hour" ? "5 Hour" : "Weekly"}`,
          scope: { provider: "omp-agy", shared: true, sharedGroup: `${group.id}:${bucket.window}`, windowId: bucket.window },
          window: { id: bucket.window, label: bucket.window === "five_hour" ? "5 Hour" : "Weekly", durationMs: bucket.window === "five_hour" ? 18_000_000 : 604_800_000, resetsAt: bucket.resetAt },
          amount: { unit: "percent" as const, remainingFraction: bucket.remainingFraction, usedFraction: Math.max(0, Math.min(1, 1 - bucket.remainingFraction)) },
        }))),
        // OMP caches the serialized report outside this provider. A fixed sample
        // timestamp stays accurate even when OMP's aggregate age is much newer.
        notes: [`AGY quota read: ${new Date(snapshot.fetchedAt).toISOString()}. OMP can cache this beyond the widget's ${QUOTA_FRESHNESS_MS / 1000}s limit.`],
        metadata: { source: snapshot.source, cliVersion: snapshot.cliVersion },
      };
    },
  };
}
