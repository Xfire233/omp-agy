import { describe, expect, test } from "bun:test";
import type { ProviderDisplayState } from "../src/provider.ts";
import { createQuotaProvider, parseQuota, QuotaReadError, type QuotaSnapshot, type QuotaState } from "../src/quota.ts";
import { createStatusDisplay, renderQuotaWidget, renderStatus, STATUS_KEY, QUOTA_WIDGET_KEY, type StatusContext, type StatusQuotaSource } from "../src/status.ts";

const NOW = Date.UTC(2026, 10, 18, 12, 0);
const MODEL = { provider: "omp-agy", id: "exact-live-model", contextWindow: 400_000 };
const CURRENT: ProviderDisplayState = {
  generation: 3, sessionId: "main-session", modelId: MODEL.id, phase: "idle", contextUsage: { used: 123_456, size: 1_048_576 },
};
const UNAVAILABLE: QuotaState = { status: "unavailable", reason: "private CLI diagnostics must not reach UI" };

function ready(fetchedAt = NOW): QuotaState {
  return { status: "ready", snapshot: {
    source: "agy-print-usage", fetchedAt, cliVersion: "1.5.10",
    groups: [{ id: "official-group-id", label: "Official group", buckets: [
      { window: "five_hour", remainingFraction: 0.75, resetAt: NOW + 5 * 60 * 60_000 },
      { window: "weekly", remainingFraction: 0.5, resetAt: NOW + 7 * 24 * 60 * 60_000 },
    ] }],
  } };
}

function host() {
  let time = NOW;
  let currentModel: StatusContext["model"] = { ...MODEL };
  let sessionId = "main-session";
  const changes: (string | undefined)[] = [];
  const widgetChanges: (string[] | undefined)[] = [];
  let visibleWidget: string[] | undefined;
  const callbacks = new Map<Timer, () => void>();
  const ctx: StatusContext = {
    hasUI: true, agent: { kind: "main" },
    get model() { return currentModel; },
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      setStatus(key, text) { expect(key).toBe(STATUS_KEY); changes.push(text); },
      setWidget(key, content) {
        expect(key).toBe(QUOTA_WIDGET_KEY);
        if (content !== undefined && !Array.isArray(content)) throw new Error("quota widget must be plain bounded rows");
        widgetChanges.push(content);
        visibleWidget = content;
      },
    },
    setInterval(callback, delay) {
      expect(delay).toBe(1000);
      const handle = {} as Timer;
      callbacks.set(handle, () => callback());
      return handle;
    },
    clearTimer(handle) { callbacks.delete(handle); },
  };
  return {
    ctx, changes, widgetChanges, callbacks,
    now: () => time,
    model(model: StatusContext["model"]) { currentModel = model; },
    session(id: string) { sessionId = id; },
    tick(ms = 1000) { time += ms; for (const callback of [...callbacks.values()]) callback(); },
    text() { return changes.at(-1); },
    widget() { return visibleWidget?.join("\n"); },
    clearWidgets() { visibleWidget = undefined; },
  };
}


