import { describe, expect, test } from "bun:test";
import { readConfig } from "../src/config.ts";
import { DEFAULT_RUNNER_CONFIG } from "../src/runner.ts";

describe("explicit WSL runner configuration", () => {
  test("defaults to on-demand discovery and requires an explicit startup opt-in", () => {
    expect(readConfig({}).discovery).toBe("ondemand");
    expect(readConfig({ OMP_AGY_DISCOVERY: "startup" }).discovery).toBe("startup");
    expect(readConfig({ OMP_AGY_DISCOVERY: "ondemand" }).discovery).toBe("ondemand");
    expect(() => readConfig({ OMP_AGY_DISCOVERY: "background" })).toThrow("OMP_AGY_DISCOVERY");
  });

  test("keeps fixed defaults without searching PATH or using Windows AGY", () => {
    const config = readConfig({ PATH: "C:\\untrusted", AGY_PATH: "C:\\agy.exe", WSL_DISTRO_NAME: "unrelated" });
    expect(config.runner).toBeUndefined();
    expect(DEFAULT_RUNNER_CONFIG).toMatchObject({
      wslPath: "C:\\Windows\\System32\\wsl.exe", distribution: "omp-agy-wsl", user: "agy", cli: "/home/agy/.local/bin/agy",
      home: "/home/agy", accountDirectory: "/home/agy/.gemini/antigravity-cli",
    });
  });

  test("maps only explicit overrides to the existing RunnerConfig fields", () => {
    const config = readConfig({
      OMP_AGY_WSL_PATH: "D:\\Windows\\System32\\wsl.exe", OMP_AGY_WSL_DISTRIBUTION: "explicit-agy", OMP_AGY_WSL_USER: "explicit-user",
      OMP_AGY_CLI: "/home/explicit-user/bin/agy", OMP_AGY_HOME: "/home/explicit-user",
      OMP_AGY_ACCOUNT_DIRECTORY: "/home/explicit-user/.gemini/antigravity-cli",
      OMP_AGY_XDG_CONFIG_HOME: "/home/explicit-user/.config", OMP_AGY_XDG_CACHE_HOME: "/home/explicit-user/.cache",
      OMP_AGY_XDG_DATA_HOME: "/home/explicit-user/.local/share", OMP_AGY_STARTUP_TIMEOUT_MS: "45000",
      OMP_AGY_CLEANUP_TIMEOUT_MS: "12000", OMP_AGY_STDERR_LIMIT_BYTES: "32768",
    });
    expect(config.runner).toEqual({
      wslPath: "D:\\Windows\\System32\\wsl.exe", distribution: "explicit-agy", user: "explicit-user",
      cli: "/home/explicit-user/bin/agy", home: "/home/explicit-user", accountDirectory: "/home/explicit-user/.gemini/antigravity-cli",
      xdgConfigHome: "/home/explicit-user/.config", xdgCacheHome: "/home/explicit-user/.cache", xdgDataHome: "/home/explicit-user/.local/share",
      startupTimeoutMs: 45000, cleanupTimeoutMs: 12000, stderrLimitBytes: 32768,
    });
  });

  test("leaves unspecified fields to fixed runner defaults, never inferring an account from another override", () => {
    expect(readConfig({ OMP_AGY_CLI: "/opt/official/agy" }).runner).toEqual({ cli: "/opt/official/agy" });
  });

  test("native mode requires both explicit POSIX paths and refuses unrelated WSL overrides", () => {
    const valid = { OMP_AGY_RUNNER_MODE: "native", OMP_AGY_CLI: "/opt/bin/agy", OMP_AGY_ACCOUNT_DIRECTORY: "/opt/account" };
    expect(readConfig(valid).runner).toEqual({ mode: "native", cli: valid.OMP_AGY_CLI, accountDirectory: valid.OMP_AGY_ACCOUNT_DIRECTORY });
    expect(() => readConfig({ ...valid, OMP_AGY_RUNNER_MODE: "automatic" })).toThrow("no implicit fallback");
    expect(() => readConfig({ ...valid, OMP_AGY_CLI: "agy" })).toThrow("absolute");
    expect(() => readConfig({ ...valid, OMP_AGY_ACCOUNT_DIRECTORY: undefined })).toThrow("absolute");
    expect(() => readConfig({ ...valid, OMP_AGY_WSL_USER: "other" })).toThrow("WSL");
  });

  test("rejects malformed explicit runner strings instead of silently falling back", () => {
    for (const value of ["", "bad\nvalue", "bad\rvalue", "bad\0value"]) {
      expect(() => readConfig({ OMP_AGY_WSL_DISTRIBUTION: value })).toThrow("OMP_AGY_WSL_DISTRIBUTION");
    }
  });

  test("accepts a positive context budget or an explicitly cleared override", () => {
    expect(readConfig({}).contextWindow).toBeUndefined();
    for (const value of ["", "   ", "\t\r\n"]) {
      expect(readConfig({ OMP_AGY_CONTEXT_WINDOW: value }).contextWindow).toBeUndefined();
    }
    expect(readConfig({ OMP_AGY_CONTEXT_WINDOW: " 400000 " }).contextWindow).toBe(400000);
    for (const value of ["0", "-1", "1.5", "abc", "NaN", "Infinity", "9007199254740992"]) {
      expect(() => readConfig({ OMP_AGY_CONTEXT_WINDOW: value })).toThrow("OMP_AGY_CONTEXT_WINDOW");
    }
  });

  test("rejects invalid explicit resource bounds", () => {
    for (const key of ["OMP_AGY_STARTUP_TIMEOUT_MS", "OMP_AGY_CLEANUP_TIMEOUT_MS", "OMP_AGY_STDERR_LIMIT_BYTES"]) {
      for (const value of ["0", "-1", "1.5", "NaN", "9007199254740992"]) {
        expect(() => readConfig({ [key]: value })).toThrow(key);
      }
    }
  });
});
