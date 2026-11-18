import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bootstrapRunner, resetRunner, runnerCapabilities, type RunnerConfig, type RunnerStartOptions } from "../src/runner.ts";

const posix = process.platform === "linux" || process.platform === "darwin";
const token = "fixture_not_a_real_credential_with_32_bytes";
const settings: RunnerStartOptions = { url: "http://127.0.0.1:45678/mcp", token, aliases: ["read_file"], profile: "custom-clean" };

async function nativeFixture(run: (config: RunnerConfig, account: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "omp-agy-native-fixture-"));
  try {
    const cli = join(root, "fixture cli [no glob]");
    const account = join(root, "existing account");
    await mkdir(account, { mode: 0o700 });
    await writeFile(join(account, "untouched"), "fixture account state", { mode: 0o600 });
    await writeFile(cli, String.raw`#!/bin/sh
printf '%s\n' "$@" > argv
printf '%s\n' "$HOME" > home
printf 'fixture stderr is never retained\n' >&2
while IFS= read -r line; do printf '%s\n' "$line"; done
`, { mode: 0o700 });
    await run({ mode: "native", cli, accountDirectory: account, startupTimeoutMs: 2000, cleanupTimeoutMs: 2000 }, await realpath(account));
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("native capability gating never invokes WSL reset", async () => {
  expect(runnerCapabilities()).toEqual({ quota: true, reset: true });
  expect(runnerCapabilities({ mode: "native" })).toEqual({ quota: false, reset: false });
  await expect(resetRunner({ mode: "native" })).rejects.toThrow("unavailable in native mode");
  await expect(bootstrapRunner({ mode: "auto" as "native" })).rejects.toThrow("Unknown runner mode");
});

test.skipIf(!posix)("native requires absolute executable and account paths and rejects WSL overrides", async () => {
  await expect(bootstrapRunner({ mode: "native", cli: "agy" })).rejects.toThrow("explicit absolute cli");
  await expect(bootstrapRunner({ mode: "native", cli: "/explicit/bin/agy" })).rejects.toThrow("explicit absolute accountDirectory");
  await expect(bootstrapRunner({ mode: "native", distribution: "fixture" })).rejects.toThrow("does not accept WSL");
  await expect(bootstrapRunner()).rejects.toThrow("no local fallback");
});

test.skipIf(posix)("native rejects unsupported platforms instead of falling back", async () => {
  await expect(bootstrapRunner({ mode: "native" })).rejects.toThrow("supported only on Linux and macOS; no fallback");
});

for (const profile of ["custom-clean", "default-agy", "omp-system"] as const) {
  test.skipIf(!posix)(`native ${profile} stages private settings, streams ACP bytes and removes its transient tree`, async () => {
    await nativeFixture(async (config, account) => {
      const prepared = await bootstrapRunner(config);
      const root = dirname(prepared.workspace);
      const gemini = join(prepared.evidence.home, ".gemini");
      try {
        expect([prepared.gateway, prepared.sourceAddress, prepared.evidence.mode]).toEqual(["127.0.0.1", "127.0.0.1", "native"]);
        expect(prepared.evidence.cleanupReceiptPath).toBe("");
        expect((await lstat(root)).mode & 0o777).toBe(0o700);
        expect(await readlink(join(gemini, "antigravity-cli"))).toBe(account);
        await expect(prepared.startUsage()).rejects.toThrow("unavailable in native mode");
        await expect(prepared.start({ ...settings, url: "http://192.0.2.1:45678/mcp" })).rejects.toThrow("native loopback");
        await expect(prepared.start({ ...settings, url: "http://@127.0.0.1:45678/mcp" })).rejects.toThrow("native loopback");
        const running = await prepared.start({ ...settings, profile, instructions: "explicit fixture instructions",
          ...(profile === "omp-system" ? { hostSystemPrompt: "Fixture host, prompt", originalToolNames: new Map([["read_file", "original_read"]]) } : {}) });
        const mcp = join(gemini, "config", "mcp_config.json");
        expect((await lstat(mcp)).mode & 0o777).toBe(0o600);
        expect(JSON.parse(await readFile(mcp, "utf8"))).toEqual({ mcpServers: { omp_agy_bridge: {
          serverUrl: settings.url, headers: { Authorization: `Bearer ${token}` }, timeoutSeconds: -1, tools: { read_file: { eager: true } },
        } } });
        const agent = join(gemini, "config", "plugins", "omp-agy-clean", "agents", "omp-agy-clean.md");
        if (profile === "default-agy") {
          await expect(lstat(agent)).rejects.toMatchObject({ code: "ENOENT" });
          expect(running.appendInstructions).toBe("explicit fixture instructions");
        } else {
          expect((await lstat(agent)).mode & 0o777).toBe(0o600);
          const text = await readFile(agent, "utf8");
          expect(text).toContain("excludeDefaultComponents: true");
          expect(text).toContain("explicit fixture instructions");
          if (profile === "omp-system") {
            expect(text).toContain("Fixture host,prompt");
            expect(text).toContain("original_read");
          }
          expect(running.appendInstructions).toBeUndefined();
        }
        const writer = running.stdin.getWriter();
        const reader = running.stdout.getReader();
        try {
          const payload = '{"jsonrpc":"2.0","id":1,"method":"fixture"}\n';
          await writer.write(new TextEncoder().encode(payload));
          let reply = "";
          const decoder = new TextDecoder();
          while (!reply.includes("\n")) {
            const next = await reader.read();
            if (next.done) throw new Error("Fixture ACP stream ended without echoing its input");
            reply += decoder.decode(next.value, { stream: true });
          }
          expect(reply).toBe(payload);
          expect(await readFile(join(prepared.workspace, "argv"), "utf8")).toBe([
            "acp", "--stdio", "--process-per-session", `--gemini-dir=${gemini}`, "--include-default-customizations=false",
            ...(profile === "default-agy" ? [] : ["--agent=omp-agy-clean"]), "",
          ].join("\n"));
          expect(await readFile(join(prepared.workspace, "home"), "utf8")).toBe(`${prepared.evidence.home}\n`);
          expect(running.evidence.stderr).toBe("");
          await writer.close();
        } finally { reader.releaseLock(); writer.releaseLock(); }
        const report = await running.stop();
        expect(report).toMatchObject({ status: "stopped", scope: "native-process-group" });
        expect(report.workers.every(worker => worker.state === "exited")).toBe(true);
        await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readFile(join(account, "untouched"), "utf8")).toBe("fixture account state");
        await expect(prepared.start(settings)).rejects.toThrow("only once");
      } finally { await prepared.stop(); }
    });
  });
}

test.skipIf(!posix)("native cancellation cleans a prepared or active runner without touching the original account", async () => {
  await nativeFixture(async (config, account) => {
    const previous = new AbortController();
    previous.abort(new Error("cancel before preparation"));
    await expect(bootstrapRunner(config, previous.signal)).rejects.toThrow("cancel before preparation");
    for (const active of [false, true]) {
      const abort = new AbortController();
      const prepared = await bootstrapRunner(config, abort.signal);
      try {
        if (active) await prepared.start(settings);
        abort.abort(new Error("fixture cancelled"));
        expect(await prepared.stop()).toMatchObject({ status: "stopped", scope: "native-process-group" });
        await expect(lstat(dirname(prepared.workspace))).rejects.toMatchObject({ code: "ENOENT" });
      } finally { await prepared.stop(); }
    }
    expect(await readFile(join(account, "untouched"), "utf8")).toBe("fixture account state");
  });
});
