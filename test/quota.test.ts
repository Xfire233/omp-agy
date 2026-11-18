import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { buildUsageReportText } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/usage-report";
import { createQuotaProvider, fetchQuota, parseQuota, QuotaReadError, type QuotaSnapshot, type QuotaState } from "../src/quota.ts";
import type { CleanupReport, PreparedRunner, RunnerEvidence } from "../src/runner.ts";
import type { UsageFetchContext, UsageFetchParams } from "@oh-my-pi/pi-ai";

// Synthetic copy of the allowlisted, observed 1.5.10 /usage contract.
function payload() {
  return { status: "SUCCESS", num_turns: 0, command: { name: "usage", data: { groups: [
    { name: "Gemini Models", buckets: [
      { window: "5h", remaining_fraction: 0.25, reset_time: "2026-11-18T04:00:00Z" },
      { window: "weekly", remaining_fraction: 0.5, reset_time: "2026-11-24T04:00:00Z" },
    ] },
    { name: "Gemini 4 Argon", buckets: [{ window: "weekly", remaining_fraction: 1, reset_time: "2026-11-24T04:00:00Z" }] },
  ] } } };
}

function ownedRunner(options: { text?: string; stream?: ReadableStream<Uint8Array>; exit?: number; stderr?: string; cleanup?: CleanupReport["status"] } = {}) {
  let starts = 0, stops = 0, acpStarts = 0;
  const evidence = { version: "1.5.10", stderr: options.stderr ?? "" } as RunnerEvidence;
  const stdout = options.stream ?? new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode(options.text ?? JSON.stringify(payload())));
    controller.close();
  } });
  const stop = async (): Promise<CleanupReport> => {
    stops++;
    return { status: options.cleanup ?? "stopped", generation: "owned", workers: [], errors: [], producerExit: options.exit ?? 0 };
  };
  const prepared: PreparedRunner = {
    gateway: "192.0.2.1", sourceAddress: "192.0.2.2", workspace: "/private/workspace", evidence, stop,
    async start() { acpStarts++; throw new Error("quota must not start ACP"); },
    async startUsage() { starts++; return { stdout, exited: Promise.resolve(options.exit ?? 0), evidence, stop }; },
  };
  return { prepared, counts: () => ({ starts, stops, acpStarts }) };
}

const now = Date.parse("2026-11-18T00:00:00Z");

describe("observed official print quota parser", () => {
  test("retains only group labels and quota metadata, without token-derived values or fake windows", () => {
    const raw = { ...payload(), email: "private@example.invalid", account_id: "private-account", response: "private-message", usage: { total_tokens: 999999 } };
    const snapshot = parseQuota(raw, "1.5.10", now);
    expect(snapshot.source).toBe("agy-print-usage");
    expect(snapshot.groups[0]?.buckets[0]).toEqual({ window: "five_hour", remainingFraction: 0.25, resetAt: Date.parse("2026-11-18T04:00:00Z") });
    expect(snapshot.groups[1]?.buckets).toHaveLength(1);
    expect(snapshot.groups[1]?.buckets[0]?.window).toBe("weekly");
    expect(JSON.stringify(snapshot)).not.toMatch(/private|total_tokens|modelIds|response/);
  });

  test("rejects missing groups, unsuccessful results and accidental generative output", () => {
    for (const raw of [{ usage: { used: 12, size: 100 } }, { ...payload(), status: "ERROR" }, { ...payload(), num_turns: 1 }, { ...payload(), command: { data: { groups: [] } } }]) {
      expect(() => parseQuota(raw, "1.5.10", now)).toThrow("schema");
    }
  });

  test("rejects invalid fraction, reset, window, labels and duplicate windows", () => {
    for (const value of [-0.1, 1.1, NaN, Infinity, "0.5", null]) {
      const raw = payload(); Object.assign(raw.command.data.groups[0]!.buckets[0]!, { remaining_fraction: value });
      expect(() => parseQuota(raw, "1.5.10", now)).toThrow("schema");
    }
    for (const changes of [{ reset_time: "tomorrow" }, { reset_time: "2026-11-18T04:00:00" }, { window: "unknown" }, { disabled: true }]) {
      const raw = payload(); Object.assign(raw.command.data.groups[0]!.buckets[0]!, changes);
      expect(() => parseQuota(raw, "1.5.10", now)).toThrow("schema");
    }
    const duplicate = payload(); duplicate.command.data.groups[0]!.buckets.push(duplicate.command.data.groups[0]!.buckets[0]!);
    expect(() => parseQuota(duplicate, "1.5.10", now)).toThrow("schema");
    const privateLabel = payload(); privateLabel.command.data.groups[0]!.name = "private@example.invalid";
    expect(() => parseQuota(privateLabel, "1.5.10", now)).toThrow("schema");
  });
});

