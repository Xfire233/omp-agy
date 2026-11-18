import { DEFAULT_RUNNER_CONFIG, parseCleanupReport } from "../src/runner.ts";

type Row = Record<string, any>;

/** A discovery cleanup is never evidence for a later conversation activation. */
export function assessCleanupReceipts(rows: readonly Row[], processId: number, activeGenerations: readonly string[]) {
  const owned = rows.filter(row => row.processId === processId);
  const before = owned.filter(row => row.kind === "stop_before");
  const after = owned.filter(row => row.kind === "stop_after");
  const errors: string[] = [];
  const paired = new Map<string, Row>();
  const calls = new Map<string, Row>();
  const terminals = new Set<string>();
  const identityFields = ["classIdentityMatchesPublicExport", "receiverUsesSourceClass", "hookIsCurrent"] as const;
  const clean = (row: Row) => {
    const state = row.after;
    if (!state || state.snapshotAvailable !== true || state.phase !== "stopped") return false;
    if (!row.generation && !state.generation && !state.cleanup && !state.bridge) return true;
    const receipt = state.cleanup;
    const bridge = state.bridge;
    return receipt?.status === "stopped" && receipt.generation === row.generation && receipt.errorCount === 0 &&
      receipt.workersTruncated !== true && Array.isArray(receipt.workers) && receipt.workers.every((worker: Row) => worker.state === "exited") &&
      (!bridge || (bridge.revoked === true && bridge.accepting === false && bridge.activeTurn === false &&
        [bridge.sessionCount, bridge.connections, bridge.pendingCount, bridge.queuedCount, bridge.dispatchedCount, bridge.deliveringCount].every(value => value === 0)));
  };
  for (const row of owned) {
    if (row.kind === "stop_before") {
      if (typeof row.callId !== "string" || calls.has(row.callId)) errors.push("Missing or duplicate stop_before callId");
      else calls.set(row.callId, row);
      continue;
    }
    if (row.kind !== "stop_after") continue;
    const start = calls.get(row.callId);
    if (!start || terminals.has(row.callId)) { errors.push(`Orphan or duplicate stop_after ${String(row.callId)}`); continue; }
    terminals.add(row.callId);
    if (!identityFields.every(key => start[key] === true && row[key] === true) || row.delegateOutcome !== "fulfilled" ||
      start.generation !== row.generation || start.before?.generation !== start.generation ||
      row.after?.generation !== row.generation || !clean(row)) {
      errors.push(`Unconfirmed or mismatched cleanup for ${row.callId}`); continue;
    }
    paired.set(row.callId, row);
  }
  if (owned.some(row => row.kind === "stop_throw" || row.kind === "audit_truncated")) errors.push("Cleanup audit contains a throw or truncation");
  for (const row of before) {
    if (!terminals.has(row.callId)) errors.push(`Missing stop_after for ${String(row.callId)} (generation ${String(row.generation)})`);
  }
  const active = [...new Set(activeGenerations)];
  const confirmedGenerations = new Set([...paired.values()].map(row => row.generation));
  const missingActiveGenerations = active.filter(generation => !confirmedGenerations.has(generation));
  const allCallbacksComplete = before.length > 0 && errors.length === 0 && paired.size === before.length;
  return {
    stopBeforeCount: before.length, stopAfterCount: after.length, pairedCount: paired.size,
    unmatchedCallIds: before.filter(row => !paired.has(row.callId)).map(row => row.callId),
    activeGenerations: active, missingActiveGenerations, errors,
    allCallbacksComplete,
    activeGenerationsClean: active.length > 0 && missingActiveGenerations.length === 0,
    confirmed: allCallbacksComplete && active.length > 0 && missingActiveGenerations.length === 0,
  };
}

/** Independent physical cleanup evidence never substitutes for a host callback. */
export function assessLinuxCleanupObservation(observation: Record<string, string>, generation: string) {
  if (observation.cleanup?.split("\n").filter(line => line === `generation\t${generation}`).length !== 1) throw new Error("Missing or mismatched durable receipt generation");
  const receipt = parseCleanupReport(observation.cleanup, generation);
  const confirmed = receipt.status === "stopped" && receipt.errors.length === 0 && receipt.workers.every(worker => worker.state === "exited") &&
    observation.runtimeExists === "no" && observation.knownWorkerLeftovers === "" && observation.supervisorIdentityPresent === "no";
  return { confirmed, receipt, runtimeAbsent: observation.runtimeExists === "no", knownWorkerLeftovers: observation.knownWorkerLeftovers,
    supervisorIdentityAbsent: observation.supervisorIdentityPresent === "no" };
}

