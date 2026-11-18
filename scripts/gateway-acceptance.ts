import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { createBridge, type Bridge } from "../src/bridge.ts";
import { bootstrapRunner, DEFAULT_RUNNER_CONFIG, type PreparedRunner, type RunningRunner } from "../src/runner.ts";

// Explicit real WSL/network/account acceptance; never imported by bun test.
// bun scripts/gateway-acceptance.ts [output-directory]
// bun scripts/gateway-acceptance.ts --wrong-private-bearer [separate-output-directory]
// No model prompt, login, token-content read, retry, global shutdown, or distro termination.
interface HttpObservation {
  curlExit: number;
  status: number;
  remoteAddress: string;
  bodyBytes: number;
  body: string;
  sessionHeader: boolean;
  diagnostic: string;
}
interface HttpProbe {
  name: string;
  path: string;
  method?: string;
  authorization?: "valid" | "wrong";
  body?: string;
  contentType?: string;
  headers?: string[];
  expectedStatus: number;
  discoveryId?: string | number;
  emptyBody?: boolean;
}
const target = [DEFAULT_RUNNER_CONFIG.wslPath, "--distribution", DEFAULT_RUNNER_CONFIG.distribution, "--user", DEFAULT_RUNNER_CONFIG.user, "--cd", DEFAULT_RUNNER_CONFIG.home, "--exec", "/usr/bin/bash", "-s", "--"];
const encoder = new TextEncoder();
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function bounded<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(() => deadline.reject(new Error(`${label} deadline exceeded`)), milliseconds);
  try { return await Promise.race([promise, deadline.promise]); }
  finally { clearTimeout(timer); }
}
async function boundedText(stream: ReadableStream<Uint8Array>, child: Bun.Subprocess, limit = 131_072): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "", bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return text + decoder.decode();
      bytes += next.value.byteLength;
      if (bytes > limit) { child.kill(); throw new Error("Gateway observer output exceeded its bound"); }
      text += decoder.decode(next.value, { stream: true });
    }
  } finally { reader.releaseLock(); }
}
async function linux(script: string, args: string[] = []): Promise<{ output: string; diagnostic: string; exitCode: number }> {
  // Script (including private curl config) is stdin data, never a wsl/bash/curl argv value.
  const child = Bun.spawn([...target, ...args], { stdin: encoder.encode(script), stdout: "pipe", stderr: "pipe", timeout: 20_000 });
  const [output, diagnostic, exitCode] = await Promise.all([boundedText(child.stdout, child), boundedText(child.stderr, child, 16_384), child.exited]);
  return { output, diagnostic, exitCode };
}
const accountObserver = `set -euo pipefail
[[ $(id -un) == agy && $(id -u) != 0 && $WSL_DISTRO_NAME == omp-agy-wsl ]]
command -v curl >/dev/null
printf 'identity\\t'; id -un
printf 'account\\t'; stat -c '%d:%i uid=%u gid=%g mode=%a' /home/agy/.gemini/antigravity-cli
printf 'credentialMetadata\\t'; stat -c 'uid=%u gid=%g mode=%a' /home/agy/.gemini/antigravity-cli/antigravity-oauth-token
`;
async function accountState(): Promise<Record<string, string>> {
  const observed = await linux(accountObserver);
  assert(observed.exitCode === 0, `Account/curl prerequisites failed (${observed.exitCode}): ${observed.diagnostic}`);
  return Object.fromEntries(observed.output.trim().split("\n").map(line => {
    const tab = line.indexOf("\t");
    assert(tab > 0, "Invalid account observer frame");
    return [line.slice(0, tab), line.slice(tab + 1)];
  }));
}
async function http(bridge: Bridge, probe: HttpProbe): Promise<HttpObservation> {
  const endpoint = new URL(bridge.url);
  endpoint.pathname = probe.path;
  const config = [
    `url = ${JSON.stringify(endpoint.href)}`, `request = ${JSON.stringify(probe.method ?? "POST")}`,
    'noproxy = "*"', 'silent', 'show-error', 'include', 'connect-timeout = 3', 'max-time = 8', 'max-filesize = 65536',
    `header = ${JSON.stringify("Accept: application/json, text/event-stream")}`,
    `header = ${JSON.stringify(`Content-Type: ${probe.contentType ?? "application/json"}`)}`,
    ...(probe.authorization ? [`header = ${JSON.stringify(`Authorization: Bearer ${probe.authorization === "valid" ? bridge.token : "deliberately-incorrect"}`)}`] : []),
    ...(probe.headers ?? []).map(header => `header = ${JSON.stringify(header)}`),
    ...(probe.body !== undefined ? [`data = ${JSON.stringify(probe.body)}`] : []),
    'write-out = "\\nOMP_GATEWAY_HTTP\\t%{http_code}\\t%{remote_ip}\\t%{size_download}\\n"',
  ].join("\n");
  const marker = `OMP_AGY_PRIVATE_CURL_${crypto.randomUUID().replaceAll("-", "")}`;
  const result = await linux(`set -u\ncurl --config - <<'${marker}'\n${config}\n${marker}\nstatus=$?\nprintf 'OMP_GATEWAY_EXIT\\t%s\\n' "$status"\n`);
  assert(result.exitCode === 0, `Gateway observer process failed (${result.exitCode})`);
  const frame = /\nOMP_GATEWAY_HTTP\t(\d{3})\t([^\t\r\n]*)\t([^\r\n]+)\r?\nOMP_GATEWAY_EXIT\t(\d+)\r?\n?$/.exec(result.output);
  assert(frame, "Missing bounded curl HTTP evidence frame");
  const response = result.output.slice(0, frame.index);
  const separator = response.indexOf("\r\n\r\n") >= 0 ? "\r\n\r\n" : "\n\n";
  const split = response.indexOf(separator);
  const headers = split >= 0 ? response.slice(0, split) : "";
  const body = split >= 0 ? response.slice(split + separator.length) : response;
  return {
    curlExit: Number(frame[4]), status: Number(frame[1]), remoteAddress: frame[2]!, bodyBytes: Number(frame[3]), body,
    sessionHeader: /^mcp-session-id:/im.test(headers), diagnostic: result.diagnostic.trim(),
  };
}
const rpc = (id: string | number, method: string, params?: object) => JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });

