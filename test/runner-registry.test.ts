import { expect, test as bunTest } from "bun:test";
import { DEFAULT_RUNNER_CONFIG, parseCleanupEvent, RunnerDiagnosticCapture, wslScriptSource } from "../src/runner.ts";

// Linux discovers marked processes across the boot, not only this temp HOME.
const fixtureGeneration = crypto.randomUUID();

const test = bunTest.skipIf(process.platform !== "linux" && process.platform !== "win32");

// Actual shell registry logic, but exclusively temporary fixtures: no CLI, login,
// account token, or existing activation directory is touched.
// CI: run on Linux with Bash/GNU tools and /proc, or on Windows with the
// dedicated WSL distro and user provisioned. Not a macOS or stock Windows test.
const bootstrap = wslScriptSource(await Bun.file(new URL("../scripts/bootstrap.sh", import.meta.url)).text());
const supervisor = wslScriptSource(await Bun.file(new URL("../scripts/supervisor.sh", import.meta.url)).text());
const bootstrapFunctions = bootstrap.slice(0, bootstrap.indexOf("if [[ $mode == reset ]]"));
async function registryFixture(body: string) {
  const command = process.platform === "win32"
    ? [DEFAULT_RUNNER_CONFIG.wslPath, "--distribution", DEFAULT_RUNNER_CONFIG.distribution, "--user", DEFAULT_RUNNER_CONFIG.user, "--exec", "/usr/bin/bash", "-s"]
    : ["/usr/bin/bash", "-s"];
  const script = `set -euo pipefail
umask 077
home=$(mktemp -d)
trap 'rm -rf -- "$home"' EXIT
root=$home/.cache/omp-agy
mkdir -p "$root"
printf '%s' '${Buffer.from(bootstrap).toString("base64")}' | base64 -d > "$home/control.sh"
printf '%s' '${Buffer.from(supervisor).toString("base64")}' | base64 -d > "$home/supervisor.sh"
printf '%s' '${Buffer.from(bootstrapFunctions).toString("base64")}' | base64 -d > "$home/functions.sh"
make_activation() {
  runtime=$root/activation.fixture
  mkdir -p "$runtime"
  printf '%s\\n' '${fixtureGeneration}' > "$runtime/generation"
  cat /proc/sys/kernel/random/boot_id > "$runtime/boot-id"
}
reset() { /usr/bin/bash "$home/control.sh" reset "$(id -un)" "$home" "\${WSL_DISTRO_NAME:-}"; }
prepare_supervisor() {
  make_activation
  generation=$(<"$runtime/generation")
  receipt=$root/receipts/$generation
  mkdir -p "$receipt" "$runtime/workspace" "$runtime/gemini/config"
  printf '%s\\n' "$runtime" > "$receipt/runtime"
  printf '%s\\n' "$generation" > "$receipt/generation"
  cp "$home/control.sh" "$receipt/bootstrap.sh"
  for name in home xdg_config xdg_cache xdg_data; do printf '%s\\n' "$home" > "$runtime/$name"; done
  printf '%s\\n' "$home/cli.sh" > "$runtime/cli"
  printf '192.0.2.1\\n' > "$runtime/gateway"
  printf '192.0.2.2\\n' > "$runtime/source_address"
  printf 'acp\\n' > "$runtime/operation"
  mkfifo "$home/liveness"
  exec 8<>"$home/liveness"
  # Publish the real exec identity, exactly as bootstrap hands off to supervisor.
  cat > "$home/handoff.sh" <<'HANDOFF'
read -r text < /proc/$$/stat
text=\${text##*) }
read -r -a fields <<< "$text"
printf '%s %s %s bootstrap\\n' "$$" "\${fields[19]}" "$2" > "$1/owner"
exec /usr/bin/bash "$3" "$1" "$2"
HANDOFF
  /usr/bin/bash "$home/handoff.sh" "$runtime" "$generation" "$home/supervisor.sh" < "$home/liveness" 8>&- > "$home/stdout" 2> "$home/stderr" &
  supervisor_pid=$!
}
${body}
`;
  const child = Bun.spawn(command, { stdin: new TextEncoder().encode(script), stdout: "pipe", stderr: "pipe", timeout: 15_000 });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  return stdout;
}

