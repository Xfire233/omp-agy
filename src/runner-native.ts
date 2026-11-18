import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Readable, type Duplex, type Writable } from "node:stream";
import { deadline, operationWithDeadline } from "./runner-io.ts";
import type { CleanupReport, PreparedRunner, RunnerConfig, RunnerEvidence, RunnerStartOptions } from "./runner.ts";

const LOOPBACK = "127.0.0.1";
const blockedAccounts = new Set<string>();

// This static shell is the group's session leader (spawn detached). Only its
// own group can be signalled; the host never signals an exited/reused PGID.
// fd 3 is the parent's liveness channel, independent of a blocked ACP pipe.
// fd 4 is control-only, closed in the actual CLI before it inherits any fds.
const SUPERVISOR = String.raw`
umask 077
# Never signal group 0 if the host runtime did not honor detached spawn.
group=$(ps -o pgid= -p "$$" | tr -d '[:space:]')
[ "$group" = "$$" ] || exit 70
finish() {
  trap '' HUP INT TERM USR1
  kill -s TERM 0
  sleep 0.2
  # Revoke staged credentials even if the host disappeared. The host removes
  # the entire private tree after shutdown; this is only crash-path hygiene.
  rm -f "$HOME/.gemini/config/mcp_config.json"
  kill -s KILL 0
  exit 70
}
trap finish HUP INT TERM USR1
owner=$$
( IFS= read -r _ || :; kill -s USR1 "$owner" ) <&3 3<&- 4>&- >/dev/null &
exec 5<&0
"$@" <&5 3<&- 4>&- 5<&- &
producer=$!
exec 5<&- 3<&- 0<&-
printf 'ready %s\n' "$producer" >&4
wait "$producer"
printf 'exit %s\n' "$?" >&4
finish
`;

type NativeLimits = { startupTimeoutMs: number; cleanupTimeoutMs: number };
type StageStart = (options: RunnerStartOptions) => { profile: string; agent: string; mcp: string; appendInstructions?: string };