describe("owned quota read lifecycle", () => {
  test("starts only fixed usage producer and requires cleanup before publishing success", async () => {
    const owned = ownedRunner();
    const result = await fetchQuota({}, undefined, { bootstrap: async () => owned.prepared, now: () => now });
    expect(result.groups).toHaveLength(2);
    expect(owned.counts()).toEqual({ starts: 1, stops: 1, acpStarts: 0 });
  });

  test("rejects alternate account before bootstrapping instead of reporting the HOME account", async () => {
    let bootstraps = 0;
    await expect(fetchQuota({ accountDirectory: "/home/agy/other-account" }, undefined, { bootstrap: async () => { bootstraps++; return ownedRunner().prepared; } })).rejects.toThrow("different account");
    expect(bootstraps).toBe(0);
  });

  test("invalid JSON and byte overflow both stop owned Linux producer", async () => {
    for (const text of ["not JSON", "x".repeat(262_145)]) {
      const owned = ownedRunner({ text });
      await expect(fetchQuota({}, undefined, { bootstrap: async () => owned.prepared })).rejects.toThrow(QuotaReadError);
      expect(owned.counts().stops).toBe(1);
    }
  });

  test("retains useful CLI failure class but never raw diagnostic credentials", async () => {
    const owned = ownedRunner({ text: "", exit: 2, stderr: "flag provided but not defined: --gemini-dir private@example.invalid access_token=secret" });
    const error = await fetchQuota({}, undefined, { bootstrap: async () => owned.prepared }).catch(error => error);
    expect(error.message).toContain("unsupported CLI flags");
    expect(error.message).not.toMatch(/secret|private@|access_token/);
    expect(owned.counts().stops).toBe(1);
  });

  test("an external abort stops Linux even when stdout never closes", async () => {
    const cancelled = { value: false };
    const owned = ownedRunner({ stream: new ReadableStream({ cancel() { cancelled.value = true; } }) });
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const request = fetchQuota({}, controller.signal, { bootstrap: async () => { started.resolve(); return owned.prepared; } });
    await started.promise;
    await Promise.resolve();
    controller.abort();
    await expect(request).rejects.toThrow("cancelled");
    expect(owned.counts().stops).toBe(1);
    expect(cancelled.value).toBe(true);
  });

  test("deadline stops a silent producer, and cleanup failure overrides success", async () => {
    const silent = ownedRunner({ stream: new ReadableStream() });
    await expect(fetchQuota({}, undefined, { bootstrap: async () => silent.prepared, deadlineMs: 5 })).rejects.toThrow("deadline");
    expect(silent.counts().stops).toBe(1);
    const failed = ownedRunner({ cleanup: "cleanup_failed" });
    await expect(fetchQuota({}, undefined, { bootstrap: async () => failed.prepared, now: () => now })).rejects.toThrow("cleanup_failed");
  });
});

