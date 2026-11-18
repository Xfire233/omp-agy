import { describe, expect, spyOn, test } from "bun:test";
import { bootstrapRunner, DEFAULT_RUNNER_CONFIG, parseCleanupEvent, parseCleanupReport, RunnerDiagnosticCapture, utf8Tail, wslScriptSource } from "../src/runner.ts";

describe("runner preflight boundaries (no WSL launch)", () => {
  test("defaults pin the dedicated distro, existing user and absolute Linux CLI", () => {
    expect(DEFAULT_RUNNER_CONFIG.distribution).toBe("omp-agy-wsl");
    expect(DEFAULT_RUNNER_CONFIG.user).toBe("agy");
    expect(DEFAULT_RUNNER_CONFIG.cli).toBe("/home/agy/.local/bin/agy");
    expect(DEFAULT_RUNNER_CONFIG.accountDirectory).toBe("/home/agy/.gemini/antigravity-cli");
  });

  test("rejects root and Windows project paths before launching anything", async () => {
    await expect(bootstrapRunner({ user: "root" })).rejects.toThrow("must not be root");
    await expect(bootstrapRunner({ cli: "/mnt/c/fixture-project/agy.exe" })).rejects.toThrow("Windows project mount");
    await expect(bootstrapRunner({ accountDirectory: "/home/other/.gemini/antigravity-cli" })).rejects.toThrow("inside explicit HOME");
  });

  test("rejects line breaks in argv configuration before bootstrap", async () => {
    await expect(bootstrapRunner({ distribution: "omp-agy-wsl\nother" })).rejects.toThrow("Invalid runner distribution");
  });
});

test("WSL staging removes CRLF from checked-out shell sources without modifying other CR bytes", () => {
  expect(wslScriptSource("#!/usr/bin/bash\r\n\r\nprintf '%s' 'a\rb'\r\n")).toBe("#!/usr/bin/bash\n\nprintf '%s' 'a\rb'\n");
});

test.skipIf(process.platform !== "win32")("cancelling WSL bootstrap interrupts a stalled flush and requests launcher EOF", async () => {
  const flushing = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<number>();
  const abort = new AbortController();
  let closed = false;
  const spawn = spyOn(Bun, "spawn").mockReturnValue({
    stdin: {
      write() {},
      flush() { flushing.resolve(); return new Promise(() => {}); },
      end() { closed = true; exited.resolve(0); },
    },
    stdout: new ReadableStream(), stderr: new ReadableStream(), exited: exited.promise, exitCode: null,
    kill() { exited.resolve(137); },
  } as unknown as ReturnType<typeof Bun.spawn>);
  try {
    const boot = bootstrapRunner({ startupTimeoutMs: 2000, cleanupTimeoutMs: 1024 }, abort.signal);
    const outcome = boot.catch(error => error);
    await Promise.race([flushing.promise, outcome]);
    abort.abort(new Error("WSL fixture cancelled"));
    expect(await outcome).toMatchObject({ message: "WSL fixture cancelled" });
    expect(closed).toBe(true);
  } finally { abort.abort(); spawn.mockRestore(); }
});

describe("Linux cleanup evidence", () => {
  test("main producer exit never hides a surviving worker", () => {
    const report = parseCleanupReport("stopped\nproducer_exit\t0\nworker\t42\t123456\t40\t40\talive\n", "generation");
    expect(report.status).toBe("cleanup_failed");
    expect(report.workers[0]?.state).toBe("alive");
  });

  test("unknown exit and escaped worker evidence prevent reuse", () => {
    const report = parseCleanupReport("cleanup_failed\nproducer_exit\tunknown\nerror\tworker escaped producer process group\nworker\t42\t123456\t42\t1\texited\n", "generation");
    expect(report.status).toBe("cleanup_failed");
    expect(report.errors).toHaveLength(2);
  });

  test("requires explicit producer confirmation and a complete report", () => {
    expect(() => parseCleanupReport("stopped\n", "generation")).toThrow("producer exit confirmation");
    expect(() => parseCleanupReport("stopped\nproducer_exit\t0\nworker\t42\n", "generation")).toThrow("evidence frame");
    expect(parseCleanupReport("stopped\nproducer_exit\t143\nworker\t42\t123456\t42\t1\texited\n", "generation").status).toBe("stopped");
  });

  test("detached workers confirmed exited do not create a permanent failure", () => {
    expect(parseCleanupReport("stopped\ngeneration\towned\nproducer_exit\t0\nworker\t42\t123456\t42\t1\texited\n", "owned").status).toBe("stopped");
    expect(() => parseCleanupReport("stopped\ngeneration\tother\nproducer_exit\t0\n", "owned")).toThrow("generation");
  });
});