async function main(): Promise<void> {
  const output = resolve(process.argv[2] ?? ".acceptance/gateway");
  await mkdir(output, { recursive: true });
  const failures: string[] = [];
  const cases: Record<string, unknown>[] = [];
  const report: Record<string, unknown> = {
    generatedAt: new Date().toISOString(), classification: "running", target: { distribution: "omp-agy-wsl", user: "agy", cli: "/home/agy/.local/bin/agy" },
    surface: "Changed production runner + Bun MCP bridge, curl executed inside exact WSL target, then official AGY ACP initialize/session-new; zero model generation",
    cases,
    limitations: ["No model generation or fresh tools/call execution is requested; the parent owns actual host tool execution acceptance.", "Discovery is tested before genuine CLI MCP initialization; no synthetic authenticated initialize consumes the CLI session.", "No token contents are read from persistent storage; private bridge bearer is transported only through stdin/config.", "Curl probes explicitly disable proxies and record the actual remote IP; actual CLI MCP initialization proves its private config/network path independently."],
  };
  let prepared: PreparedRunner | undefined;
  let running: RunningRunner | undefined;
  let bridge: Bridge | undefined;
  let connection: acp.ClientConnection | undefined;
  let sessionId: string | undefined;
  let beforeAccount: Record<string, string> | undefined;
  const persist = async () => {
    let serialized = JSON.stringify(report, null, 2);
    if (bridge) serialized = serialized.replaceAll(bridge.token, "[REDACTED]");
    serialized = serialized.replace(/Bearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]");
    assert(Buffer.byteLength(serialized) <= 262_144, "Gateway evidence exceeded 256KiB report bound");
    await writeFile(resolve(output, "report.json"), `${serialized}\n`);
  };
  try {
    // Runner bootstrap is deliberately first: gateway/source evidence is current, not cached.
    prepared = await bootstrapRunner();
    report.route = { gateway: prepared.gateway, sourceAddress: prepared.sourceAddress, windowsInterface: prepared.evidence.windowsInterface, route: prepared.evidence.route, version: prepared.evidence.version, uid: prepared.evidence.uid };
    beforeAccount = await accountState();
    report.accountBefore = beforeAccount;
    bridge = await createBridge({
      hostname: prepared.gateway, sourceAddress: prepared.sourceAddress,
      tools: [{ name: "read", description: "OMP native read identity for zero-generation catalog acceptance", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } }],
      limits: { maxBodyBytes: 16_384 }, onActivity() {}, onFatal(error) { failures.push(error.message); },
    });
    report.initialBridge = bridge.snapshot();
    const probes: HttpProbe[] = [
      { name: "well-known-root-anonymous", path: "/.well-known/oauth-protected-resource", method: "GET", expectedStatus: 404, emptyBody: true },
      { name: "well-known-mcp-anonymous", path: "/.well-known/oauth-protected-resource/mcp", method: "GET", expectedStatus: 404, emptyBody: true },
      { name: "well-known-method-gate", path: "/.well-known/oauth-protected-resource/mcp", method: "POST", expectedStatus: 405 },
    ];
    for (const id of [0, "probe-preserved", ""]) for (const authorization of [undefined, "wrong", "valid"] as const) {
      probes.push({ name: `preinitialize-discover-${typeof id}-${String(id) || "empty"}-${authorization ?? "missing"}`, path: "/mcp", body: rpc(id, "server/discover"), authorization, expectedStatus: 200, discoveryId: id });
    }
    for (const method of ["initialize", "tools/list", "tools/call"]) for (const authorization of [undefined, "wrong"] as const) {
      const params = method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "omp-agy-gateway-acceptance", version: "0.1.0" } } : method === "tools/call" ? { name: "read", arguments: { path: "not-executed" } } : {};
      probes.push({ name: `${method}-${authorization ?? "missing"}-bearer`, path: "/mcp", body: rpc(`denied-${method}`, method, params), authorization, expectedStatus: 401 });
    }
    probes.push(
      { name: "discover-wrong-host", path: "/mcp", body: rpc("host", "server/discover"), headers: ["Host: unexpected.invalid"], expectedStatus: 403 },
      { name: "discover-browser-origin", path: "/mcp", body: rpc("origin", "server/discover"), headers: ["Origin: https://unexpected.invalid"], expectedStatus: 403 },
      { name: "well-known-browser-origin", path: "/.well-known/oauth-protected-resource", method: "GET", headers: ["Origin: https://unexpected.invalid"], expectedStatus: 403 },
      { name: "exact-mcp-path", path: "/mcp/", body: rpc("path", "server/discover"), expectedStatus: 404 },
      { name: "exact-well-known-path", path: "/.well-known/oauth-protected-resource/unregistered", method: "GET", expectedStatus: 404 },
      { name: "unsupported-method", path: "/mcp", method: "PUT", expectedStatus: 405 },
      { name: "wrong-media-type", path: "/mcp", body: rpc("media", "server/discover"), contentType: "text/plain", expectedStatus: 415 },
      { name: "malformed-body", path: "/mcp", body: "{not-json", expectedStatus: 400 },
      { name: "oversized-body", path: "/mcp", body: " ".repeat(16_385), expectedStatus: 413 },
      { name: "nonfinite-decoded-number", path: "/mcp", body: '{"jsonrpc":"2.0","id":"numeric","method":"server/discover","params":{"n":1e400}}', expectedStatus: 400 },
      { name: "discover-invalid-params-not-exempt", path: "/mcp", body: '{"jsonrpc":"2.0","id":"invalid","method":"server/discover","params":[]}', expectedStatus: 401 },
      { name: "unknown-method-not-exempt", path: "/mcp", body: rpc("unknown", "server/discover-other"), expectedStatus: 401 },
    );
    for (const probe of probes) {
      const observed = await http(bridge, probe);
      const snapshot = bridge.snapshot();
      const evidence: Record<string, unknown> = {
        name: probe.name, method: probe.method ?? "POST", path: probe.path, expectedStatus: probe.expectedStatus,
        actualStatus: observed.status, curlExit: observed.curlExit, remoteAddress: observed.remoteAddress,
        bodyBytes: observed.bodyBytes, sessionHeader: observed.sessionHeader, bridge: snapshot,
      };
      cases.push(evidence);
      assert(observed.curlExit === 0 && observed.status === probe.expectedStatus, `${probe.name}: expected HTTP ${probe.expectedStatus}, observed HTTP ${observed.status}, curl ${observed.curlExit}: ${observed.diagnostic}`);
      assert(observed.remoteAddress === prepared.gateway, `${probe.name}: curl did not reach the current gateway directly`);
      if (probe.emptyBody) assert(observed.body === "", `${probe.name}: discovery exposed response data`);
      if (probe.discoveryId !== undefined) {
        const body = JSON.parse(observed.body) as { jsonrpc?: unknown; id?: unknown; error?: { code?: unknown }; result?: unknown };
        assert(body.jsonrpc === "2.0" && body.id === probe.discoveryId && body.error?.code === -32601 && body.result === undefined, `${probe.name}: probe id/error contract was not preserved`);
        evidence.response = body;
        assert(!observed.sessionHeader, `${probe.name}: discovery created an MCP session header`);
      }
      assert(!snapshot.revoked && !snapshot.initialized && snapshot.sessionCount === 0 && snapshot.pendingCount === 0 && snapshot.deliveredCount === 0 && failures.length === 0, `${probe.name}: external probe changed MCP activation/session/tool state`);
      evidence.classification = "observed";
      await persist();
    }
    report.beforeProducer = bridge.snapshot();
    running = await prepared.start({ url: bridge.url, token: bridge.token, aliases: bridge.aliases, profile: "custom-clean" });
    report.producer = { pid: running.evidence.producerPid, pgid: running.evidence.pgid, generation: running.evidence.generation };
    const updates: Record<string, number> = {};
    const app = acp.client({ name: "omp-agy" })
      .onNotification(acp.methods.client.session.update, ({ params }) => { const kind = params.update.sessionUpdate; updates[kind] = (updates[kind] ?? 0) + 1; })
      .onRequest(acp.methods.client.session.requestPermission, () => ({ outcome: { outcome: "cancelled" as const } }));
    connection = app.connect(acp.ndJsonStream(running.stdin, running.stdout, { maxMessageBytes: 8 * 1024 * 1024 }));
    const initialized = await bounded(connection.agent.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientInfo: { name: "omp-agy", title: "OMP Antigravity ACP extension", version: "0.1.0" }, clientCapabilities: {} }), 60_000, "Actual ACP initialize");
    assert(initialized.protocolVersion === acp.PROTOCOL_VERSION && initialized.agentCapabilities?.mcpCapabilities?.http, "Actual ACP agent did not advertise HTTP MCP capability");
    const session = await bounded(connection.agent.request(acp.methods.agent.session.new, { cwd: prepared.workspace, mcpServers: [] }), 60_000, "Actual ACP session/new");
    sessionId = session.sessionId;
    const selector = session.configOptions?.find(option => option.category === "model" || option.id === "model");
    const models = selector?.type === "select" ? selector.options.flatMap(option => "options" in option ? option.options : [option]) : [];
    report.actualProducer = { initialized: { protocolVersion: initialized.protocolVersion, agentInfo: initialized.agentInfo }, sessionCreated: Boolean(sessionId), modelCount: models.length, updates, bridge: bridge.snapshot(), diagnostic: running.evidence.stderr };
    assert(models.length > 0 && bridge.snapshot().initialized && bridge.snapshot().sessionCount === 1 && bridge.snapshot().catalogReadCount > 0 && failures.length === 0, "Genuine CLI failed to initialize/read private authenticated MCP catalog after external rejection probes");
    const postInitializedProbe = await http(bridge, { name: "post-initialize-discover-not-anonymous", path: "/mcp", body: rpc("late-discovery", "server/discover"), expectedStatus: 401 });
    assert(postInitializedProbe.status === 401 && !bridge.snapshot().revoked && failures.length === 0, "Anonymous server/discover exemption survived genuine initialization or revoked producer");
    cases.push({ name: "post-initialize-discover-not-anonymous", actualStatus: postInitializedProbe.status, bridge: bridge.snapshot(), classification: "observed" });
    report.classification = "observed";
  } catch (error) {
    report.classification = "failed";
    report.error = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  } finally {
    const reason = new Error("Gateway acceptance complete; revoke before producer cleanup");
    if (bridge) {
      report.beforeRevoke = bridge.snapshot();
      await bridge.revoke(reason);
      report.afterRevoke = bridge.snapshot();
      try {
        const stale = await http(bridge, { name: "stale-endpoint", path: "/mcp", body: rpc("stale", "tools/list"), authorization: "valid", expectedStatus: 0 });
        report.staleEndpoint = { curlExit: stale.curlExit, httpStatus: stale.status, remoteAddress: stale.remoteAddress, noHttpResponse: stale.curlExit !== 0 && stale.status === 0, capabilityRevoked: bridge.snapshot().revoked && !bridge.snapshot().accepting };
        assert(stale.curlExit !== 0 && stale.status === 0, "Revoked endpoint still accepts HTTP requests");
      } catch (error) { report.staleEndpointError = error instanceof Error ? error.message : String(error); report.classification = "failed"; process.exitCode = 1; }
    }
    if (connection && sessionId) await connection.agent.notify(acp.methods.agent.session.cancel, { sessionId }).catch(() => {});
    connection?.close(reason);
    const cleanup = await (running?.stop() ?? prepared?.stop());
    report.cleanup = cleanup;
    if (cleanup?.status !== "stopped") { report.classification = "failed"; process.exitCode = 1; }
    try {
      const afterAccount = await accountState();
      report.accountAfter = afterAccount;
      const accountPreserved = beforeAccount?.account === afterAccount.account && /uid=1000 gid=1000 mode=600\b/.test(afterAccount.credentialMetadata ?? "");
      const runtimeRemoved = prepared ? (await linux(`set -euo pipefail\nif [[ -e $1 ]]; then printf present; else printf removed; fi\n`, [dirname(prepared.workspace)])).output === "removed" : undefined;
      report.preservation = { accountPreserved, runtimeRemoved };
      if (!accountPreserved || !runtimeRemoved) { report.classification = "failed"; process.exitCode = 1; }
    } catch (error) { report.accountObservationError = error instanceof Error ? error.message : String(error); report.classification = "failed"; process.exitCode = 1; }
    report.bridgeFatalErrors = failures;
    await persist();
  }
  console.log(JSON.stringify({ classification: report.classification, probes: cases.length, report: resolve(output, "report.json") }));
}
async function wrongPrivateBearer(output: string): Promise<void> {
  await mkdir(output, { recursive: true });
  const report: Record<string, unknown> = {
    generatedAt: new Date().toISOString(), classification: "running",
    scenario: "deliberately wrong bearer in the production runner's private startup MCP configuration",
    target: { distribution: "omp-agy-wsl", user: "agy", cli: "/home/agy/.local/bin/agy" },
    externalCurlRequests: 0, modelPrompts: 0,
    limitations: ["This deliberately misconfigures only this activation's private bearer; no persistent credential is read or changed.", "The driver uses production runner/bridge plus actual CLI ACP, not SessionController; its old startup predicate is reported explicitly as an inference from the observed response."],
  };
  let prepared: PreparedRunner | undefined;
  let running: RunningRunner | undefined;
  let bridge: Bridge | undefined;
  let connection: acp.ClientConnection | undefined;
  let sessionId: string | undefined;
  let accountBefore: Record<string, string> | undefined;
  const wrongBearer = `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
  const bridgeFailures: string[] = [];
  try {
    prepared = await bootstrapRunner();
    accountBefore = await accountState();
    report.accountBefore = accountBefore;
    report.route = { gateway: prepared.gateway, sourceAddress: prepared.sourceAddress, version: prepared.evidence.version };
    bridge = await createBridge({
      hostname: prepared.gateway, sourceAddress: prepared.sourceAddress,
      tools: [{ name: "read", description: "Native OMP read identity; no execution in this diagnostic", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
      onActivity() {}, onFatal(error) { bridgeFailures.push(error.message); },
    });
    assert(wrongBearer !== bridge.token, "Diagnostic did not create a distinct private bearer");
    report.beforeProducer = bridge.snapshot();
    running = await prepared.start({ url: bridge.url, token: wrongBearer, aliases: bridge.aliases, profile: "custom-clean" });
    const staging = await linux(`set -euo pipefail\nruntime=$1\nexpected=${wrongBearer}\n[[ -f $runtime/gemini/config/mcp_config.json ]]\nprivate=$(<"$runtime/gemini/config/mcp_config.json")\n[[ $private == *"$expected"* ]]\nprintf 'wrongPrivateBearerConfirmed\\ttrue\\n'\nprintf 'privateConfigMode\\t'; stat -c %a "$runtime/gemini/config/mcp_config.json"\n`, [dirname(prepared.workspace)]);
    assert(staging.exitCode === 0, "Wrong private startup bearer was not confirmed in production runner config");
    report.privateStartupConfiguration = staging.output.trim();
    const updates: Record<string, number> = {};
    const app = acp.client({ name: "omp-agy" })
      .onNotification(acp.methods.client.session.update, ({ params }) => { const kind = params.update.sessionUpdate; updates[kind] = (updates[kind] ?? 0) + 1; })
      .onRequest(acp.methods.client.session.requestPermission, () => ({ outcome: { outcome: "cancelled" as const } }));
    connection = app.connect(acp.ndJsonStream(running.stdin, running.stdout, { maxMessageBytes: 8 * 1024 * 1024 }));
    const initialized = await bounded(connection.agent.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientInfo: { name: "omp-agy", title: "OMP Antigravity ACP extension", version: "0.1.0" }, clientCapabilities: {} }), 60_000, "Wrong-private-bearer ACP initialize");
    report.initialized = { protocolVersion: initialized.protocolVersion, agentInfo: initialized.agentInfo };
    const started = performance.now();
    let sessionSucceeded = false;
    let modelCount = 0;
    try {
      const session = await bounded(connection.agent.request(acp.methods.agent.session.new, { cwd: prepared.workspace, mcpServers: [] }), 60_000, "Wrong-private-bearer ACP session/new");
      sessionId = session.sessionId;
      sessionSucceeded = Boolean(sessionId);
      const selector = session.configOptions?.find(option => option.category === "model" || option.id === "model");
      modelCount = selector?.type === "select" ? selector.options.flatMap(option => "options" in option ? option.options : [option]).length : 0;
    } catch (error) { report.sessionError = error instanceof Error ? error.message : String(error); }
    const snapshot = bridge.snapshot();
    report.observation = {
      sessionNewSucceeded: sessionSucceeded, modelCount, durationMs: Math.round(performance.now() - started),
      updates, bridge: snapshot, diagnostic: running.evidence.stderr,
      ownMcpUnavailable: !snapshot.initialized && snapshot.catalogReadCount === 0,
      oldControllerStartupPredicateWouldAccept: sessionSucceeded && modelCount > 0 && !snapshot.initialized && snapshot.catalogReadCount === 0 && bridgeFailures.length === 0,
      predicateClassification: "[INFERENCE] Existing controller startup checked session-new/model availability without requiring private MCP initialization/catalog; this diagnostic does not execute that controller.",
    };
    report.classification = "observed";
  } catch (error) {
    report.classification = "failed";
    report.error = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  } finally {
    const reason = new Error("Wrong-private-bearer diagnostic complete");
    if (bridge) { await bridge.revoke(reason); report.afterRevoke = bridge.snapshot(); }
    if (connection && sessionId) await connection.agent.notify(acp.methods.agent.session.cancel, { sessionId }).catch(() => {});
    connection?.close(reason);
    const cleanup = await (running?.stop() ?? prepared?.stop());
    report.cleanup = cleanup;
    if (cleanup?.status !== "stopped") { report.classification = "failed"; process.exitCode = 1; }
    try {
      const accountAfter = await accountState();
      report.accountAfter = accountAfter;
      const preserved = accountBefore?.account === accountAfter.account && /uid=1000 gid=1000 mode=600\b/.test(accountAfter.credentialMetadata ?? "");
      report.accountPreserved = preserved;
      if (!preserved) { report.classification = "failed"; process.exitCode = 1; }
    } catch (error) { report.accountObservationError = error instanceof Error ? error.message : String(error); report.classification = "failed"; process.exitCode = 1; }
    report.bridgeFatalErrors = bridgeFailures;
    let serialized = JSON.stringify(report, null, 2).replaceAll(wrongBearer, "[REDACTED]");
    if (bridge) serialized = serialized.replaceAll(bridge.token, "[REDACTED]");
    serialized = serialized.replace(/Bearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]");
    assert(Buffer.byteLength(serialized) <= 262_144, "Wrong-private-bearer evidence exceeded its report bound");
    await writeFile(resolve(output, "report.json"), `${serialized}\n`);
  }
  console.log(JSON.stringify({ classification: report.classification, scenario: "wrong-private-bearer", report: resolve(output, "report.json") }));
}

if (import.meta.main) {
  if (process.argv[2] === "--wrong-private-bearer") await wrongPrivateBearer(resolve(process.argv[3] ?? ".acceptance/gateway/wrong-private-bearer"));
  else await main();
}
