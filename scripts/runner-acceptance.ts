import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import Ajv from "ajv";
import * as acp from "@agentclientprotocol/sdk";
import { createBridge, type Bridge } from "../src/bridge.ts";
import type { PreparedRunner, RunningRunner } from "../src/runner.ts";
import { bootstrapRunner, DEFAULT_RUNNER_CONFIG, parseCleanupReport, resetRunner } from "../src/runner.ts";
import { SessionController } from "../src/controller.ts";
import { readConfig } from "../src/config.ts";
import { redact } from "./acceptance.ts";

interface ChildMetadata {
  evidence: { workspace: string; generation: string; cleanupReceiptPath: string; supervisorPid: number; supervisorStartTime: string; producerPid?: number; workers: Array<{ pid: number }> };
  endpoint?: string;
  modelCount?: number;
}
const validateMetadata = new Ajv().compile<ChildMetadata>({
  type: "object", required: ["evidence"], properties: {
    endpoint: { type: "string" }, modelCount: { type: "integer", minimum: 0 },
    evidence: { type: "object", required: ["workspace", "generation", "cleanupReceiptPath", "supervisorPid", "supervisorStartTime", "workers"], properties: {
      workspace: { type: "string", pattern: "^/home/agy/" }, generation: { type: "string", pattern: "^[a-f0-9-]+$" },
      cleanupReceiptPath: { type: "string", pattern: "^/home/agy/\\.cache/omp-agy/receipts/[a-f0-9-]+/cleanup$" }, supervisorStartTime: { type: "string", pattern: "^[0-9]+$" },
      supervisorPid: { type: "integer", minimum: 1 }, producerPid: { type: "integer", minimum: 1 },
      workers: { type: "array", items: { type: "object", required: ["pid"], properties: { pid: { type: "integer", minimum: 1 } } } },
    } },
  },
});
// Isolated, real-runtime A02/A09 checks. This is not imported by the test suite.
// No login, model generation, credential contents, distro stop, or global shutdown.
const wsl = DEFAULT_RUNNER_CONFIG.wslPath;
const target = [wsl, "--distribution", DEFAULT_RUNNER_CONFIG.distribution, "--user", DEFAULT_RUNNER_CONFIG.user, "--cd", DEFAULT_RUNNER_CONFIG.home, "--exec", "/usr/bin/bash", "-s", "--"];
async function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  const { promise: timeout, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => reject(new Error(`${label} deadline exceeded`)), ms);
  try { return await Promise.race([promise, timeout]); } finally { clearTimeout(timer); }
}
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function record(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(redact(value), null, 2)}\n`);
}
async function linux(script: string, args: string[]): Promise<Record<string, string>> {
  const child = Bun.spawn([...target, ...args], { stdin: new TextEncoder().encode(script), stdout: "pipe", stderr: "pipe", timeout: 25_000 });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  assert(code === 0, `Owned-runtime observation failed (${code}): ${String(redact(err))}`);
  const entries = out.split("\n").filter(Boolean).map(line => {
    const separator = line.indexOf("\t");
    assert(separator > 0, "Invalid observer evidence frame");
    return [line.slice(0, separator), Buffer.from(line.slice(separator + 1), "base64").toString("utf8")];
  });
  return Object.fromEntries(entries);
}
async function inspectInitialState() {
  const child = Bun.spawn([wsl, "--list", "--verbose"], { stdout: "pipe", stderr: "pipe" });
  const [bytes, errors, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited]);
  assert(code === 0, `Cannot inspect initial distro state: ${String(redact(errors))}`);
  const buffer = Buffer.from(bytes);
  const listing = (buffer.includes(0) ? buffer.toString("utf16le") : buffer.toString("utf8")).replaceAll("\0", "").trim();
  const row = listing.split(/\r?\n/).map(line => line.trim().replace(/^\*\s*/, "").split(/\s+/)).find(fields => fields[0] === DEFAULT_RUNNER_CONFIG.distribution);
  assert(row && (row[1] === "Running" || row[1] === "Stopped") && row[2] === "2", "Target distro state/version is not explicitly observable as Running/Stopped WSL2");
  return { state: row[1], initiallyRunning: row[1] === "Running", listing, coldBootstrap: row[1] === "Stopped" ? "observed initial Stopped; first runner bootstrap will start it" : "not_observed: target already Running; no stop or terminate requested" };
}
const observer = `set -euo pipefail
runtime=$1 generation=$2 mode=$3 expected_supervisor=$4 receipt=$5 expected_start=$6
[[ $receipt == "\${runtime%/*}/receipts/$generation/cleanup" ]]
receipt_directory=\${receipt%/*}
[[ -d $receipt_directory && ! -L $receipt_directory && $(<"$receipt_directory/runtime") == "$runtime" && $(<"$receipt_directory/generation") == "$generation" ]]
emit() { printf '%s\t' "$1"; printf '%s' "$2" | base64 -w0; printf '\n'; }
identity() {
  local value
  [[ -r /proc/$1/stat ]] || return 1
  IFS= read -r value 2>/dev/null < "/proc/$1/stat" || return 1
  value=\${value##*) }
  read -r -a fields <<< "$value"
  printf '%s' "\${fields[19]}"
}
account=/home/agy/.gemini/antigravity-cli
emit account "$(stat -c '%d:%i uid=%u gid=%g mode=%a' "$account")"
emit tokenMetadata "$(stat -c 'uid=%u gid=%g mode=%a size=%s mtime=%Y' "$account/antigravity-oauth-token")"
if [[ $mode == before ]]; then
  [[ -d $runtime && ! -L $runtime && $(<"$runtime/generation") == "$generation" ]]
  [[ $(identity "$expected_supervisor") == "$expected_start" ]]
  emit supervisorStart "$(identity "$expected_supervisor")"
  emit owner "$(<"$runtime/owner")"
  emit bootId "$(<"$runtime/boot-id")"
  [[ ! -f $runtime/producer ]] || emit producer "$(<"$runtime/producer")"
  [[ ! -f $runtime/workers ]] || emit workerLedger "$(<"$runtime/workers")"
  exit 0
fi
for ((attempt=0;attempt<180;attempt++)); do
  [[ ! -f $receipt ]] || break
  sleep 0.1
done
[[ -f $receipt ]] || { printf 'Missing durable cleanup receipt after controller loss: %s\n' "$receipt" >&2; exit 71; }
cleanup=$(/usr/bin/bash "$receipt_directory/bootstrap.sh" report "$runtime" "$generation")
emit cleanup "$cleanup"
emit cleanupReceiptPath "$receipt"
emit runtimeExists "$([[ -e $runtime || -L $runtime ]] && printf yes || printf no)"
emit aliasExists "$([[ -L $runtime/gemini/antigravity-cli ]] && printf yes || printf no)"
emit privateConfigExists "$([[ -e $runtime/gemini/config/mcp_config.json ]] && printf yes || printf no)"
leftovers=
while IFS=$'\t' read -r kind pid start rest; do
  [[ $kind == worker ]] || continue
  current=$(identity "$pid" || true)
  [[ $current != "$start" ]] || leftovers+="$pid:$start "
done <<< "$cleanup"
emit knownWorkerLeftovers "$leftovers"
marker_leftovers=
for file in /proc/[0-9]*/environ; do
  [[ -r $file ]] || continue
  while IFS= read -r -d '' entry; do
    if [[ $entry == "OMP_AGY_GENERATION=$generation" ]]; then
      marker_leftovers+="\${file#/proc/} "
      break
    fi
  done 2>/dev/null < "$file"
done
emit generationMarkerLeftovers "$marker_leftovers"
for ((attempt=0;attempt<50;attempt++)); do
  [[ $(identity "$expected_supervisor" || true) == "$expected_start" ]] || break
  sleep 0.1
done
emit supervisorStart "$(identity "$expected_supervisor" || true)"
`;

async function recoverExisting(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const snapshot = () => linux(`set -euo pipefail
[[ $(id -un) == agy && $(id -u) != 0 && "\${WSL_DISTRO_NAME:-}" == omp-agy-wsl ]]
emit() { printf '%s\\t' "$1"; printf '%s' "$2" | base64 -w0; printf '\\n'; }
root=/home/agy/.cache/omp-agy
emit identity "$(id -un):$(id -u):\${WSL_DISTRO_NAME:-}"
emit bootId "$(</proc/sys/kernel/random/boot_id)"
count=0
if [[ -e $root || -L $root ]]; then
  [[ -d $root && ! -L $root && $(stat -c %u "$root") == "$(id -u)" && $(stat -c %a "$root") == 700 ]]
  for runtime in "$root"/activation.*; do
    [[ -e $runtime || -L $runtime ]] || continue
    ((count+=1))
    emit "path$count" "$runtime"
    emit "metadata$count" "$(stat -c 'uid=%u mode=%a type=%F' "$runtime")"
    for name in generation boot-id owner cleanup; do
      [[ ! -f $runtime/$name || -L $runtime/$name ]] || emit "$name$count" "$(<"$runtime/$name")"
    done
  done
fi
emit activationCount "$count"
`, []);
  const report: Record<string, unknown> = { generatedAt: new Date().toISOString(), operation: "resetRunner", noCredentialContents: true, noDistroTermination: true, hostShutdownCallback: "not exercised by registry recovery" };
  try {
    const before = await snapshot();
    report.before = before;
    await record(resolve(directory, "recovery-report.json"), report);
    const reset = await resetRunner();
    report.reset = reset;
    report.after = await snapshot();
    const receipts = [];
    for (const runtime of reset.recovered) {
      const index = Object.keys(before).find(key => key.startsWith("path") && before[key] === runtime)?.slice(4);
      assert(index, "Recovered activation was not in the identity/boot inspection");
      const generation = before[`generation${index}`]!;
      const proof = await linux(`set -euo pipefail
runtime=$1 generation=$2
receipt=/home/agy/.cache/omp-agy/receipts/$generation
[[ ! -e $runtime && ! -L $runtime && -d $receipt && ! -L $receipt ]]
[[ $(<"$receipt/runtime") == "$runtime" && $(<"$receipt/generation") == "$generation" ]]
emit() { printf '%s\\t' "$1"; printf '%s' "$2" | base64 -w0; printf '\\n'; }
emit runtime "$runtime"
emit runtimeExists no
emit cleanupReceiptPath "$receipt/cleanup"
emit cleanup "$(/usr/bin/bash "$receipt/bootstrap.sh" report "$runtime" "$generation")"
`, [runtime, generation]);
      assert(parseCleanupReport(proof.cleanup!, generation).status === "stopped", "Recovered receipt is not stopped");
      receipts.push(proof);
    }
    report.receipts = receipts;
    report.status = "observed";
  } catch (error) {
    report.status = "refused";
    report.error = error instanceof Error ? error.message : String(error);
    report.after = await snapshot().catch(error => ({ error: String(error) }));
    process.exitCode = 1;
  } finally {
    await record(resolve(directory, "recovery-report.json"), report);
  }
  console.log(`identity-checked recovery: ${report.status}`);
}

async function childMain(mode: string, metadataPath: string): Promise<void> {
  if (mode === "ownership-concurrent") {
    const prepared: PreparedRunner[] = [];
    try {
      await Promise.all([bootstrapRunner(), bootstrapRunner()].map(async pending => { prepared.push(await pending); }));
      await record(`${metadataPath}.peer`, { mode, pid: process.pid, evidence: prepared[1]!.evidence });
      await record(metadataPath, { mode, pid: process.pid, evidence: prepared[0]!.evidence });
    } catch (error) {
      await Promise.all(prepared.map(runner => runner.stop()));
      throw error;
    }
  } else if (mode === "prepared-eof") {
    const prepared = await bootstrapRunner();
    await record(metadataPath, { mode, pid: process.pid, evidence: prepared.evidence });
  } else {
    const controller = await SessionController.open({ ...readConfig({}), profile: "custom-clean" }, []);
    // Let the actual session worker enter the supervisor's observed ownership set.
    await Bun.sleep(250);
    await record(metadataPath, { mode, pid: process.pid, evidence: controller.runner.evidence, snapshot: controller.snapshot(), endpoint: controller.bridge.url, modelCount: controller.models.length });
  }
  // Intentionally no shutdown handler: the parent kills only THIS Windows PID.
  setInterval(() => {}, 1000);
}

async function main(): Promise<void> {
  const directory = resolve(process.argv[2] ?? ".acceptance/runner");
  await mkdir(directory, { recursive: true });
  const initialState = await inspectInitialState();
  const report: { generatedAt: string; initialState: unknown; scenarios: unknown[]; limits: string[] } = {
    generatedAt: new Date().toISOString(),
    initialState,
    scenarios: [],
    limits: ["No token contents copied or logged; only account directory identity and token stat metadata are observed.", "No refresh was forced and no token expiry was modified; refresh and shared-account concurrency safety remain separate acceptance.", "This proves observed process-per-session worker cleanup for controller SIGKILL, not arbitrary malicious same-UID process containment.", "No model generation is requested by this focused runner check."],
  };
  await record(resolve(directory, "initial-state.json"), report.initialState);
  for (const mode of ["prepared-eof", "session-crash"]) {
    const metadataPath = resolve(directory, `${mode}-${crypto.randomUUID()}-child.json`);
    const caseResult: Record<string, unknown> = { mode, status: "running", metadataPath, hostShutdownCallback: "not invoked: controller SIGKILL; Linux cleanup independently observed" };
    report.scenarios.push(caseResult);
    await record(resolve(directory, "report.json"), report);
    const child = Bun.spawn([process.execPath, import.meta.path, "--child", mode, metadataPath], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const out = new Response(child.stdout).text();
    const err = new Response(child.stderr).text();
    let metadata: ChildMetadata | undefined;
    try {
      await bounded((async () => {
        while (true) {
          try {
            const parsed: unknown = JSON.parse(await readFile(metadataPath, "utf8"));
            assert(validateMetadata(parsed), "Invalid child metadata");
            metadata = parsed;
            break;
          }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          if (child.exitCode !== null) throw new Error(`Controller child exited early (${child.exitCode})`);
          await Bun.sleep(50);
        }
      })(), 120_000, `${mode} setup`);
      assert(metadata, "Missing child metadata after setup");
      const evidence = metadata.evidence;
      caseResult.runnerEvidence = evidence;
      const runtime = dirname(evidence.workspace);
      const before = await linux(observer, [runtime, evidence.generation, "before", String(evidence.supervisorPid), evidence.cleanupReceiptPath, evidence.supervisorStartTime]);
      await record(resolve(directory, `${mode}-before.json`), before);
      if (mode === "session-crash") {
        assert((metadata.modelCount ?? 0) > 0, "Live ACP session did not advertise models");
        assert(evidence.workers.some(worker => worker.pid !== evidence.producerPid), "No real process-per-session worker was observed before crash");
      }
      const killedAt = performance.now();
      child.kill("SIGKILL");
      caseResult.controllerExit = await bounded(child.exited, 5000, "Windows controller crash");
      const after = await linux(observer, [runtime, evidence.generation, "after", String(evidence.supervisorPid), evidence.cleanupReceiptPath, evidence.supervisorStartTime]);
      const cleanup = parseCleanupReport(after.cleanup!, evidence.generation);
      const endpointClosed = metadata.endpoint ? await fetch(metadata.endpoint, { signal: AbortSignal.timeout(3000) }).then(() => false, () => true) : undefined;
      Object.assign(caseResult, { generation: evidence.generation, crashToObservationMs: Math.round(performance.now() - killedAt), before, after, cleanup, endpointClosed });
      assert(cleanup.status === "stopped", "Linux supervisor reported cleanup_failed after controller crash");
      assert(!after.knownWorkerLeftovers && !after.generationMarkerLeftovers, "Observed producer/worker remains after controller loss");
      assert(after.supervisorStart !== before.supervisorStart, "Owned Linux supervisor remains after controller loss");
      assert(after.runtimeExists === "no" && after.aliasExists === "no" && after.privateConfigExists === "no", "Activation directory or private alias/config survived successful crash cleanup");
      assert(before.account === after.account && /mode=(?:400|600)\b/.test(after.tokenMetadata!), "Persistent login directory was deleted/replaced or token mode became unsafe");
      assert(endpointClosed !== false, "Old Windows bridge remains reachable after its owner died");
      caseResult.status = "observed";
    } catch (error) {
      caseResult.status = "failed";
      caseResult.error = error instanceof Error ? error.message : String(error);
      process.exitCode = 1;
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await bounded(child.exited, 5000, "acceptance child exit").catch(() => {});
      if (metadata && !caseResult.after) {
        const evidence = metadata.evidence;
        try {
          caseResult.after = await linux(observer, [dirname(evidence.workspace), evidence.generation, "after", String(evidence.supervisorPid), evidence.cleanupReceiptPath, evidence.supervisorStartTime]);
        } catch (error) { caseResult.finalCleanupObservationError = String(error); }
      }
      caseResult.controllerStdout = await bounded(out, 3000, "controller stdout").catch(() => "stream remained open");
      caseResult.controllerStderr = await bounded(err, 3000, "controller stderr").catch(() => "stream remained open");
      await record(resolve(directory, `${mode}-result.json`), caseResult);
      await record(resolve(directory, "report.json"), report);
    }
    console.log(`${mode}: ${caseResult.status}`);
    if (caseResult.status !== "observed") break;
  }
  console.log(`Runner acceptance evidence: ${resolve(directory, "report.json")}`);
}

async function ownershipMain(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const initialState = await inspectInitialState();
  await record(resolve(directory, "initial-state.json"), initialState);
  const metadataPath = resolve(directory, `concurrent-${crypto.randomUUID()}.json`);
  const child = Bun.spawn([process.execPath, import.meta.path, "--child", "ownership-concurrent", metadataPath], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const report: Record<string, unknown> = { kind: "persistent-ownership-regression", status: "running", metadataPath, noModelGeneration: true, noCredentialContents: true };
  report.initialState = initialState;
  let first: ChildMetadata | undefined, second: ChildMetadata | undefined;
  try {
    await bounded((async () => {
      while (!first || !second) {
        try {
          const one: unknown = JSON.parse(await readFile(metadataPath, "utf8"));
          const two: unknown = JSON.parse(await readFile(`${metadataPath}.peer`, "utf8"));
          assert(validateMetadata(one) && validateMetadata(two), "Invalid concurrent ownership metadata");
          first = one; second = two;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (child.exitCode !== null) throw new Error(`Concurrent bootstrap owner exited (${child.exitCode})`);
        if (!first || !second) await Bun.sleep(50);
      }
    })(), 120_000, "concurrent ownership bootstrap");
    assert(first && second, "Missing concurrent ownership evidence");
    const firstRuntime = dirname(first.evidence.workspace), secondRuntime = dirname(second.evidence.workspace);
    const owned = await linux(`set -euo pipefail
first=$1 second=$2
for runtime in "$first" "$second"; do
  read -r pid start generation role < "$runtime/owner"
  [[ $role == supervisor && $generation == "$(<"$runtime/generation")" ]]
  read -r text < "/proc/$pid/stat"
  text=\${text##*) }
  read -r -a fields <<< "$text"
  [[ \${fields[19]} == "$start" ]]
  printf '%s\\t' "$runtime"; printf '%s' "$(<"$runtime/owner")" | base64 -w0; printf '\\n'
done
`, [firstRuntime, secondRuntime]);
    report.liveConcurrentOwners = { first: first.evidence, second: second.evidence, checkedOwners: owned };
    // Fault fixtures never enter the real registry. The EXIT trap owns the
    // entire temporary HOME, including partial fixture creation on failure.
    const bootstrap = await Bun.file(new URL("./bootstrap.sh", import.meta.url)).text();
    report.isolatedFences = await linux(`set -euo pipefail
umask 077
home=$(mktemp -d /tmp/omp-agy-ownership.XXXXXXXXXX)
trap 'rm -rf -- "$home"' EXIT
root=$home/.cache/omp-agy
mkdir -p "$root"
printf '%s' '${Buffer.from(bootstrap).toString("base64")}' | base64 -d > "$home/control.sh"
emit() { printf '%s\\t' "$1"; printf '%s' "$2" | base64 -w0; printf '\\n'; }
emit fixtureHome "$home"
runtime=$root/activation.fixture
generation=11111111-1111-4111-8111-111111111111
mkdir "$runtime"
printf '%s\\n' "$generation" > "$runtime/generation"
cat /proc/sys/kernel/random/boot_id > "$runtime/boot-id"
read -r text < /proc/$$/stat
text=\${text##*) }; read -r -a fields <<< "$text"
start=\${fields[19]}
refused() {
  if /usr/bin/bash "$home/control.sh" reset agy "$home" omp-agy-wsl > "$home/out" 2> "$home/error"; then exit 91; fi
  [[ -d $runtime && $(<"$home/error") == *cleanup_failed* && $(<"$home/error") == *"$runtime"* ]]
  emit "$1" "$(<"$home/error")"
}
printf '999999999 1 %s supervisor\\n' "$generation" > "$runtime/owner"
refused missing-report-dead-owner
printf '%s %s %s supervisor\\n' "$$" "$((start+1))" "$generation" > "$runtime/owner"
refused reused-pid-start-time-mismatch
printf '%s %s %s supervisor\\n' "$$" "$start" "$generation" > "$runtime/owner"
printf 'cleanup_failed\\n' > "$runtime/cleanup-failed"
refused live-owner-persistent-failure-marker
rm -rf -- "$home"
[[ ! -e $home ]]
trap - EXIT
emit fixtureHomeExists no
`, []);
    assert(report.isolatedFences && (report.isolatedFences as Record<string, string>).fixtureHomeExists === "no", "Isolated ownership fixtures survived");
    child.kill("SIGKILL");
    await bounded(child.exited, 5000, "concurrent owner controller exit");
    const cleanup = [];
    for (const metadata of [first, second]) {
      const evidence = metadata.evidence;
      const after = await linux(observer, [dirname(evidence.workspace), evidence.generation, "after", String(evidence.supervisorPid), evidence.cleanupReceiptPath, evidence.supervisorStartTime]);
      assert(parseCleanupReport(after.cleanup!, evidence.generation).status === "stopped", "Independent concurrent owner failed cleanup");
      assert(after.runtimeExists === "no" && !after.knownWorkerLeftovers && !after.generationMarkerLeftovers && after.supervisorStart !== evidence.supervisorStartTime, "Concurrent activation leaked after owner loss");
      cleanup.push(after);
    }
    report.concurrentCleanup = cleanup;
    report.hostShutdownCallback = "not invoked: controller SIGKILL; Linux receipts independently observed";
    report.status = "observed";
  } catch (error) {
    report.status = "failed"; report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1;
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await bounded(child.exited, 5000, "ownership acceptance controller exit").catch(() => {});
    if (!report.concurrentCleanup) {
      const cleanup = [];
      for (const metadata of [first, second]) {
        if (!metadata) continue;
        const evidence = metadata.evidence;
        try {
          cleanup.push(await linux(observer, [dirname(evidence.workspace), evidence.generation, "after", String(evidence.supervisorPid), evidence.cleanupReceiptPath, evidence.supervisorStartTime]));
        } catch (error) { cleanup.push({ generation: evidence.generation, error: String(error) }); }
      }
      report.finalCleanupObservations = cleanup;
    }
    report.stdout = await bounded(stdout, 3000, "ownership stdout").catch(() => "still open");
    report.stderr = await bounded(stderr, 3000, "ownership stderr").catch(() => "still open");
    await record(resolve(directory, "ownership-report.json"), report);
  }
  console.log(`persistent ownership: ${report.status}`);
}

async function coldMain(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const receipt = resolve(directory, "termination-receipt.json");
  assert(!await Bun.file(receipt).exists(), "One-shot termination receipt already exists; refusing another terminate command");
  const report: Record<string, unknown> = { status: "running", authorizedScope: "ONE terminate of omp-agy-wsl only; no global shutdown or docker action", noModelGeneration: true };
  const order: Array<{ event: string; at: string; details?: unknown }> = [];
  report.order = order;
  const mark = (event: string, details?: unknown) => { order.push({ event, at: new Date().toISOString(), details }); };
  let prepared: PreparedRunner | undefined, running: RunningRunner | undefined, bridge: Bridge | undefined, connection: acp.ClientConnection | undefined;
  let sessionId: string | undefined;
  let accountBefore: string | undefined;
  try {
    const initial = await inspectInitialState();
    report.initialState = initial; mark("target-state-inspected", initial.state);
    if (initial.state === "Running") {
      const inspection = await linux(`set -euo pipefail
emit() { printf '%s\\t' "$1"; printf '%s' "$2" | base64 -w0; printf '\\n'; }
emit observerPid "$$"
emit processes "$(ps -eo pid=,ppid=,user=,comm=)"
emit bootId "$(</proc/sys/kernel/random/boot_id)"
registry=
for runtime in /home/agy/.cache/omp-agy/activation.*; do
  [[ -d $runtime ]] || continue
  status=missing-cleanup
  [[ ! -f $runtime/cleanup ]] || IFS= read -r status < "$runtime/cleanup"
  registry+="$runtime $status"$'\\n'
done
emit registry "$registry"
emit accountInode "$(stat -c '%i uid=%u gid=%g mode=%a' /home/agy/.gemini/antigravity-cli)"
emit tokenMetadata "$(stat -c 'uid=%u gid=%g mode=%a inode=%i size=%s mtime=%Y' /home/agy/.gemini/antigravity-cli/antigravity-oauth-token)"
`, []);
      report.preTerminationInspection = inspection;
      accountBefore = inspection.accountInode;
      await record(resolve(directory, "safety-inspection.json"), inspection);
      const unknownProcesses = inspection.processes!.split("\n").filter(Boolean).filter(line => {
        const parts = line.trim().split(/\s+/);
        const [pid, parentPid, user, command] = parts;
        if (user === "root" && command && /^(?:init(?:\(|$)|Relay\(|SessionLeader$)/.test(command)) return false;
        if (user === "agy" && pid === inspection.observerPid && command === "bash") return false;
        if (user === "agy" && parentPid === inspection.observerPid && command === "ps") return false;
        return true;
      });
      assert(!unknownProcesses.length, `Unknown running work detected; terminate prohibited: ${unknownProcesses.join("; ")}`);
      assert(!inspection.registry || inspection.registry.split("\n").filter(Boolean).every(line => line.endsWith(" stopped")), "Unresolved/running activation ownership exists; terminate prohibited");
      mark("no-unrelated-work-or-live-activation-confirmed");
      // Persist the consumed authorization BEFORE spawning: even an interrupted
      // observer must never silently repeat this distro-specific termination.
      await record(receipt, { requestedAt: new Date().toISOString(), command: [wsl, "--terminate", DEFAULT_RUNNER_CONFIG.distribution], oneShot: true });
      mark("dedicated-terminate-requested");
      const terminate = Bun.spawn([wsl, "--terminate", DEFAULT_RUNNER_CONFIG.distribution], { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
      const [outBytes, err, code] = await Promise.all([new Response(terminate.stdout).arrayBuffer(), new Response(terminate.stderr).text(), terminate.exited]);
      const outBuffer = Buffer.from(outBytes);
      const out = outBuffer.includes(0) ? outBuffer.toString("utf16le") : outBuffer.toString("utf8");
      report.termination = { code, stdout: out, stderr: err }; mark("dedicated-terminate-exited", code);
      assert(code === 0, "Authorized dedicated termination failed; it will not be retried");
    } else {
      report.termination = "not needed: target already Stopped; no terminate command issued";
    }
    const stopped = await inspectInitialState();
    report.stoppedState = stopped;
    assert(stopped.state === "Stopped", "Target was not explicitly observed Stopped before bootstrap");
    mark("stopped-observed");
    mark("new-runner-bootstrap-requested");
    prepared = await bootstrapRunner();
    report.runnerEvidence = prepared.evidence;
    mark("bootstrap-ready-current-route-and-interface-discovered", { gateway: prepared.gateway, sourceAddress: prepared.sourceAddress, windowsInterface: prepared.evidence.windowsInterface, version: prepared.evidence.version, generation: prepared.evidence.generation });
    let bridgeFailure: Error | undefined;
    mark("windows-bridge-bind-requested", prepared.gateway);
    bridge = await createBridge({ hostname: prepared.gateway, sourceAddress: prepared.sourceAddress, tools: [], onActivity: () => {}, onFatal: error => { bridgeFailure = error; } });
    mark("windows-bridge-bound", bridge.url);
    mark("private-config-staging-and-supervised-acp-start-requested");
    running = await prepared.start({ url: bridge.url, token: bridge.token, aliases: bridge.aliases, profile: "custom-clean" });
    mark("supervised-acp-process-start-confirmed", { pid: running.evidence.producerPid, startTime: running.evidence.producerStartTime });
    const runtime = dirname(prepared.workspace);
    const stagingOrder = await linux(`set -euo pipefail
runtime=$1 generation=$2
[[ $(<"$runtime/generation") == "$generation" ]]
emit() { printf '%s\\t' "$1"; printf '%s' "$2" | base64 -w0; printf '\\n'; }
config=$(stat -c %y "$runtime/gemini/config/mcp_config.json")
start=$(stat -c %y "$runtime/start")
producer=$(stat -c %y "$runtime/producer")
[[ $config < $start || $config == "$start" ]]
[[ $start < $producer || $start == "$producer" ]]
emit configWrittenAt "$config"
emit startMarkerAt "$start"
emit producerIdentityPublishedAt "$producer"
emit privateConfigMode "$(stat -c %a "$runtime/gemini/config/mcp_config.json")"
emit accountAliasTarget "$(readlink "$runtime/gemini/antigravity-cli")"
emit owner "$(<"$runtime/owner")"
emit producer "$(<"$runtime/producer")"
emit bootId "$(<"$runtime/boot-id")"
`, [runtime, prepared.evidence.generation]);
    report.privateStagingOrder = stagingOrder;
    assert(stagingOrder.privateConfigMode === "600" && stagingOrder.accountAliasTarget === DEFAULT_RUNNER_CONFIG.accountDirectory, "Cold private config permissions/account directory alias mismatch");
    const updates: Record<string, number> = {};
    const app = acp.client({ name: "omp-agy" })
      .onNotification(acp.methods.client.session.update, ({ params }) => { const kind = params.update.sessionUpdate; updates[kind] = (updates[kind] ?? 0) + 1; })
      .onRequest(acp.methods.client.session.requestPermission, () => ({ outcome: { outcome: "cancelled" as const } }));
    connection = app.connect(acp.ndJsonStream(running.stdin, running.stdout, { maxMessageBytes: 8 * 1024 * 1024 }));
    mark("actual-acp-initialize-requested");
    const initialized = await bounded(connection.agent.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientInfo: { name: "omp-agy", title: "OMP Antigravity ACP extension", version: "0.1.0" }, clientCapabilities: {} }), 60_000, "cold ACP initialize");
    report.initialized = { protocolVersion: initialized.protocolVersion, agentInfo: initialized.agentInfo, agentCapabilities: initialized.agentCapabilities };
    assert(initialized.protocolVersion === acp.PROTOCOL_VERSION && initialized.agentCapabilities?.mcpCapabilities?.http, "Cold ACP initialization did not confirm HTTP MCP capability");
    mark("actual-acp-initialize-confirmed");
    const session = await bounded(connection.agent.request(acp.methods.agent.session.new, { cwd: prepared.workspace, mcpServers: [] }), 60_000, "cold ACP session/new");
    sessionId = session.sessionId;
    const selector = session.configOptions?.find(option => option.category === "model" || option.id === "model");
    const models = selector?.type === "select" ? selector.options.flatMap(option => "options" in option ? option.options : [option]) : [];
    report.session = { id: sessionId, modelCount: models.length, models, updates };
    report.bridge = bridge.snapshot();
    assert(models.length > 0 && bridge.snapshot().initialized, "Cold actual ACP session did not advertise models and initialize the private bridge");
    assert(!bridgeFailure, `Cold bridge failed: ${bridgeFailure?.message}`);
    mark("actual-acp-session-and-authenticated-private-mcp-initialization-confirmed", { modelCount: models.length });
    report.status = "observed";
  } catch (error) {
    report.status = "failed"; report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1;
  } finally {
    const reason = new Error("One-shot cold runner acceptance complete");
    if (bridge) { await bridge.revoke(reason); mark("private-bridge-revoked"); }
    if (connection && sessionId) await connection.agent.notify(acp.methods.agent.session.cancel, { sessionId }).catch(() => {});
    connection?.close(reason);
    const cleanup = await (running?.stop() ?? prepared?.stop());
    report.cleanup = cleanup;
    if (cleanup && cleanup.status !== "stopped") { report.status = "failed"; process.exitCode = 1; }
    if (cleanup) mark(cleanup.status === "stopped" ? "linux-cleanup-confirmed" : "linux-cleanup-failed", cleanup);
    if (cleanup?.status === "stopped") {
      const accountAfter = await linux(`set -euo pipefail
printf 'accountInode\\t'; stat -c '%i uid=%u gid=%g mode=%a' /home/agy/.gemini/antigravity-cli | base64 -w0; printf '\\n'
printf 'tokenMetadata\\t'; stat -c 'uid=%u gid=%g mode=%a inode=%i size=%s mtime=%Y' /home/agy/.gemini/antigravity-cli/antigravity-oauth-token | base64 -w0; printf '\\n'
`, []);
      report.accountAfterCleanup = accountAfter;
      if ((accountBefore && accountBefore.trim() !== accountAfter.accountInode?.trim()) || !/uid=1000 gid=1000 mode=(?:400|600)\b/.test(accountAfter.tokenMetadata ?? "")) {
        report.status = "failed"; report.accountPreservationError = "Stable account identity or token owner/mode changed"; process.exitCode = 1;
      }
    }
    report.limits = ["No model generation, token expiry manipulation, forced refresh, or credential-content access.", "Configuration-before-ACP ordering is supported by the supervised start marker, private file timestamps, exact producer identity, and successful real ACP initialization/session—not by guessed network constants.", "Only the dedicated distro was eligible for one terminate; docker/global WSL settings were not changed."];
    await record(resolve(directory, "cold-report.json"), report);
  }
  console.log(`one-shot cold runner: ${report.status}`);
}


if (import.meta.main) {
  const childMode = process.argv[2] === "--child";
  (childMode ? childMain(process.argv[3]!, process.argv[4]!) : process.argv[2] === "--recover" ? recoverExisting(resolve(process.argv[3] ?? ".acceptance/runner/recovery")) : process.argv[2] === "--cold-authorized" ? coldMain(resolve(process.argv[3] ?? ".acceptance/runner/cold")) : process.argv[2] === "--ownership" ? ownershipMain(resolve(process.argv[3] ?? ".acceptance/runner/ownership")) : main()).catch(error => {
    console.error(redact(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}