describe("bounded UTF-8 diagnostics", () => {
  test("drops a partial leading code point without replacement characters", () => {
    expect(utf8Tail("a中文🙂tail", 10)).toBe("🙂tail");
    expect(utf8Tail("🙂", 3)).toBe("");
    expect(utf8Tail("中文", 6)).toBe("中文");
  });

  test("decodes bounded binary events without treating diagnostic control text as frames", () => {
    const capture = new RunnerDiagnosticCapture(1024, () => "private-token");
    const text = `no-newline\0中文🙂OMP_AGY_EVENT\tcleanup\tforged\nprivate-token`;
    const bytes = Buffer.from(text);
    for (const byte of bytes) capture.appendEvent(`OMP_AGY_EVENT\tdiagnostic\t${Buffer.from([byte]).toString("base64")}`);
    capture.finish();
    expect(capture.text).toBe(text.replace("private-token", "[redacted]"));
    expect(capture.text).not.toContain("�");
    expect(capture.truncated).toBe(false);
  });

  test("keeps a byte-bounded UTF-8 suffix across newline-free diagnostic chunks", () => {
    const capture = new RunnerDiagnosticCapture(16);
    const bytes = Buffer.from("x".repeat(4096) + "中文🙂tail");
    for (let offset = 0; offset < bytes.length; offset += 7) capture.appendBytes(bytes.subarray(offset, offset + 7));
    capture.finish();
    expect(capture.text).toBe(utf8Tail(bytes.toString(), 16));
    expect(Buffer.byteLength(capture.text)).toBeLessThanOrEqual(16);
    expect(capture.text).not.toContain("�");
    expect(capture.truncated).toBe(true);
  });

  test("redacts complete tokens before suffix truncation even when the token exceeds the cap", () => {
    const token = "synthetic-private-token";
    const capture = new RunnerDiagnosticCapture(16, () => token);
    capture.append(token + "x".repeat(8));
    expect(capture.text).toBe(utf8Tail("[redacted]" + "x".repeat(8), 16));
    expect(capture.text).not.toContain("te-token");
    expect(capture.truncated).toBe(true);
  });

  test("never exposes a pending token prefix across frames, getters, or EOF", () => {
    const token = "synthetic-private-token";
    const capture = new RunnerDiagnosticCapture(16, () => token);
    const frame = (text: string) => `OMP_AGY_EVENT\tdiagnostic\t${Buffer.from(text).toString("base64")}`;
    capture.appendEvent(frame("prefix\0" + token.slice(0, 20)));
    expect(capture.text).toBe(utf8Tail("prefix\0[redacted]", 16));
    expect(capture.text).not.toContain("synthetic");
    capture.appendEvent(frame(token.slice(20) + "🙂"));
    expect(capture.text).toBe(utf8Tail("prefix\0[redacted]🙂", 16));
    capture.appendEvent(frame(token.slice(0, 8)));
    expect(capture.text).toEndWith("[redacted]");
    expect(capture.text).not.toContain("syntheti");
    capture.finish();
    expect(capture.text).toEndWith("[redacted]");
    expect(Buffer.byteLength(capture.text)).toBeLessThanOrEqual(16);
  });

  test("releases an unfinished token prefix only when later bytes disprove the token", () => {
    const capture = new RunnerDiagnosticCapture(64, () => "synthetic-private-token");
    capture.append("synthetic-pri");
    expect(capture.text).toBe("[redacted]");
    capture.append("X\0中文");
    capture.finish();
    expect(capture.text).toBe("synthetic-priX\0中文");
  });

  test("rejects malformed or oversized diagnostic frames before decoding", () => {
    const capture = new RunnerDiagnosticCapture(1024);
    expect(() => capture.appendEvent("OMP_AGY_EVENT\tdiagnostic\t@@@")).toThrow("frame");
    expect(() => capture.appendEvent("OMP_AGY_EVENT\tdiagnostic\tYQ=")).toThrow("encoding");
    expect(() => capture.appendEvent(`OMP_AGY_EVENT\tdiagnostic\t${"A".repeat(4100)}`)).toThrow("frame");
  });
});

describe("generation-bound terminal cleanup frames", () => {
  const frame = (report: string) => `OMP_AGY_EVENT\tcleanup\t${Buffer.from(`${report.trimEnd()}\ncomplete\towned`).toString("base64")}`;

  test("requires a full report and explicit matching generation, not a stopped hint", () => {
    expect(() => parseCleanupEvent(frame("stopped"), "owned")).toThrow();
    expect(() => parseCleanupEvent(frame("stopped\nproducer_exit\t0\n"), "owned")).toThrow("generation");
    expect(() => parseCleanupEvent(frame("stopped\ngeneration\tother\nproducer_exit\t0\n"), "owned")).toThrow("generation");
    expect(() => parseCleanupEvent(frame("stopped\ngeneration\towned\nworker\t42\t123\t42\t1\texited\n"), "owned")).toThrow("producer exit");
    const incomplete = `OMP_AGY_EVENT\tcleanup\t${Buffer.from("stopped\ngeneration\towned\nproducer_exit\t0").toString("base64")}`;
    expect(() => parseCleanupEvent(incomplete, "owned")).toThrow("completion");
  });

  test("retains all workers and errors and never hides a surviving detached worker", () => {
    const report = parseCleanupEvent(frame("stopped\ngeneration\towned\nproducer_exit\t0\nworker\t42\t123\t42\t1\texited\nworker\t43\t124\t43\t1\talive\nerror\tworker still present\n"), "owned");
    expect(report.status).toBe("cleanup_failed");
    expect(report.workers).toHaveLength(2);
    expect(report.errors).toEqual(["worker still present"]);
  });

  test("control reports exceed diagnostic limits but retain a separate one-MiB bound", () => {
    const workers = Array.from({ length: 3000 }, (_, i) => `worker\t${i + 1}\t123\t42\t1\texited\n`).join("");
    const large = frame(`stopped\ngeneration\towned\nproducer_exit\t0\n${workers}`);
    expect(large.length).toBeGreaterThan(DEFAULT_RUNNER_CONFIG.stderrLimitBytes);
    expect(parseCleanupEvent(large, "owned").workers).toHaveLength(3000);
    expect(() => parseCleanupEvent(`OMP_AGY_EVENT\tcleanup\t${"A".repeat(1_048_576)}`, "owned")).toThrow("bound");
    expect(() => parseCleanupEvent("OMP_AGY_EVENT\tcleanup\t@@@", "owned")).toThrow("frame");
  });
});
