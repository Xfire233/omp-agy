import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { PROVIDER_ID, type ProviderDisplayState } from "./provider.ts";
import { QUOTA_FRESHNESS_MS, type QuotaState } from "./quota.ts";

export const STATUS_KEY = "omp-agy";
export const QUOTA_WIDGET_KEY = "omp-agy-quota";
const MAX_GROUPS = 3;

/** Bind canonical session lifecycle contexts only: request contexts can freeze model. */
export interface StatusContext {
  hasUI: boolean;
  agent: Pick<ExtensionContext["agent"], "kind">;
  model: Pick<NonNullable<ExtensionContext["model"]>, "provider" | "id" | "contextWindow"> | undefined;
  sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId">;
  ui: Pick<ExtensionContext["ui"], "setStatus" | "setWidget">;
  setInterval: ExtensionContext["setInterval"];
  clearTimer: ExtensionContext["clearTimer"];
}

export interface StatusQuotaSource {
  snapshot(): QuotaState;
  refresh(signal?: AbortSignal): Promise<unknown>;
}

export interface StatusDisplay {
  bind(ctx: StatusContext): void;
  refresh(): Promise<void>;
  dispose(): void;
}

function count(value: number | undefined): string {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString("en-US") : "unknown";
}

function label(value: string): string {
  // Do not let CLI-controlled labels emit terminal escapes, new lines or bidi controls.
  return value.slice(0, 256).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, 24) || "unnamed group";
}

/** Rendering uses live ownership evidence, never discovery's retained diagnostic snapshot. */
export function renderStatus(
  model: NonNullable<StatusContext["model"]>, sessionId: string,
  state: ProviderDisplayState | undefined,
): string {
  const owned = state && (state.phase === "active" || state.phase === "idle") &&
    Number.isSafeInteger(state.generation) && state.generation >= 0 &&
    state.sessionId === sessionId && !!sessionId && state.modelId === model.id;
  const usage = owned ? state.contextUsage : undefined;
  const validUsage = usage && Number.isSafeInteger(usage.used) && usage.used >= 0 && Number.isSafeInteger(usage.size) && usage.size > 0;
  const context = validUsage ? `${count(usage.used)}/${count(usage.size)} native` : "pending (unknown)";
  return `AGY ctx ${context} | OMP ${typeof model.contextWindow === "number" && model.contextWindow > 0 ? count(model.contextWindow) : "unknown"}`;
}

/** Account group quotas belong in separate rows, not a truncated low-priority status segment. */
export function renderQuotaWidget(quota: QuotaState, now: number): string[] {
  if (quota.status !== "ready") return [`AGY /usage quota ${quota.status === "loading" ? "pending" : "unavailable"} (age unknown)`];
  const snapshot = quota.snapshot;
  const age = now - snapshot.fetchedAt;
  if (!Number.isFinite(age) || age < 0 || age >= QUOTA_FRESHNESS_MS) {
    return [`AGY /usage quota stale (${Number.isFinite(age) && age >= 0 ? `${Math.floor(age / 60_000)}m old` : "age unknown"})`];
  }
  const groups = snapshot.groups.slice(0, MAX_GROUPS).map(group => {
    const windows = (["five_hour", "weekly"] as const).map(window => {
      const name = window === "five_hour" ? "5h" : "week";
      const buckets = group.buckets.filter(bucket => bucket.window === window);
      // An absent, ambiguous or expired bucket is not zero remaining.
      if (!buckets.length) return `${name} not reported`;
      if (buckets.length !== 1) return `${name} unknown`;
      const bucket = buckets[0]!;
      if (!Number.isFinite(bucket.remainingFraction) || bucket.remainingFraction < 0 || bucket.remainingFraction > 1 ||
          !Number.isFinite(bucket.resetAt) || !Number.isFinite(new Date(bucket.resetAt).getTime())) return `${name} unknown`;
      if (bucket.resetAt <= now) return `${name} unknown (reset due)`;
      const minutes = Math.ceil((bucket.resetAt - now) / 60_000);
      const days = Math.floor(minutes / 1440);
      const hours = Math.floor((minutes % 1440) / 60);
      const reset = days ? `${days}d${hours ? `${hours}h` : ""}`
        : hours ? `${hours}h${minutes % 60 ? `${minutes % 60}m` : ""}` : `${minutes}m`;
      return `${name} ${Math.round(bucket.remainingFraction * 100)}% reset in ${reset}`;
    });
    return `${label(group.label)}: ${windows.join(" | ")}`;
  });
  if (!groups.length) groups.push("5h unknown, week unknown");
  const overflow = snapshot.groups.length > MAX_GROUPS ? `; +${snapshot.groups.length - MAX_GROUPS} groups` : "";
  // Groups are official account groups, not a guessed match to the selected model.
  return [`AGY /usage remaining (<1m old${overflow})`, ...groups];
}

