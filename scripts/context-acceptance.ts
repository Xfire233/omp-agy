import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ptree, removeWithRetries } from "@oh-my-pi/pi-utils";
import { redact } from "./acceptance.ts";
import { assessCleanupReceipts, observeLinuxCleanup } from "./cleanup-receipts.ts";

// Real CLI @file acceptance, not RPC interpolation or a synthetic provider.
// bun scripts/context-acceptance.ts --out .acceptance/audit-fix-context
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
type RecordValue = Record<string, any>;
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
async function bounded<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  const deadline = Promise.withResolvers<never>(); const timer = setTimeout(() => deadline.reject(new Error(`${label} deadline`)), ms);
  try { return await Promise.race([work, deadline.promise]); } finally { clearTimeout(timer); }
}
function environment(root: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || /(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH_BROKER|AUTH_GATEWAY)/i.test(key) || /^(?:OMP_PROFILE|PI_PROFILE|PI_CODING_AGENT_DIR|PI_CODING_AGENT_SESSION_DIR|PI_CONFIG_DIR|PI_PROJECT_DIR|OMP_AGY_.*|CLAUDE_CONFIG_DIR|CODEX_HOME|GEMINI_CLI_HOME|XDG_.*)$/i.test(key)) continue;
    env[key] = value;
  }
  const home = join(root, "home");
  return { ...env, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"), PI_CODING_AGENT_DIR: join(root, "agent"), PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"), OMP_AGY_PROFILE: "custom-clean", OMP_AGY_DISCOVERY: "startup", NO_COLOR: "1" };
}
async function records(path: string): Promise<RecordValue[]> {
  const value = await readFile(path, "utf8"); assert(Buffer.byteLength(value) <= 2 * 1024 * 1024, "Audit evidence exceeds bound");
  return value.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    assert(["--out", "--omp", "--model", "--deadline-seconds"].includes(argv[i]!), `Unknown argument ${argv[i]}`);
    assert(argv[i + 1] && !argv[i + 1]!.startsWith("--"), `Missing value for ${argv[i]}`); options.set(argv[i]!, argv[i + 1]!);
  }
  const out = resolve(options.get("--out") ?? ".acceptance/context-cli-final");
  const deadlineMs = Number(options.get("--deadline-seconds") ?? 300) * 1000;
  assert(Number.isFinite(deadlineMs) && deadlineMs >= 30_000 && deadlineMs <= 900_000, "Deadline must be 30..900 seconds");
  const executable = options.get("--omp") ?? Bun.which("omp.exe") ?? Bun.which("omp"); assert(executable, "Actual omp executable is unavailable");
  // This actual advertised model is selected through the production extension's
  // live registration; the CLI rejects it if no longer advertised. No fake model.
  const selector = options.get("--model") ?? "omp-agy/gemini-4-argon";
  assert(selector.startsWith("omp-agy/") && selector.length > "omp-agy/".length, "Context acceptance requires an explicit AGY provider/model selector");
  await mkdir(out, { recursive: true });
  assert(!(await Bun.file(join(out, "report.json")).exists()), "Refusing to overwrite an existing context acceptance report");
  const root = await mkdtemp(join(tmpdir(), "omp-agy-cli-context-"));
  const project = join(root, "project"); const fixture = join(project, "attached-context.txt");
  const contextAudit = join(root, "context-audit.jsonl"); const cleanupAudit = join(root, "cleanup-audit.jsonl");
  const roots = [root, process.env.USERPROFILE ?? "", process.env.HOME ?? ""];
  const report: RecordValue = { schemaVersion: 1, generatedAt: new Date().toISOString(), classification: "failed", scope: "A06 actual CLI positional @file and standalone system-prompt omission", transport: "CLI --print --mode json; not RPC", modelSelector: selector,
    noAutomaticRetries: true, noCredentialFilesReadOrCopied: true, existingFixedWslLogin: true, productionSourceChanged: false,
    hostShutdownPolicy: { perHandlerBudgetMs: 2000, source: "installed @oh-my-pi/pi-coding-agent/src/extensibility/extensions/runner.ts:149-167", scope: "host callback deadline only; independent Linux cleanup is reported separately" },
    systemOnlySemantics: "unsupported by D04; no semantic support is claimed", evidence: { host: "host-events.jsonl", contextAudit: "context-audit.jsonl", cleanupAudit: "cleanup-audit.jsonl", linuxPhysicalCleanup: "linux-physical-cleanup.json" } };
  const fileMarker = `FILE_CONTEXT_${randomUUID().replaceAll("-", "")}`;
  const systemMarker = `SYS_CONTEXT_${randomUUID().replaceAll("-", "")}`;
  const prompt = "Read the text file attached through the CLI argument. Reply with exactly its complete content, without quotes, commentary or tools.";
  let child: ptree.ChildProcess<"ignore"> | undefined;
  let consume: Promise<void> | undefined;
  const events: RecordValue[] = []; const assistants: RecordValue[] = [];
  let stdoutBytes = 0; let nonJsonLines = 0;
  const onInterrupt = () => { report.interrupted = true; child?.kill(undefined, 30_000); };
  process.once("SIGINT", onInterrupt); process.once("SIGTERM", onInterrupt);
  const started = performance.now();
  try {
    await Promise.all([project, join(root, "home"), join(root, "agent"), join(root, "sessions")].map(path => mkdir(path, { recursive: true })));
    // File marker is supplied to the host ONLY by this real positional fixture,
    // never by its name, the user prompt, a system prompt, or marker-valued env.
    await writeFile(fixture, fileMarker + "\n");
    const config = join(root, "config.yml");
    await writeFile(config, "retry:\n  enabled: false\ncompaction:\n  enabled: false\nask:\n  timeout: 0\n");
    const env = environment(root);
    env.OMP_AGY_CONTEXT_AUDIT_PATH = contextAudit; env.OMP_AGY_CONTEXT_FIXTURE_PATH = fixture; env.OMP_AGY_CLEANUP_AUDIT_PATH = cleanupAudit;
    const args = ["--print", "--mode", "json", "--no-title", "--no-prewalk", "--no-tools", "--session-dir", join(root, "sessions"), "--config", config,
      "--model", selector, "--system-prompt", systemMarker, "-e", join(repository, "scripts", "context-audit-extension.ts"), `@${fixture}`, prompt];
    report.launch = { executable: redact(executable, roots), flags: ["--print", "--mode json", "--no-title", "--no-prewalk", "--no-tools", "--session-dir <isolated sessions>", "--config <isolated config>", `--model ${selector}`, "--system-prompt <independent system marker>", "-e <same-graph acceptance wrapper>", "@<fixture>", "<user prompt without marker literals>"],
      cwd: "<isolated project>", homeAgentConfigProjectAndSessionIsolated: true, noCredentialEnvironmentForwardedToHost: true,
      discoveryPolicy: "explicit OMP_AGY_DISCOVERY=startup for this dedicated AGY CLI",
      userPromptHasFileMarker: prompt.includes(fileMarker), userPromptHasSystemMarker: prompt.includes(systemMarker), fixtureContainsSystemMarker: false,
      systemFlagMapping: "installed cli/flag-tables.ts193-194 maps --system-prompt to args.systemPrompt; provider-context audit independently proves receipt" };
    child = ptree.spawn([executable, ...args], { cwd: project, env, stdin: "ignore" });
    report.hostProcessId = child.pid;
    consume = (async () => {
      const reader = child!.stdout.getReader(); const decoder = new TextDecoder(); let buffer = "";
      const line = (raw: string) => {
        if (!raw.trim()) return;
        let frame: RecordValue; try { frame = JSON.parse(raw); } catch { nonJsonLines++; return; }
        assert(events.length < 10_000, "CLI event count exceeds bound");
        const message = frame.type === "message_end" ? frame.message : undefined;
        const assistant = message?.role === "assistant" ? message : undefined;
        const text = assistant && Array.isArray(assistant.content) ? assistant.content.filter((block: RecordValue) => block.type === "text").map((block: RecordValue) => String(block.text)).join("") : undefined;
        assert(text === undefined || text.length <= 16_384, "CLI assistant output exceeds acceptance bound");
        const safe = { type: frame.type, role: frame.message?.role, provider: assistant?.provider, model: assistant?.model, stopReason: assistant?.stopReason,
          ...(text === undefined ? {} : { assistantText: text, fileMarkerObserved: text.includes(fileMarker), systemMarkerObserved: text.includes(systemMarker) }) };
        events.push(safe); if (assistant) assistants.push(safe);
      };
      try {
        for (;;) {
          const next = await reader.read(); if (next.done) break;
          stdoutBytes += next.value.byteLength; assert(stdoutBytes <= 8 * 1024 * 1024, "CLI stdout exceeds acceptance bound");
          buffer += decoder.decode(next.value, { stream: true });
          for (;;) { const end = buffer.indexOf("\n"); if (end < 0) break; line(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
          assert(Buffer.byteLength(buffer) <= 1024 * 1024, "Unterminated CLI JSON line exceeds bound");
        }
        buffer += decoder.decode(); if (buffer.trim()) line(buffer);
      } finally { reader.releaseLock(); }
    })();
    const [exitCode] = await bounded(Promise.all([child.exited, consume]), deadlineMs, "Actual CLI context acceptance");
    report.exitCode = exitCode;
    const audit = await records(contextAudit); const cleanup = await records(cleanupAudit);
    const install = audit.find(row => row.kind === "audit_install" && row.processId === child!.pid && row.classIdentityMatchesPublicExport === true && row.delegatesActualProductionFactory === true);
    const providerRows = audit.filter(row => row.kind === "provider_context"); const beginRows = audit.filter(row => row.kind === "acp_begin");
    const identity = (row: RecordValue) => row.processId === child!.pid && row.classIdentityMatchesPublicExport === true && row.receiverUsesSourceClass === true && row.hookIsCurrent === true;
    const providerObserved = providerRows.length === 1 && providerRows.every(row => identity(row) && row.fileMarkerInEffectiveMessages === true && row.standaloneSystemMarkerPresent === true && row.standaloneSystemMarkerInEffectiveMessages === false);
    const payloadObserved = beginRows.length === 1 && beginRows.every(row => identity(row) && typeof row.generation === "string" && row.generation.length > 0 && row.fileMarkerPresent === true && row.standaloneSystemMarkerPresent === false && row.textBlockCount > 0);
    const final = assistants.at(-1);
    const returnedFile = final?.assistantText?.trim() === fileMarker && final.provider === "omp-agy" && `${final.provider}/${final.model}` === selector && final.stopReason === "stop";
    report.findings = [
      { acceptance: "A06", criterion: "Actual CLI positional attachment reaches provider effective messages", classification: providerObserved ? "observed" : "failed", evidence: providerRows },
      { acceptance: "A06", criterion: "Actual ACP begin payload contains file marker and omits independently received standalone system marker", classification: install && payloadObserved ? "observed" : "failed", evidence: beginRows, independentSourceClassIdentity: !!install },
      { acceptance: "A06", criterion: "Actual model returns the attached file contents without prompt marker leakage", classification: returnedFile ? "observed" : "failed", evidence: final },
    ];
    report.audit = { installationObserved: !!install, providerInvocations: providerRows.length, acpBegins: beginRows.length, nonJsonLines, stdoutBytes, rawPromptsOrTokensRetainedByAudit: false };
    report.output = final?.assistantText;
    assert(exitCode === 0 && nonJsonLines === 0, "Actual print/json CLI did not exit cleanly with JSON output");
    assert(install && providerObserved && payloadObserved && returnedFile, "CLI attachment, real ACP payload omission or actual returned file content was not observed");
    assert(!audit.some(row => row.kind === "audit_truncated") && !cleanup.some(row => row.kind === "audit_truncated" || row.kind === "stop_throw"), "Audit evidence incomplete or cleanup threw");
    report.classification = "observed";
  } catch (error) { report.error = errorText(error); }
  finally {
    if (child && child.exitCode === null) {
      child.kill(undefined, 30_000);
      try { report.exitCode = await bounded(child.exited, 40_000, "Owned CLI shutdown"); } catch (error) { report.shutdownError = errorText(error); }
    }
    if (consume) try { await bounded(consume, 5_000, "CLI stdout drain"); } catch (error) { report.stdoutError = errorText(error); }
    const stderr = child?.peekStderr() ?? "";
    report.stderr = { characters: stderr.length, d04DiagnosticPresent: stderr.includes("D04"), rawContentRetained: false };
    try {
      const audit = await records(contextAudit); const cleanup = await records(cleanupAudit);
      await writeFile(join(out, "context-audit.jsonl"), audit.map(row => JSON.stringify(redact(row, roots))).join("\n") + "\n");
      await writeFile(join(out, "cleanup-audit.jsonl"), cleanup.map(row => JSON.stringify(redact(row, roots))).join("\n") + "\n");
      const activeGenerations = audit.filter(row => row.kind === "acp_begin" && row.processId === child?.pid && row.classIdentityMatchesPublicExport === true && row.receiverUsesSourceClass === true && row.hookIsCurrent === true && typeof row.generation === "string").map(row => row.generation);
      const hostCallbacks = assessCleanupReceipts(cleanup, child?.pid ?? -1, activeGenerations);
      const cliExited = child?.exitCode !== null && child?.exitCode !== undefined;
      report.cleanup = { hostCallbacks, cliExited, hostCallbackClassification: hostCallbacks.confirmed && cliExited ? "observed" : "failed",
        missingStopAfterIsFailure: true, discoveryReceiptsCannotProveConversationCleanup: true };
      report.cleanupConfirmed = hostCallbacks.confirmed && cliExited;
      // This posthost observation remains a separate verdict even if Linux has
      // cleaned up after the host's bounded shutdown hook abandoned its await.
      const physical = await observeLinuxCleanup(cleanup, child?.pid ?? -1, activeGenerations);
      report.linuxPhysicalCleanup = physical;
      await writeFile(join(out, "linux-physical-cleanup.json"), JSON.stringify(redact(physical, roots), null, 2) + "\n");
      if (!report.cleanupConfirmed || !physical.confirmed || audit.some(row => row.kind === "audit_truncated") || cleanup.some(row => row.kind === "audit_truncated" || row.kind === "stop_throw")) report.classification = "failed";
    } catch (error) { report.auditError = errorText(error); report.classification = "failed"; }
    await writeFile(join(out, "host-events.jsonl"), events.map(row => JSON.stringify(redact(row, roots))).join("\n") + "\n");
    try { await removeWithRetries(root); report.temporaryFixturesRemoved = true; }
    catch (error) { report.temporaryFixturesRemoved = false; report.fixtureCleanupError = errorText(error); report.classification = "failed"; }
    process.removeListener("SIGINT", onInterrupt); process.removeListener("SIGTERM", onInterrupt);
    if (report.interrupted || report.shutdownError || report.stdoutError) report.classification = "failed";
    report.durationMs = Math.round(performance.now() - started);
    await writeFile(join(out, "report.json"), JSON.stringify(redact(report, roots), null, 2) + "\n");
  }
  console.log(`Actual CLI context acceptance: ${report.classification}; evidence ${join(out, "report.json")}`);
  if (report.error) console.log(redact(report.error, roots));
  process.exitCode = report.classification === "observed" ? 0 : 1;
}
if (import.meta.main) main().catch(error => { console.error(redact(errorText(error), [process.env.USERPROFILE ?? "", process.env.HOME ?? ""])); process.exitCode = 1; });