export async function bootstrapNativeRunner(input: RunnerConfig, limits: NativeLimits, stageStart: StageStart, signal?: AbortSignal): Promise<PreparedRunner> {
  if (process.platform !== "linux" && process.platform !== "darwin") throw new Error("Native runner is supported only on Linux and macOS; no fallback exists");
  if (input.wslPath !== undefined || input.distribution !== undefined || input.user !== undefined || input.home !== undefined ||
      input.xdgConfigHome !== undefined || input.xdgCacheHome !== undefined || input.xdgDataHome !== undefined) {
    throw new Error("Native runner does not accept WSL, HOME, or XDG overrides; it stages private settings");
  }
  const { cli, accountDirectory } = input;
  for (const [key, value] of Object.entries({ cli, accountDirectory })) {
    if (typeof value !== "string" || !isAbsolute(value) || /[\0\r\n]/.test(value)) throw new Error(`Native runner requires an explicit absolute ${key}`);
  }
  if (!cli || !accountDirectory) throw new Error("Native runner requires an explicit CLI and account directory");
  const uid = process.getuid!();
  const generation = crypto.randomUUID();
  let runtime: string | undefined;
  let preparation: Promise<{ executable: string; account: string }> | undefined;
  let paths: { executable: string; account: string };
  try {
    paths = await operationWithDeadline(limits.startupTimeoutMs, "Native runner preparation deadline exceeded", cancellation => preparation = (async () => {
      const [executable, account, base] = await Promise.all([realpath(cli), realpath(accountDirectory), realpath(tmpdir())]);
      cancellation.throwIfAborted();
      const [binary, accountStat] = await Promise.all([stat(executable), stat(account), access(executable, constants.X_OK)]);
      cancellation.throwIfAborted();
      if (!binary.isFile()) throw new Error("Native CLI must be an executable regular file");
      if (!accountStat.isDirectory() || accountStat.uid !== uid) throw new Error("Native account directory must be an existing directory owned by the current user");
      if (blockedAccounts.has(account)) throw new Error("cleanup_failed: an earlier native activation for this account has unconfirmed cleanup");
      runtime = await mkdtemp(join(base, "omp-agy-native-"));
      cancellation.throwIfAborted();
      const privateStat = await stat(runtime);
      if (privateStat.uid !== uid || (privateStat.mode & 0o777) !== 0o700) throw new Error("Native activation directory is not private");
      cancellation.throwIfAborted();
      for (const subdirectory of ["home/.gemini/config", "workspace", "xdg-config", "xdg-cache", "xdg-data", "tmp"]) {
        await mkdir(join(runtime, subdirectory), { recursive: true, mode: 0o700 });
        cancellation.throwIfAborted();
      }
      await symlink(account, join(runtime, "home/.gemini/antigravity-cli"), "dir");
      cancellation.throwIfAborted();
      return { executable, account };
    })(), signal);
  } catch (error) {
    if (preparation) {
      const cleanup = preparation.catch(() => {}).then(async () => {
        if (runtime) await rm(runtime, { recursive: true, force: true });
      });
      try { await deadline(cleanup, limits.cleanupTimeoutMs, "Native preparation cleanup deadline exceeded"); }
      catch { throw new Error("cleanup_failed: native preparation could not confirm removal of its private directory"); }
    }
    throw error;
  }
  if (!runtime) throw new Error("Native runner failed to establish a private directory");
  const root = runtime;
  const home = join(root, "home");
  const gemini = join(home, ".gemini");
  const config = join(gemini, "config");
  const workspace = join(root, "workspace");
  const evidence: RunnerEvidence = {
    mode: "native", generation, distribution: "", user: "", uid, gid: process.getgid!(), groups: process.getgroups?.().join(" ") ?? "",
    home, cli: paths.executable, version: "not probed", kernel: release(), mounts: "not isolated", sharedDirectories: "not isolated",
    interop: "native process", permissions: "private transient settings; current user privileges", route: "IPv4 loopback only",
    gateway: LOOPBACK, sourceAddress: LOOPBACK, workspace, windowsInterface: "", cleanupReceiptPath: "", stderr: "", stderrTruncated: false, workers: [],
  };
  let started = false;
  const stageAbort = new AbortController();
  let staging: Promise<void> | undefined;
  let owner: ReturnType<typeof spawn> | undefined;
  let liveness: Duplex | undefined;
  let control: Duplex | undefined;
  let ownerDone: Promise<number> | undefined;
  let producerExit: number | undefined;
  let stopping: Promise<CleanupReport> | undefined;
  const stop = (): Promise<CleanupReport> => stopping ??= (async () => {
    signal?.removeEventListener("abort", onAbort);
    stageAbort.abort(new Error("Native runner is stopping"));
    liveness?.destroy();
    owner?.stdin?.destroy();
    const report: CleanupReport = { status: "stopped", scope: "native-process-group", generation, workers: evidence.workers, errors: [] };
    // Wait for the leader's real exit, then probe (never signal) the group. A
    // still-present group or an unreadable group is not a successful cleanup.
    const proc = owner;
    const confirmation = async (cancellation: AbortSignal) => {
      await ownerDone;
      if (!proc?.pid) return;
      for (;;) {
        cancellation.throwIfAborted();
        try { process.kill(-proc.pid, 0); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; throw new Error("Cannot verify native process-group shutdown"); }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    };
    const terminated = operationWithDeadline(limits.cleanupTimeoutMs, "Native process-group shutdown is unconfirmed", confirmation);
    // Remove after shutdown so no supervised worker can recreate settings. Even
    // after failed confirmation, attempt to revoke the staged bearer and files.
    const removed = deadline((async () => {
      await staging?.catch(() => {});
      await terminated.catch(() => {});
      await rm(root, { recursive: true, force: true });
    })(), Math.min(limits.cleanupTimeoutMs + 1000, 2_147_483_647), "Native private directory removal is unconfirmed");
    const results = await Promise.allSettled([terminated, removed]);
    if (results[0].status === "rejected") report.errors.push("Native process-group shutdown is unconfirmed");
    if (results[1].status === "rejected") report.errors.push("Native private directory removal is unconfirmed");
    if (producerExit !== undefined) report.producerExit = producerExit;
    report.status = report.errors.length ? "cleanup_failed" : "stopped";
    if (report.status === "cleanup_failed") blockedAccounts.add(paths.account);
    if (results[0].status === "fulfilled") for (const worker of evidence.workers) worker.state = "exited";
    control?.destroy();
    owner?.stdout?.destroy();
    owner?.unref();
    evidence.cleanup = report;
    return report;
  })();
  const onAbort = () => { void stop(); };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) {
    const report = await stop();
    if (report.status === "cleanup_failed") throw new Error("cleanup_failed: cancelled native preparation could not be cleaned up");
    signal.throwIfAborted();
  }
  return {
    gateway: LOOPBACK, sourceAddress: LOOPBACK, workspace, evidence, stop,
    async startUsage() { throw new Error("AGY quota is unavailable in native mode; no WSL operation was attempted"); },
    async start(options) {
      signal?.throwIfAborted();
      if (started || stopping) throw new Error("Prepared runner may start only once");
      if (blockedAccounts.has(paths.account)) throw new Error("cleanup_failed: replacement native producer is blocked");
      const settings = stageStart(options);
      started = true;
      evidence.profile = options.profile;
      try {
        return await operationWithDeadline(limits.startupTimeoutMs, "Native ACP producer startup deadline exceeded", async cancellation => {
          staging = (async () => {
            const privateFile = { mode: 0o600, flag: "wx", signal: cancellation } as const;
            await writeFile(join(config, "mcp_config.json"), settings.mcp, privateFile);
            if (settings.profile === "custom-clean") {
              const plugin = join(config, "plugins", "omp-agy-clean");
              cancellation.throwIfAborted();
              await mkdir(join(plugin, "agents"), { recursive: true, mode: 0o700 });
              await writeFile(join(plugin, "plugin.json"), '{"name":"omp-agy-clean"}\n', privateFile);
              await writeFile(join(plugin, "agents", "omp-agy-clean.md"), settings.agent, privateFile);
            }
          })();
          await staging;
          cancellation.throwIfAborted();
          const args = ["acp", "--stdio", "--process-per-session", `--gemini-dir=${gemini}`, "--include-default-customizations=false"];
          if (settings.profile === "custom-clean") args.push("--agent=omp-agy-clean");
          const env: NodeJS.ProcessEnv = {
            PATH: "/usr/local/bin:/usr/bin:/bin", HOME: home, XDG_CONFIG_HOME: join(root, "xdg-config"), XDG_CACHE_HOME: join(root, "xdg-cache"),
            XDG_DATA_HOME: join(root, "xdg-data"), TMPDIR: join(root, "tmp"), AGY_CLI_DISABLE_AUTO_UPDATE: "true",
            DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent/omp-agy-private-session-bus",
          };
          for (const key of ["LANG", "LC_ALL", "LC_CTYPE", "TZ", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
            if (process.env[key] !== undefined) env[key] = process.env[key];
          }
          for (const key of ["NO_PROXY", "no_proxy"]) env[key] = [process.env.no_proxy, process.env.NO_PROXY, LOOPBACK, "localhost", "::1"].filter(Boolean).join(",");
          // Child stderr is discarded, not heuristically redacted. Neither the
          // bridge bearer nor account data is in the command line/environment.
          const child = owner = spawn("/bin/sh", ["-c", SUPERVISOR, "omp-agy-native", paths.executable, ...args], {
            cwd: workspace, env, detached: true, stdio: ["pipe", "pipe", "ignore", "pipe", "pipe"],
          });
          const input = child.stdin as Writable;
          liveness = child.stdio[3] as Duplex;
          control = child.stdio[4] as Duplex;
          input.on("error", () => {});
          liveness.on("error", () => {});
          child.stdout!.on("error", () => {});
          const ready = Promise.withResolvers<void>();
          ownerDone = new Promise(resolve => {
            child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGKILL" ? 137 : signal === "SIGTERM" ? 143 : 70)));
            child.once("error", () => { ready.reject(new Error("Native CLI supervisor could not launch")); resolve(70); });
          });
          evidence.supervisorPid = child.pid;
          evidence.pgid = child.pid;
          let pending = "", frames = 0;
          const invalidControl = () => {
            ready.reject(new Error("Invalid native supervisor control frame"));
            void stop();
          };
          control.on("error", invalidControl);
          control.setEncoding("utf8").on("data", (text: string) => {
            pending += text;
            if (pending.length > 128) { invalidControl(); return; }
            let end: number;
            while ((end = pending.indexOf("\n")) >= 0) {
              const line = pending.slice(0, end);
              pending = pending.slice(end + 1);
              const readyFrame = /^ready ([1-9]\d*)$/.exec(line);
              const exitFrame = /^exit (\d{1,3})$/.exec(line);
              if (++frames === 1 && readyFrame) {
                evidence.producerPid = Number(readyFrame[1]);
                evidence.workers.push({ pid: evidence.producerPid, pgid: child.pid!, parentPid: child.pid!, startTime: "", state: "observed" });
                ready.resolve();
              } else if (frames === 2 && exitFrame) producerExit = Number(exitFrame[1]);
              else { invalidControl(); return; }
            }
          });
          const exited = ownerDone.then(code => { void stop(); return producerExit ?? code; });
          await Promise.race([ready.promise, exited.then(() => { throw new Error("Native supervisor exited before ACP producer readiness"); })]);
          cancellation.throwIfAborted();
          if (stopping) throw new Error("Native runner stopped before ACP producer readiness");
          // Node's web stream declarations are separate from Bun's DOM types;
          // stdout has no text encoding and toWeb forwards Uint8Array/Buffer.
          const stdout = Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>;
          return {
            stdout, exited, evidence, appendInstructions: settings.appendInstructions, stop,
            stdin: new WritableStream<Uint8Array>({
              async write(chunk) {
                if (stopping) throw new Error("Native runner is stopping");
                try {
                  await operationWithDeadline(limits.startupTimeoutMs, "Native ACP write deadline exceeded", () => new Promise<void>((resolve, reject) => {
                    input.write(chunk, error => error ? reject(new Error("Native ACP pipe write failed")) : resolve());
                  }), stageAbort.signal);
                } catch (error) { void stop(); throw error; }
              },
              async close() { await stop(); },
              async abort() { await stop(); },
            }),
          };
        }, AbortSignal.any([stageAbort.signal, ...(signal ? [signal] : [])]));
      } catch (error) {
        const report = await stop();
        if (report.status === "cleanup_failed") throw new Error("cleanup_failed: native ACP startup failed and cleanup is unconfirmed");
        throw error;
      }
    },
  };
}