describe("on-demand OMP quota provider", () => {
  test("construction is inert, concurrent reads coalesce, and fresh reads do not launch again", async () => {
    let reads = 0;
    const updates: QuotaState[] = [];
    const deferred = Promise.withResolvers<QuotaSnapshot>();
    const provider = createQuotaProvider({}, { now: () => now, onUpdate: state => updates.push(state), fetch: async () => { reads++; return deferred.promise; } });
    expect(reads).toBe(0);
    const one = provider.refresh(), two = provider.refresh();
    await Promise.resolve();
    expect(reads).toBe(1);
    deferred.resolve(parseQuota(payload(), "1.5.10", now));
    expect(await one).toEqual(await two);
    await provider.refresh();
    expect(reads).toBe(1);
    expect(updates.map(state => state.status)).toEqual(["loading", "ready"]);
  });

  test("stale reading and failed refresh are unavailable; no automatic retry or last-good retention", async () => {
    let clock = now, reads = 0;
    const provider = createQuotaProvider({}, { now: () => clock, fetch: async () => {
      reads++;
      if (reads > 1) throw new QuotaReadError("AGY quota unavailable: authentication required");
      return parseQuota(payload(), "1.5.10", clock);
    } });
    await provider.refresh();
    clock += 60_001;
    expect(provider.snapshot().status).toBe("unavailable");
    await expect(provider.refresh()).rejects.toThrow("authentication required");
    expect(provider.snapshot()).toEqual({ status: "unavailable", reason: "AGY quota unavailable: authentication required" });
    expect(reads).toBe(2);
    expect(provider.retainLastGoodOnFailure).toBe(false);
  });

  test("aborting the originating caller cancels the owned read and clears current state", async () => {
    let reads = 0;
    const provider = createQuotaProvider({}, { fetch: async (_config, signal) => {
      reads++;
      const { promise, reject } = Promise.withResolvers<QuotaSnapshot>();
      if (signal?.aborted) reject(new QuotaReadError("AGY quota read cancelled"));
      else signal?.addEventListener("abort", () => reject(new QuotaReadError("AGY quota read cancelled")), { once: true });
      return promise;
    } });
    const controller = new AbortController();
    const one = provider.refresh(controller.signal), two = provider.refresh();
    await Promise.resolve();
    controller.abort();
    await expect(one).rejects.toThrow("cancelled");
    await expect(two).rejects.toThrow("cancelled");
    expect(reads).toBe(1);
    expect(provider.snapshot().status).toBe("unavailable");
  });

  test("a replacement caller waits for cancelled producer cleanup, then owns a fresh read", async () => {
    const cancelled = Promise.withResolvers<QuotaSnapshot>();
    const replacement = Promise.withResolvers<QuotaSnapshot>();
    const signals: AbortSignal[] = [];
    const provider = createQuotaProvider({}, { now: () => now, fetch: async (_config, signal) => {
      signals.push(signal!);
      return signals.length === 1 ? cancelled.promise : replacement.promise;
    } });
    const owner = new AbortController();
    const first = provider.refresh(owner.signal);
    const firstFailure = first.then(() => undefined, error => error);
    await Promise.resolve();
    owner.abort();
    const second = provider.refresh();
    await Promise.resolve();
    expect(signals).toHaveLength(1); // No overlap while the old producer is cleaning up.
    cancelled.reject(new QuotaReadError("AGY quota read cancelled"));
    expect(await firstFailure).toBeInstanceOf(QuotaReadError);
    expect((await firstFailure).message).toContain("cancelled");
    // Joining again must coalesce with the replacement rather than the cancelled producer.
    const joined = provider.refresh();
    replacement.resolve(parseQuota(payload(), "1.5.10", now));
    expect(await second).toEqual(await joined);
    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
    expect(provider.snapshot().status).toBe("ready");
  });
  test("switching accounts discards even a fresh quota reading", async () => {
    let next = 0;
    const provider = createQuotaProvider({}, { now: () => now, fetch: async () => {
      const data = payload(); data.command.data.groups[0]!.buckets[0]!.remaining_fraction = ++next / 10;
      return parseQuota(data, "1.5.10", now);
    } });
    expect((await provider.refresh()).groups[0]!.buckets[0]!.remainingFraction).toBe(0.1);
    await provider.invalidate(); expect(provider.snapshot().status).toBe("unavailable");
    expect((await provider.refresh()).groups[0]!.buckets[0]!.remainingFraction).toBe(0.2);
  });

  test("a joining UI signal cannot abort another caller's owned quota producer", async () => {
    const deferred = Promise.withResolvers<QuotaSnapshot>();
    let producerSignal: AbortSignal | undefined;
    const provider = createQuotaProvider({}, { now: () => now, fetch: async (_config, signal) => {
      producerSignal = signal;
      return deferred.promise;
    } });
    const owner = provider.refresh();
    const ui = new AbortController();
    const joined = provider.refresh(ui.signal);
    await Promise.resolve();
    ui.abort();
    expect(producerSignal?.aborted).toBe(false);
    deferred.resolve(parseQuota(payload(), "1.5.10", now));
    expect(await joined).toEqual(await owner);
    expect(provider.snapshot().status).toBe("ready");
  });

  test("native usage report maps official group windows and ignores placeholder host credentials", async () => {
    const provider = createQuotaProvider({}, { now: () => now, fetch: async () => parseQuota(payload(), "1.5.10", now) });
    const report = await provider.fetchUsage({ provider: "omp-agy", credential: { type: "api_key", apiKey: "official-cli-session" } } as UsageFetchParams, {} as UsageFetchContext);
    expect(report?.limits).toHaveLength(3);
    expect(report?.limits[0]?.amount).toEqual({ unit: "percent", remainingFraction: 0.25, usedFraction: 0.75 });
    expect(report?.limits[0]?.window?.durationMs).toBe(18_000_000);
    expect(report?.limits[1]?.window?.durationMs).toBe(604_800_000);
    expect(report?.raw).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain("official-cli-session");
  });

  test("real OMP auth, registry and /usage renderer retain every group window and used bar", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omp-agy-quota-host-"));
    const auth = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), {
      usageProviderResolver: () => undefined, // Runtime registration only; never poll ambient credentials.
    });
    const registry = new ModelRegistry(auth, join(directory, "models.yml"), {
      ignoreLocalModelConfig: true, cacheDbPath: join(directory, "models.db"),
    });
    let reads = 0;
    try {
      const fetchedAt = Date.now() - 61_000;
      let clock = fetchedAt;
      const raw = payload();
      raw.command.data.groups[0]!.buckets[0]!.remaining_fraction = 0.75;
      const provider = createQuotaProvider({}, { now: () => clock, fetch: async () => {
        reads++;
        return parseQuota(raw, "1.5.10", fetchedAt);
      } });
      registry.registerProvider("omp-agy", { apiKey: "official-cli-session", usage: provider });
      const runtime = { session: {
        modelRegistry: registry, model: { provider: "omp-agy" }, sessionId: "quota-host-regression",
        fetchUsageReports: () => auth.usage.reports(),
      } } as unknown as Parameters<typeof buildUsageReportText>[0];
      const rendered = Bun.stripANSI(await buildUsageReportText(runtime));
      // Advance only the local snapshot clock; OMP retains the serialized report.
      clock += 61_000;
      expect(provider.snapshot().status).toBe("unavailable");
      const cached = Bun.stripANSI(await buildUsageReportText(runtime));
      expect(cached).toContain(`AGY quota read: ${new Date(fetchedAt).toISOString()}`);
      expect(cached).toContain("OMP can cache this beyond the widget's 60s limit.");
      expect(reads).toBe(1);
      expect(rendered).toContain("- Gemini Models · 5 Hour");
      expect(rendered).toContain("- Gemini Models · Weekly");
      expect(rendered).toContain("- Gemini 4 Argon · Weekly");
      expect(rendered).toContain("25.00% used (75.0% left)");
      expect(rendered).toContain("50.00% used (50.0% left)");
      expect(rendered).toContain("0.00% used (100.0% left)");
      expect(rendered).toContain(`[${"█".repeat(6)}${"░".repeat(18)}] 25%`);
      expect(rendered).toContain(`[${"█".repeat(12)}${"░".repeat(12)}] 50%`);
      expect(rendered).not.toContain("unknown used");
      expect(rendered).not.toContain(`[${"·".repeat(24)}]`);
      expect(rendered).not.toContain("official-cli-session");
    } finally {
      registry.unregisterProvider("omp-agy");
      auth.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
