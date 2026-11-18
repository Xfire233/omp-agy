import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { Host, redact } from "./acceptance.ts";
import { assessCleanupReceipts, observeLinuxCleanup } from "./cleanup-receipts.ts";

// Explicit, scoped real-runtime smoke; no execution on import. One read-only
// generation total, no native-role generation, pressure runs or automatic retry.
// bun scripts/activation-smoke.ts --out .acceptance/activation-smoke
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const routingProvider = "activation-routing-fixture";
const routingModel = "routing-only";
type Row = Record<string, unknown>;
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function rows(path: string): Promise<Row[]> {
  return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Row);
}
function environment(root: string, startup: boolean, audit: string, cleanup: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || /(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH_BROKER|AUTH_GATEWAY)/i.test(key) || /^(?:OMP_PROFILE|PI_PROFILE|PI_CODING_AGENT_DIR|PI_CODING_AGENT_SESSION_DIR|PI_CONFIG_DIR|PI_PROJECT_DIR|OMP_AGY_.*|CLAUDE_CONFIG_DIR|CODEX_HOME|GEMINI_CLI_HOME|XDG_.*)$/i.test(key)) continue;
    env[key] = value;
  }
  const home = join(root, "home");
  return { ...env, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
    PI_CODING_AGENT_DIR: join(root, "agent"), PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
    OMP_AGY_PROFILE: "custom-clean", ...(startup ? { OMP_AGY_DISCOVERY: "startup" } : {}),
    OMP_AGY_ACTIVATION_AUDIT_PATH: audit, OMP_AGY_CLEANUP_AUDIT_PATH: cleanup, NO_COLOR: "1" };
}
async function run(startup: boolean, out: string, executable: string, modelId: string): Promise<Row> {
  const name = startup ? "startup" : "ondemand";
  const root = await mkdtemp(join(tmpdir(), "omp-agy-activation-"));
  const project = join(root, "project"); const agent = join(root, "agent");
  const audit = join(root, "activation.jsonl"); const cleanup = join(root, "cleanup.jsonl");
  const host = new Host(join(out, `${name}-trace.jsonl`), [root, process.env.USERPROFILE ?? "", process.env.HOME ?? ""], 240_000);
  host.cleanupCommandsAvailable = false;
  const report: Row = { scenario: name, classification: "failed", discoveryEnvironment: startup ? "startup" : "unset (production ondemand default)", trace: `${name}-trace.jsonl` };
  const onInterrupt = () => { report.interrupted = true; void host.close(); };
  process.once("SIGINT", onInterrupt); process.once("SIGTERM", onInterrupt);
  const activeGenerations: string[] = [];
  try {
    await Promise.all([project, agent, join(root, "sessions"), join(root, "home")].map(path => mkdir(path, { recursive: true })));
    const config = join(root, "config.yml");
    await writeFile(config, "retry:\n  enabled: false\ncompaction:\n  enabled: false\n");
    // Uncallable static catalog metadata for SDK child preparation only.
    await writeFile(join(agent, "models.yml"), Bun.YAML.stringify({ providers: {
      [routingProvider]: { baseUrl: "https://activation-routing.invalid/v1", api: "openai-responses", models: [{ id: routingModel }] },
    } }));
    const marker = `ACTIVATION_${crypto.randomUUID().replaceAll("-", "")}`;
    const file = `activation-${marker}.txt`;
    await writeFile(join(project, file), marker + "\n");
    const args = ["--mode", "rpc-ui", "--no-title", "--no-prewalk", "--session-dir", join(root, "sessions"), "--config", config,
      "-e", join(repository, "scripts", "activation-audit-extension.ts")];
    if (startup) args.push("--model", `omp-agy/${modelId}`);
    await host.start(executable, project, environment(root, startup, audit, cleanup), args);
    await host.request({ type: "set_cache_warming", mode: "off" });
    await host.request({ type: "set_auto_compaction", enabled: false });
    await host.request({ type: "set_auto_retry", enabled: false });
    const initial = await rows(audit);
    assert(initial.some(row => row.kind === "factory_bind"), "Production wrapper did not load; refusing to submit any slash command");
    host.cleanupCommandsAvailable = true;
    const initialStatus = await host.status();
    const startupDiagnostics = host.ui.filter(frame => /D04/.test(String(frame.message)));
    report.initial = { observations: initial, status: initialStatus, d04Warnings: startupDiagnostics.length, state: await host.request({ type: "get_state" }) };
    assert(host.events.every(event => event.type !== "agent_start"), "Startup invoked generation");
    assert(startupDiagnostics.length === 0, "D04 was shown merely by extension load");
    if (!startup) {
      assert(!initial.some(row => row.kind === "wsl_spawn"), "Default extension load launched WSL discovery");
      const available = await host.request({ type: "get_available_models" });
      assert(!available.models.some((model: { provider: string }) => model.provider === "omp-agy"), "Fresh ondemand process advertised an unverified AGY catalog");
      await host.prompt(`/agy ${modelId}`);
    }
    const selected = await host.request({ type: "get_state" });
    const afterSelection = await host.status();
    report.selection = { state: selected, status: afterSelection, observations: await rows(audit) };
    assert(selected.model?.provider === "omp-agy" && selected.model.id === modelId, "Exact live AGY model was not selected");
    assert(host.events.every(event => event.type !== "agent_start"), "Model selection invoked generation");
    assert(Number(afterSelection?.providerInvocations ?? 0) === 0, "Model selection invoked the AGY provider");
    assert((await rows(audit)).filter(row => row.kind === "wsl_spawn" && row.bootstrap === true).length === 1, "Selection did not use exactly one actual WSL bootstrap");
    for (let index = 0; index < 2; index++) await host.prompt(`/activation-child ${routingProvider}/${routingModel}`);
    const children = (await rows(audit)).filter(row => row.kind === "prepared_child");
    report.preparedChildren = children;
    assert(children.length === 2 && children.every(row => row.provider === routingProvider && row.modelId === routingModel && row.promptSubmitted === false && row.wslSpawnsBefore === row.wslSpawnsAfter && row.boundProductionFactories === 1), "Prepared non-AGY child rediscovered or did not bind its own production factory");
    assert(host.events.every(event => event.type !== "agent_start"), "Prepared child generated a response");
    if (!startup) {
      const terminal = await host.prompt(`Use the OMP read tool exactly once to read ${file}. Do not use any other tool, edit anything, or delegate. Return only the exact marker from that file.`);
      await host.settled();
      const status = await host.status();
      if (typeof status?.generation === "string") activeGenerations.push(status.generation);
      const text = await host.text();
      report.roundtrip = { terminal, status, text, tools: host.toolResults, eventCounts: { agentStart: host.events.filter(event => event.type === "agent_start").length }, markerMatched: text.includes(marker) };
      assert(terminal.status === "completed" && text.includes(marker), "Changed-runtime AGY response did not return the file marker");
      assert(host.toolResults.length === 1 && host.toolResults[0]?.toolName === "read" && host.toolResults[0]?.isError !== true, "Changed-runtime AGY did not complete exactly one successful OMP read");
      assert(activeGenerations.length > 0, "Conversation generation identity was not retained");
    }
    report.classification = "observed";
  } catch (error) { report.error = error instanceof Error ? error.message : String(error); }
  finally {
    await host.close();
    process.removeListener("SIGINT", onInterrupt); process.removeListener("SIGTERM", onInterrupt);
    report.shutdown = host.shutdownEvidence;
    try {
      const receipts = await rows(cleanup);
      await writeFile(join(out, `${name}-cleanup.jsonl`), receipts.map(row => JSON.stringify(redact(row, host.roots))).join("\n") + "\n");
      const receiptAssessment = assessCleanupReceipts(receipts, host.pid!, activeGenerations);
      report.cleanupReceipts = receiptAssessment;
      if (!receiptAssessment.allCallbacksComplete || (!startup && !receiptAssessment.confirmed)) report.classification = "failed";
      const physical = await observeLinuxCleanup(receipts, host.pid!, activeGenerations);
      report.linuxPhysicalCleanup = physical;
      await writeFile(join(out, `${name}-linux-physical-cleanup.json`), JSON.stringify(redact(physical, host.roots), null, 2) + "\n");
      if (!physical.confirmed) report.classification = "failed";
      const observations = await rows(audit);
      await writeFile(join(out, `${name}-activation.jsonl`), observations.map(row => JSON.stringify(redact(row, host.roots))).join("\n") + "\n");
    } catch (error) { report.receiptError = String(error); report.classification = "failed"; }
    try { await removeWithRetries(root); report.temporaryFilesRemoved = true; }
    catch (error) { report.temporaryFilesRemoved = false; report.cleanupError = String(error); report.classification = "failed"; }
  }
  const redacted = redact(report, host.roots) as Row;
  await writeFile(join(out, `${name}-report.json`), JSON.stringify(redacted, null, 2) + "\n");
  return redacted;
}
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    assert(["--out", "--omp", "--model"].includes(argv[index]!), `Unknown argument ${argv[index]}`);
    assert(argv[index + 1], `Missing argument value ${argv[index]}`); options.set(argv[index]!, argv[index + 1]!);
  }
  const out = resolve(options.get("--out") ?? ".acceptance/activation-smoke");
  const executable = options.get("--omp") ?? Bun.which("omp.exe") ?? Bun.which("omp"); assert(executable, "Actual OMP executable unavailable");
  const model = options.get("--model") ?? "gemini-4-argon"; // Both paths require fresh live verification.
  await mkdir(out, { recursive: true });
  assert(!await Bun.file(join(out, "report.json")).exists(), "Refusing to overwrite preserved smoke evidence");
  const results = [await run(false, out, executable, model), await run(true, out, executable, model)];
  const report = { generatedAt: new Date().toISOString(), classification: results.every(result => result.classification === "observed") ? "observed" : "failed", results,
    nativeRoleGeneration: "not-run",
    scope: "Actual OMP rpc-ui load/default ondemand, local exact selection, explicit startup selector, prepared SDK children using synthetic non-AGY routing metadata without prompts (two per scenario), one AGY read-tool response, strict controller cleanup receipts" };
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ classification: report.classification, report: join(basename(out), "report.json") }));
  if (report.classification !== "observed") process.exitCode = 1;
}
if (import.meta.main) main().catch(error => { console.error(redact(String(error), [process.env.USERPROFILE ?? "", process.env.HOME ?? ""])); process.exitCode = 1; });