/** One factory-local attachment; the 1s timer does no WSL work between quota deadlines. */
export function createStatusDisplay(
  readState: () => ProviderDisplayState | undefined, quotaSource: StatusQuotaSource,
  options: { now?: () => number } = {},
): StatusDisplay {
  const now = options.now ?? Date.now;
  let context: StatusContext | undefined;
  let timer: Timer | undefined;
  let text: string | undefined;
  let widgetText: string | undefined;
  let lastAttempt = -Infinity;
  let request: AbortController | undefined;
  let pending: Promise<void> | undefined;

  function publish(value: string | undefined, rows?: string[]): void {
    if (!context) return;
    if (value !== text) {
      context.ui.setStatus(STATUS_KEY, value);
      text = value;
    }
    const nextWidgetText = rows?.join("\n");
    if (nextWidgetText !== widgetText) {
      context.ui.setWidget(QUOTA_WIDGET_KEY, rows);
      widgetText = nextWidgetText;
    }
  }
  function abort(): void {
    const owner = request;
    if (!owner) return; // Completed successes/failures retain their normal cooldown.
    request = undefined;
    pending = undefined;
    lastAttempt = -Infinity;
    // Release ownership before dispatching abort callbacks; old completions must
    // never clear a replacement request or reset its attempt timestamp.
    owner.abort();
  }
  function paint(): void {
    if (!context) return;
    const model = context.model;
    if (!context.hasUI || context.agent.kind !== "main" || !model || model.provider !== PROVIDER_ID) { abort(); publish(undefined); return; }
    publish(renderStatus(model, context.sessionManager.getSessionId(), readState()), renderQuotaWidget(quotaSource.snapshot(), now()));
  }
  function refresh(): Promise<void> {
    if (!context) return Promise.resolve();
    const model = context.model;
    if (!context.hasUI || context.agent.kind !== "main" || !model || model.provider !== PROVIDER_ID) { paint(); return Promise.resolve(); }
    const time = now();
    if (!request && time - lastAttempt >= QUOTA_FRESHNESS_MS) {
      lastAttempt = time;
      const owner = new AbortController();
      request = owner;
      // Failure is surfaced by the source as unavailable; retry only on the next deadline.
      pending = Promise.resolve().then(() => {
        if (!context?.hasUI || context.agent.kind !== "main" || context.model?.provider !== PROVIDER_ID) { paint(); return; }
        if (!owner.signal.aborted) {
          const result = quotaSource.refresh(owner.signal);
          paint();
          return result.then(() => {});
        }
      }).catch(() => {}).finally(() => {
        if (request !== owner) return;
        request = undefined;
        pending = undefined;
        paint();
      });
    }
    paint();
    return pending ?? Promise.resolve();
  }
  function dispose(): void {
    abort();
    if (context && timer !== undefined) context.clearTimer(timer);
    timer = undefined;
    publish(undefined);
    context = undefined;
    text = undefined;
    widgetText = undefined;
  }
  return {
    bind(ctx): void {
      dispose();
      if (!ctx.hasUI || ctx.agent.kind !== "main") return;
      context = ctx;
      timer = ctx.setInterval(() => { void refresh(); }, 1000);
      void refresh();
    },
    refresh,
    dispose,
  };
}