describe("AGY status rendering", () => {
  test("keeps ACP's native denominator distinct from the actual selected OMP budget", () => {
    const text = renderStatus(MODEL, "main-session", CURRENT);
    expect(text).toBe("AGY ctx 123,456/1,048,576 native | OMP 400,000");
    expect(text.length).toBeLessThan(64);
    expect(text).not.toContain("quota");
    expect(renderQuotaWidget(UNAVAILABLE, NOW).join("\n")).not.toContain("private CLI");
    expect(renderStatus({ ...MODEL, contextWindow: 131_072 }, "main-session", CURRENT)).toContain("OMP 131,072");
    expect(renderStatus({ ...MODEL, contextWindow: null }, "main-session", CURRENT)).toContain("OMP unknown");
  });

  test("unknown, unowned and invalid measurements are never rendered as zero", () => {
    const states: (ProviderDisplayState | undefined)[] = [
      undefined, { ...CURRENT, contextUsage: undefined }, { ...CURRENT, modelId: "another-model" },
      { ...CURRENT, sessionId: "child-session" }, { ...CURRENT, sessionId: undefined }, { ...CURRENT, generation: NaN },
      { ...CURRENT, contextUsage: { used: -1, size: 100 } }, { ...CURRENT, contextUsage: { used: 1, size: 0 } },
      { ...CURRENT, contextUsage: { used: Infinity, size: 100 } },
    ];
    for (const state of states) {
      const text = renderStatus(MODEL, "main-session", state);
      expect(text).toContain("ctx pending (unknown)");
      expect(text).not.toContain("123,456");
      expect(text).not.toContain("ctx 0/");
    }
    expect(renderStatus(MODEL, "main-session", { ...CURRENT, contextUsage: { used: 0, size: 100 } })).toContain("ctx 0/100 native");
  });

  test("renders official account groups, not guessed selected-model family membership", () => {
    const rows = renderQuotaWidget(ready(), NOW);
    expect(rows).toEqual(["AGY /usage remaining (<1m old)", "Official group: 5h 75% reset in 5h | week 50% reset in 7d"]);
    expect(rows.every(row => row.length < 100)).toBe(true);
    const quota = ready();
    if (quota.status !== "ready") throw new Error("fixture must be ready");
    quota.snapshot.groups[0]!.buckets[0]!.resetAt = NOW + 135 * 60_000;
    quota.snapshot.groups[0]!.buckets[1]!.resetAt = NOW + 74 * 60 * 60_000;
    expect(renderQuotaWidget(quota, NOW)[1]).toContain("reset in 2h15m | week 50% reset in 3d2h");
  });

  test("expired snapshots and expired or missing windows become explicitly stale or unknown", () => {
    const stale = renderQuotaWidget(ready(NOW - 60_000), NOW).join("\n");
    expect(stale).toContain("quota stale (1m old)");
    expect(stale).not.toContain("75%");
    expect(renderQuotaWidget(ready(NOW + 1), NOW).join("\n")).toContain("age unknown");
    const quota = ready();
    if (quota.status !== "ready") throw new Error("fixture must be ready");
    quota.snapshot.groups[0]!.buckets = [{ window: "five_hour", remainingFraction: 0, resetAt: NOW }];
    const expired = renderQuotaWidget(quota, NOW).join("\n");
    expect(expired).toContain("5h unknown (reset due) | week not reported");
    expect(expired).not.toContain("0%");
    expect(renderQuotaWidget({ status: "loading" }, NOW).join("\n")).toContain("quota pending");
    quota.snapshot.groups[0]!.label = "Gemini 4 Argon";
    quota.snapshot.groups[0]!.buckets = [{ window: "weekly", remainingFraction: 0.4, resetAt: NOW + 60_000 }];
    expect(renderQuotaWidget(quota, NOW).join("\n")).toContain("Gemini 4 Argon: 5h not reported | week 40% reset in 1m");
  });

  test("bounds and sanitizes CLI labels and avoids ambiguous quota buckets", () => {
    const quota = ready();
    if (quota.status !== "ready") throw new Error("fixture must be ready");
    const group = quota.snapshot.groups[0]!;
    group.label = "\u001b[31m\n\u202e" + "x".repeat(20_000);
    group.buckets.push({ ...group.buckets[0]! });
    quota.snapshot.groups = Array.from({ length: 100 }, () => group);
    const rows = renderQuotaWidget(quota, NOW);
    const text = rows.join("\n");
    expect(rows.every(row => !/[\u0000-\u001f\u202e]/.test(row))).toBe(true);
    expect(rows.length).toBe(4);
    expect(text.length).toBeLessThan(400);
    expect(text).toContain("5h unknown");
    expect(text).toContain("+97 groups");
  });
});