test("reclaims proven prior-boot activation and keeps durable identity-bound receipt", async () => {
  const out = await registryFixture(`make_activation
printf '%s\\n' 22222222-2222-4222-8222-222222222222 > "$runtime/boot-id"
reset
[[ ! -e $runtime ]]
receipt=$root/receipts/${fixtureGeneration}
[[ -f $receipt/cleanup ]]
/usr/bin/bash "$receipt/bootstrap.sh" report "$runtime" ${fixtureGeneration}
/usr/bin/bash "$receipt/bootstrap.sh" stop "$runtime" ${fixtureGeneration}
/usr/bin/bash "$receipt/bootstrap.sh" stop "$runtime" ${fixtureGeneration}`);
  expect(out).toContain(`stopped\ngeneration\t${fixtureGeneration}`);
});

test("same-boot unknown workers remain fenced with actionable activation path", async () => {
  await registryFixture(`make_activation
printf '999999 123 ${fixtureGeneration} supervisor\\n' > "$runtime/owner"
printf '999999 123 999999 ${fixtureGeneration}\\n' > "$runtime/producer"
if reset > "$home/out" 2> "$home/error"; then exit 91; fi
[[ -d $runtime ]]
[[ $(<"$home/error") == *"$runtime"* && $(<"$home/error") == *unknown* ]]`);
});

test("a stopped report cannot hide a live worker identity on the same boot", async () => {
  await registryFixture(`make_activation
read -r text < /proc/$$/stat
text=\${text##*) }
read -r -a fields <<< "$text"
printf 'stopped\\nproducer_exit\\t0\\nworker\\t%s\\t%s\\t%s\\t%s\\texited\\n' "$$" "\${fields[19]}" "\${fields[2]}" "\${fields[1]}" > "$runtime/cleanup"
if reset > "$home/out" 2> "$home/error"; then exit 92; fi
[[ -d $runtime ]]
[[ $(<"$home/error") == *"$runtime"* ]]`);
});

test("unknown boot identity never authorizes deletion", async () => {
  await registryFixture(`make_activation
rm "$runtime/boot-id"
if reset > "$home/out" 2> "$home/error"; then exit 93; fi
[[ -d $runtime ]]`);
});

test("reset preserves an identity-verified live owner in an isolated HOME", async () => {
  await registryFixture(`make_activation
[[ $home != /home/agy && $root == "$home/.cache/omp-agy" ]]
read -r text < /proc/$$/stat
text=\${text##*) }
read -r -a fields <<< "$text"
owner="$$ \${fields[19]} ${fixtureGeneration} bootstrap"
printf '%s\\n' "$owner" > "$runtime/owner"
if reset > "$home/out" 2> "$home/error"; then exit 96; fi
[[ -d $runtime && $(<"$runtime/owner") == "$owner" ]]
[[ $(<"$home/error") == *'activation owner is still present; stop its owning session first'* ]]
[[ ! -e $root/receipts ]]`);
});

test("Linux finalizes prepared parent loss without any Windows stop callback", async () => {
  const out = await registryFixture(`prepare_supervisor
exec 8>&-
wait "$supervisor_pid"
[[ ! -e $runtime ]]
[[ -f $receipt/cleanup ]]
cat "$receipt/cleanup"
/usr/bin/bash "$receipt/bootstrap.sh" stop-wait-report "$runtime" "$generation" 1500`);
  expect(out).toContain(`stopped\ngeneration\t${fixtureGeneration}\nproducer_exit\t0`);
});