// Uses ONLY the adjacent durable bootstrap's report command, receipt identity,
// /proc process identities and runtime existence. No stop/reset/remove operation,
// credential access, model generation or global configuration changes occur.
const physicalObserver = `set -euo pipefail
runtime=$1 generation=$2 receipt=$3 supervisor=$4 supervisor_start=$5
[[ $receipt == "\${runtime%/*}/receipts/$generation/cleanup" ]]
directory=\${receipt%/*}
[[ -d $directory && ! -L $directory && $(<"$directory/runtime") == "$runtime" && $(<"$directory/generation") == "$generation" ]]
[[ -f $directory/bootstrap.sh && ! -L $directory/bootstrap.sh ]]
emit() { printf '%s\\t' "$1"; printf '%s' "$2" | base64 -w0; printf '\\n'; }
identity() {
  local value
  [[ -r /proc/$1/stat ]] || return 1
  IFS= read -r value 2>/dev/null < "/proc/$1/stat" || return 1
  value=\${value##*) }
  read -r -a fields <<< "$value"
  printf '%s' "\${fields[19]}"
}
for ((attempt=0;attempt<180;attempt++)); do
  [[ ! -f $receipt ]] || break
  sleep 0.1
done
[[ -f $receipt && ! -L $receipt ]] || { printf 'Missing durable cleanup receipt\\n' >&2; exit 71; }
cleanup=$(/usr/bin/bash "$directory/bootstrap.sh" report "$runtime" "$generation")
emit cleanup "$cleanup"
emit runtimeExists "$([[ -e $runtime || -L $runtime ]] && printf yes || printf no)"
leftovers=
while IFS=$'\\t' read -r kind pid start rest; do
  [[ $kind == worker ]] || continue
  [[ $(identity "$pid" || true) != "$start" ]] || leftovers+="$pid:$start "
done <<< "$cleanup"
emit knownWorkerLeftovers "$leftovers"
present=no
if [[ -n $supervisor && -n $supervisor_start ]]; then
  for ((attempt=0;attempt<50;attempt++)); do
    [[ $(identity "$supervisor" || true) == "$supervisor_start" ]] || break
    sleep 0.1
  done
  [[ $(identity "$supervisor" || true) != "$supervisor_start" ]] || present=yes
fi
emit supervisorIdentityPresent "$present"
`;

export async function observeLinuxCleanup(rows: readonly Row[], processId: number, activeGenerations: readonly string[]) {
  const before = rows.filter(row => row.processId === processId && row.kind === "stop_before");
  const generations = [...new Set([...activeGenerations, ...before.map(row => row.generation).filter((value): value is string => typeof value === "string")])];
  const observations: Row[] = [];
  for (const generation of generations) {
    const state = before.find(row => row.generation === generation)?.before;
    const result: Row = { generation, activeConversation: activeGenerations.includes(generation), confirmed: false };
    observations.push(result);
    try {
      if (!/^[a-f0-9-]{36}$/.test(generation) || !state || state.distribution !== DEFAULT_RUNNER_CONFIG.distribution || state.user !== DEFAULT_RUNNER_CONFIG.user || state.home !== DEFAULT_RUNNER_CONFIG.home ||
        typeof state.runtimePath !== "string" || !/^\/home\/agy\/\.cache\/omp-agy\/activation\.[A-Za-z0-9]+$/.test(state.runtimePath) ||
        state.cleanupReceiptPath !== `${state.home}/.cache/omp-agy/receipts/${generation}/cleanup`) throw new Error("Missing or invalid fixed-runner durable receipt identity");
      const args = [DEFAULT_RUNNER_CONFIG.wslPath, "--distribution", state.distribution, "--user", state.user, "--cd", state.home, "--exec", "/usr/bin/bash", "-s", "--",
        state.runtimePath, generation, state.cleanupReceiptPath, String(state.supervisorPid ?? ""), String(state.supervisorStartTime ?? "")];
      const child = Bun.spawn(args, { stdin: new TextEncoder().encode(physicalObserver), stdout: "pipe", stderr: "pipe", timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (code !== 0) throw new Error(`Independent Linux cleanup observation failed (${code}): ${stderr.slice(0, 4096)}`);
      if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) throw new Error("Independent Linux cleanup evidence exceeds bound");
      const observation: Record<string, string> = {};
      for (const line of stdout.trimEnd().split("\n")) {
        const match = /^([A-Za-z]+)\t([A-Za-z0-9+/=]*)$/.exec(line);
        if (!match || Object.hasOwn(observation, match[1]!)) throw new Error("Invalid independent Linux cleanup evidence frame");
        observation[match[1]!] = Buffer.from(match[2]!, "base64").toString("utf8");
      }
      Object.assign(result, assessLinuxCleanupObservation(observation, generation), { runtimePath: state.runtimePath, cleanupReceiptPath: state.cleanupReceiptPath });
    } catch (error) { result.error = error instanceof Error ? error.message : String(error); }
  }
  return { confirmed: generations.length > 0 && observations.every(row => row.confirmed), observations,
    scope: "posthost Linux durable receipts and runtime/process absence only; not host stop_after completion" };
}