describe("session status attachment", () => {
  test("tracks idle live model and session changes, deduplicates updates and clears non-AGY selection", async () => {
    const view = host();
    let state: ProviderDisplayState | undefined = CURRENT;
    const display = createStatusDisplay(() => state, { snapshot: () => UNAVAILABLE, refresh: async () => {} }, { now: view.now });
    display.bind(view.ctx);
    await display.refresh();
    expect(view.text()).toContain("123,456/1,048,576");
    const initialChanges = view.changes.length;
    const initialWidgets = view.widgetChanges.length;
    view.tick();
    expect(view.changes.length).toBe(initialChanges);
    expect(view.widgetChanges.length).toBe(initialWidgets);
    view.model({ ...MODEL, id: "another-model", contextWindow: 131_072 });
    view.tick();
    expect(view.text()).toContain("ctx pending (unknown) | OMP 131,072");
    state = { ...CURRENT, generation: 4, modelId: "another-model", contextUsage: { used: 42, size: 131_072 } };
    await display.refresh();
    expect(view.text()).toContain("ctx 42/131,072");
    view.session("another-session");
    view.tick();
    expect(view.text()).toContain("ctx pending (unknown)");
    state = undefined; // A stopped runtime never falls back to discovery/previous generation.
    view.model({ ...MODEL, provider: "another-provider" });
    view.tick();
    expect(view.text()).toBeUndefined();
    expect(view.widget()).toBeUndefined();
    const clearedChanges = view.changes.length;
    view.tick();
    expect(view.changes.length).toBe(clearedChanges);
    display.dispose();
    expect(view.callbacks.size).toBe(0);
  });

  test("never starts quota or timers for hidden UI or child factories, nor quota for non-AGY", async () => {
    let attempts = 0;
    const source: StatusQuotaSource = { snapshot: () => UNAVAILABLE, refresh: async () => { attempts++; } };
    for (const mode of ["hidden", "child", "other"] as const) {
      const view = host();
      if (mode === "hidden") view.ctx.hasUI = false;
      if (mode === "child") view.ctx.agent.kind = "sub";
      if (mode === "other") view.model({ ...MODEL, provider: "other" });
      const display = createStatusDisplay(() => CURRENT, source, { now: view.now });
      display.bind(view.ctx);
      await display.refresh();
      view.tick(120_000);
      await display.refresh();
      expect(attempts).toBe(0);
      expect(view.changes).toEqual([]);
      expect(view.widgetChanges).toEqual([]);
      expect(view.callbacks.size).toBe(mode === "other" ? 1 : 0);
      display.dispose();
    }
  });

  test("rechecks the selected main UI before deferred quota startup", async () => {
    for (const deselect of ["model", "hidden"] as const) {
      const view = host();
      let attempts = 0;
      const display = createStatusDisplay(() => CURRENT, {
        snapshot: () => UNAVAILABLE, refresh: async () => { attempts++; },
      }, { now: view.now });
      display.bind(view.ctx);
      const request = display.refresh();
      if (deselect === "model") view.model({ ...MODEL, provider: "other" });
      else view.ctx.hasUI = false;
      await request;
      expect(attempts).toBe(0);
      expect(view.text()).toBeUndefined();
      expect(view.widget()).toBeUndefined();
      display.dispose();
    }
  });

  test("refreshes quota at most once per minute including failures, with no immediate replay", async () => {
    const view = host();
    let attempts = 0;
    let quota = ready();
    const source: StatusQuotaSource = {
      snapshot: () => quota,
      async refresh() {
        attempts++;
        quota = attempts === 1 ? ready(view.now()) : UNAVAILABLE;
        if (attempts !== 1) throw new Error("quota source failure");
      },
    };
    const display = createStatusDisplay(() => CURRENT, source, { now: view.now });
    display.bind(view.ctx);
    await display.refresh();
    expect(attempts).toBe(1);
    expect(view.widget()).toContain("5h 75% reset");
    for (let i = 0; i < 59; i++) view.tick();
    await display.refresh();
    expect(attempts).toBe(1);
    view.tick();
    await display.refresh();
    expect(attempts).toBe(2);
    expect(view.widget()).toContain("quota unavailable");
    for (let i = 0; i < 10; i++) await display.refresh();
    expect(attempts).toBe(2);
    view.tick(60_000);
    await display.refresh();
    expect(attempts).toBe(3);
    display.dispose();
  });

  test("model switches and rebinds allow retry within 1s; stale completion cannot clear the new owner", async () => {
    for (const transition of ["model", "rebind"] as const) {
      for (const outcome of ["resolve", "reject"] as const) {
        const view = host();
        const signals: AbortSignal[] = [];
        const first = Promise.withResolvers<void>();
        const second = Promise.withResolvers<void>();
        const started = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
        const source: StatusQuotaSource = {
          snapshot: () => UNAVAILABLE,
          refresh(signal) {
            signals.push(signal!);
            started[signals.length - 1]!.resolve();
            return signals.length === 1 ? first.promise : second.promise;
          },
        };
        const display = createStatusDisplay(() => CURRENT, source, { now: view.now });
        display.bind(view.ctx);
        const oldRequest = display.refresh();
        await started[0]!.promise;
        if (transition === "model") {
          view.model({ ...MODEL, provider: "other" });
          await display.refresh();
          view.tick();
          view.model(MODEL);
        } else {
          view.tick();
          display.bind(view.ctx);
        }
        const newRequest = display.refresh();
        await started[1]!.promise;
        expect(signals[0]!.aborted).toBe(true);
        expect(signals[1]!.aborted).toBe(false);
        expect(view.now() - NOW).toBe(1000);
        if (outcome === "resolve") first.resolve();
        else first.reject(new Error("late cancelled attempt"));
        await oldRequest;
        expect(display.refresh()).toBe(newRequest);
        view.tick(60_000);
        expect(display.refresh()).toBe(newRequest);
        expect(signals).toHaveLength(2);
        expect(view.widget()).toContain("quota unavailable");
        second.resolve();
        await newRequest;
        display.dispose();
      }
    }
  });

  test("real quota provider defers immediate retry until cancelled cleanup and then refreshes", async () => {
    const view = host();
    const cleanup = Promise.withResolvers<QuotaSnapshot>();
    const started = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const signals: AbortSignal[] = [];
    const source = createQuotaProvider({}, { now: view.now, fetch: async (_config, signal) => {
      signals.push(signal!);
      started[signals.length - 1]!.resolve();
      if (signals.length === 1) return cleanup.promise;
      return parseQuota({ status: "SUCCESS", command: { data: { groups: [{ name: "Official group", buckets: [
        { window: "5h", remaining_fraction: 0.75, reset_time: "2026-11-18T17:00:00Z" },
      ] }] } } }, "1.5.10", view.now());
    } });
    const display = createStatusDisplay(() => CURRENT, source, { now: view.now });
    display.bind(view.ctx);
    const oldRequest = display.refresh();
    await started[0]!.promise;
    view.model({ ...MODEL, provider: "other" });
    await display.refresh();
    view.tick();
    view.model(MODEL);
    const newRequest = display.refresh();
    await Promise.resolve();
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(true);
    cleanup.reject(new QuotaReadError("AGY quota read cancelled"));
    await started[1]!.promise;
    await oldRequest;
    await newRequest;
    expect(signals).toHaveLength(2);
    expect(signals[1]!.aborted).toBe(false);
    expect(view.widget()).toContain("5h 75% reset in 5h");
    expect(view.now() - NOW).toBe(1000);
    display.dispose();
  });

  test("completed true failures keep their 60s cooldown across selection changes and rebinding", async () => {
    const view = host();
    let attempts = 0;
    const display = createStatusDisplay(() => CURRENT, {
      snapshot: () => UNAVAILABLE,
      async refresh() { attempts++; throw new Error("true quota failure"); },
    }, { now: view.now });
    display.bind(view.ctx);
    await display.refresh();
    view.model({ ...MODEL, provider: "other" });
    await display.refresh();
    view.tick();
    view.model(MODEL);
    display.bind(view.ctx);
    await display.refresh();
    expect(attempts).toBe(1);
    view.tick(58_999);
    await display.refresh();
    expect(attempts).toBe(1);
    view.tick(1);
    await display.refresh();
    expect(attempts).toBe(2);
    display.dispose();
  });

  test("aborts owned quota requests on non-AGY selection and dispose; late completion cannot resurrect status", async () => {
    const view = host();
    const signals: AbortSignal[] = [];
    const completions: (() => void)[] = [];
    const starts = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const source: StatusQuotaSource = {
      snapshot: () => UNAVAILABLE,
      refresh(signal) {
        signals.push(signal!);
        const completion = Promise.withResolvers<void>();
        completions.push(completion.resolve);
        starts[signals.length - 1]!.resolve();
        return completion.promise;
      },
    };
    const display = createStatusDisplay(() => CURRENT, source, { now: view.now });
    display.bind(view.ctx);
    const firstRequest = display.refresh();
    await starts[0]!.promise;
    expect(signals.length).toBe(1);
    view.model({ ...MODEL, provider: "other" });
    view.tick();
    expect(signals[0]!.aborted).toBe(true);
    expect(view.text()).toBeUndefined();
    expect(view.widget()).toBeUndefined();
    completions[0]!();
    await firstRequest;
    expect(view.text()).toBeUndefined();
    view.model(MODEL);
    view.tick(60_000);
    const secondRequest = display.refresh();
    await starts[1]!.promise;
    expect(signals.length).toBe(2);
    display.dispose();
    expect(signals[1]!.aborted).toBe(true);
    expect(view.callbacks.size).toBe(0);
    completions[1]!();
    await secondRequest;
    expect(view.text()).toBeUndefined();
    expect(view.widget()).toBeUndefined();
  });

  test("rebinding clears the former attachment and reads only the new canonical host", async () => {
    const first = host();
    const second = host();
    const display = createStatusDisplay(() => CURRENT, { snapshot: () => UNAVAILABLE, refresh: async () => {} }, { now: first.now });
    display.bind(first.ctx);
    await display.refresh();
    display.bind(second.ctx);
    expect(first.text()).toBeUndefined();
    expect(first.widget()).toBeUndefined();
    expect(first.callbacks.size).toBe(0);
    expect(second.text()).toContain("123,456/1,048,576");
    first.model({ ...MODEL, provider: "other" });
    first.tick();
    expect(second.text()).toContain("123,456/1,048,576");
    display.dispose();
  });

  test("history rebinding restores externally cleared unchanged quota rows with current session ownership", async () => {
    const view = host();
    let state: ProviderDisplayState | undefined = CURRENT;
    const quota = ready();
    const display = createStatusDisplay(() => state, {
      snapshot: () => quota, refresh: async () => {},
    }, { now: view.now });
    display.bind(view.ctx);
    await display.refresh();
    const cachedRows = view.widget();
    expect(cachedRows).toContain("Official group: 5h 75%");

    // The TUI clears its widget container independently before history navigation.
    view.clearWidgets();
    await display.refresh();
    expect(view.widget()).toBeUndefined();

    const nextContext: StatusContext = Object.create(view.ctx);
    nextContext.sessionManager = { getSessionId: () => "next-session" };
    state = undefined; // Runtime.stop has discarded the old activation.
    display.bind(nextContext);
    await display.refresh();
    expect(view.widget()).toBe(cachedRows);
    expect(view.text()).toContain("ctx pending (unknown)");
    expect(view.callbacks.size).toBe(1);

    state = { ...CURRENT, generation: 4, sessionId: "next-session", contextUsage: { used: 99, size: 1_048_576 } };
    await display.refresh();
    expect(view.text()).toContain("ctx 99/1,048,576 native");
    expect(view.text()).not.toContain("123,456");
    expect(view.widget()).toBe(cachedRows);
    display.dispose();
    expect(view.widget()).toBeUndefined();
    expect(view.callbacks.size).toBe(0);
  });
});