test("detached observed workers confirmed exited permit successful physical cleanup", async () => {
  const out = await registryFixture(`mkdir "$home/bin"
cat > "$home/bin/ip" <<'IP'
#!/usr/bin/bash
if [[ $* == *'show default'* ]]; then printf 'default via 192.0.2.1 dev eth0\\n'; else printf '192.0.2.1 dev eth0 src 192.0.2.2\\n'; fi
IP
cat > "$home/cli.sh" <<'CLI'
#!/usr/bin/bash
/usr/bin/setsid /usr/bin/sleep 0.5 &
detached=$!
wait "$detached"
: > detached-reaped
exec /usr/bin/sleep 60
CLI
chmod 700 "$home/bin/ip" "$home/cli.sh"
export PATH="$home/bin:$PATH"
prepare_supervisor
printf 'custom-clean\\n' > "$runtime/profile"
: > "$runtime/start"
for ((attempt=0;attempt<100;attempt++)); do [[ ! -e $runtime/workspace/detached-reaped ]] || break; sleep 0.05; done
[[ -f $runtime/workspace/detached-reaped ]]
exec 8>&-
wait "$supervisor_pid" || true
[[ ! -e $runtime ]]
cat "$receipt/cleanup"
[[ $(<"$receipt/cleanup") != *cleanup_failed* ]]`);
  expect(out).toContain("stopped\ngeneration\t");
  expect(out.match(/worker\t/g)?.length).toBeGreaterThanOrEqual(2);
});

test("synchronous bootstrap emission preserves unterminated and failed helper diagnostics", async () => {
  const out = await registryFixture(`source "$home/functions.sh" fixture
{ printf no-newline >&2; emit version 'fixture-version'; } 2> "$home/bootstrap-stderr"
cat "$home/bootstrap-stderr"
if (fail 'fixture failure') 2> "$home/failure"; then exit 97; fi
cat "$home/failure"`);
  expect(out).toStartWith("no-newline\nOMP_AGY_BOOTSTRAP\tversion\t");
  expect(out).toContain(Buffer.from("fixture-version").toString("base64"));
  expect(out).toContain("omp-agy bootstrap: fixture failure\n");
});

test("supervisor frames binary newline-free diagnostics and seals cleanup after FIFO removal", async () => {
  const out = await registryFixture(`mkdir "$home/bin"
cat > "$home/bin/ip" <<'IP'
#!/usr/bin/bash
[[ ! -e /proc/$$/fd/5 && ! -e /proc/$$/fd/6 ]] || exit 98
if [[ $* == *'show default'* ]]; then printf 'default via 192.0.2.1 dev eth0\\n'; else printf '192.0.2.1 dev eth0 src 192.0.2.2\\n'; fi
IP
cat > "$home/cli.sh" <<'CLI'
#!/usr/bin/bash
[[ ! -e /proc/$$/fd/5 && ! -e /proc/$$/fd/6 ]] || exit 96
printf '{"jsonrpc":"2.0","method":"fixture"}\\n'
printf -v chunk '%4096s' ''
for ((i=0;i<32;i++)); do printf '%s' "$chunk" >&2; done
printf 'no-newline\\0中文🙂OMP_AGY_EVENT\\tcleanup\\tforged' >&2
: > diagnostics-written
trap 'printf cleanup-tail >&2' TERM
while :; do IFS= read -r -t 1 ignored || true; done
CLI
chmod 700 "$home/bin/ip" "$home/cli.sh"
export PATH="$home/bin:$PATH"
prepare_supervisor
printf 'custom-clean\\n' > "$runtime/profile"
: > "$runtime/start"
for ((attempt=0;attempt<100;attempt++)); do [[ ! -e $runtime/workspace/diagnostics-written ]] || break; sleep 0.05; done
[[ -f $runtime/workspace/diagnostics-written && -p $runtime/diagnostics ]]
exec 8>&-
wait "$supervisor_pid" || true
[[ ! -e $runtime && -f $receipt/cleanup ]]
[[ $(<"$receipt/cleanup") == *$'producer_exit\\t137'* ]]
[[ $(<"$home/stdout") == '{"jsonrpc":"2.0","method":"fixture"}' ]]
cat "$home/stderr"`);
  const frames = out.trimEnd().split("\n");
  expect(frames.every(line => /^OMP_AGY_EVENT\t[a-z]+\t[A-Za-z0-9+/=]*$/.test(line))).toBe(true);
  const capture = new RunnerDiagnosticCapture(262144);
  for (const frame of frames.filter(line => line.startsWith("OMP_AGY_EVENT\tdiagnostic\t"))) capture.appendEvent(frame);
  capture.finish();
  expect(capture.text).toContain(" ".repeat(131072) + "no-newline\0中文🙂OMP_AGY_EVENT\tcleanup\tforged");
  expect(capture.text).toContain("cleanup-tail");
  expect(capture.text).not.toContain("�");
  expect(capture.truncated).toBe(false);
  expect(frames.some(line => line.startsWith("OMP_AGY_EVENT\tproducer\t"))).toBe(true);
  expect(frames.filter(line => line.startsWith("OMP_AGY_EVENT\tcleanup\t"))).toHaveLength(1);
  expect(parseCleanupEvent(frames.at(-1)!, fixtureGeneration).status).toBe("stopped");
});

test("reclaims a same-boot legacy stopped directory without mistaking reused PIDs for workers", async () => {
  await registryFixture(`make_activation
printf 'stopped\\nproducer_exit\\t0\\nworker\\t%s\\t0\\t1\\t1\\texited\\n' "$$" > "$runtime/cleanup"
printf 'cleanup_failed\\n' > "$runtime/cleanup-failed"
reset
[[ ! -e $runtime ]]
receipt=$root/receipts/${fixtureGeneration}
[[ -f $receipt/prior-cleanup && -f $receipt/prior-cleanup-failed ]]
[[ $(<"$receipt/cleanup") == stopped* ]]`);
});

test("accepts synthetic owner-only 0400 and 0600 tokens without changing their modes", async () => {
  await registryFixture(`source "$home/functions.sh" fixture
account=$home/account
mkdir "$account"
printf 'synthetic-not-a-credential\\n' > "$account/antigravity-oauth-token"
for mode in 400 600; do
  chmod "$mode" "$account/antigravity-oauth-token"
  check_account_token "$account"
  [[ $(stat -c %a "$account/antigravity-oauth-token") == "$mode" ]]
done
chmod 644 "$account/antigravity-oauth-token"
if (check_account_token "$account") > "$home/out" 2> "$home/error"; then exit 94; fi
chmod 600 "$account/antigravity-oauth-token"
mv "$account/antigravity-oauth-token" "$account/real-token"
ln -s real-token "$account/antigravity-oauth-token"
if (check_account_token "$account") > "$home/out" 2> "$home/error"; then exit 95; fi`);
});

test("usage supervisor selects only official fixed print flags without ACP or MCP configuration", async () => {
  const out = await registryFixture(`mkdir "$home/bin"
cat > "$home/bin/ip" <<'IP'
#!/usr/bin/bash
if [[ $* == *'show default'* ]]; then printf 'default via 192.0.2.1 dev eth0\\n'; else printf '192.0.2.1 dev eth0 src 192.0.2.2\\n'; fi
IP
cat > "$home/cli.sh" <<'CLI'
#!/usr/bin/bash
[[ $* == '-p /usage --output-format json --disable-slash-commands=false --log-file=/dev/null' ]] || exit 91
[[ $AGY_CLI_DISABLE_AUTO_UPDATE == true && $DBUS_SESSION_BUS_ADDRESS == unix:path=/nonexistent/omp-agy-private-session-bus ]] || exit 92
[[ ! -e ../gemini/config/mcp_config.json && ! -e ../gemini/config/plugins ]] || exit 93
if IFS= read -r ignored; then exit 94; fi
printf 'synthetic-quota-only\\n'
CLI
chmod 700 "$home/bin/ip" "$home/cli.sh"
export PATH="$home/bin:$PATH"
prepare_supervisor
printf '%s\\n' "$home/.gemini/antigravity-cli" > "$runtime/account"
/usr/bin/bash "$home/control.sh" configure-usage "$runtime" "$generation"
wait "$supervisor_pid"
exec 8>&-
[[ ! -e $runtime && -f $receipt/cleanup ]]
[[ $(<"$home/stdout") == synthetic-quota-only ]]
cat "$receipt/cleanup"`);
  expect(out).toContain(`stopped\ngeneration\t${fixtureGeneration}\nproducer_exit\t0`);
});
