import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { win32 } from "node:path";
import { DEFAULT_RUNNER_CONFIG, type RunnerConfig } from "./runner.ts";

export type AccountLoginContext = Pick<ExtensionContext, "mode" | "hasUI" | "agent" | "ui">;

export interface AccountLoginResult {
  /** Foreground process exit status only. Even zero does not verify login. */
  exitCode: number;
}
interface TerminalUI {
  stop(): void;
  start(): void;
  requestRender(force: boolean): void;
}

const LOGIN_SCRIPT = new URL("../scripts/account-login.sh", import.meta.url);
const LOCAL_TUI_REQUIRED = "AGY account login requires the main local OMP TUI with terminal input and output.";
const { wslPath, distribution, user, home } = DEFAULT_RUNNER_CONFIG;
const windowsCwd = win32.dirname(wslPath);

/** Check before offering confirmation; does not start WSL or change terminal state. */
export function validateAccountLogin(ctx: AccountLoginContext, runner: RunnerConfig = {}): void {
  if (runner.mode === "native") throw new Error("For native AGY, manage sign-in directly with your installed CLI. /agy-login only changes the dedicated WSL account.");
  if (ctx.mode !== "tui" || !ctx.hasUI || ctx.agent?.kind !== "main" || typeof ctx.ui?.custom !== "function"
      || !process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY) {
    throw new Error(LOCAL_TUI_REQUIRED);
  }
  if (process.platform !== "win32") throw new Error("AGY account login requires the dedicated Windows WSL runner.");
  for (const [key, value] of Object.entries(runner)) {
    if (key === "mode" && value === "wsl") continue;
    if (!Object.hasOwn(DEFAULT_RUNNER_CONFIG, key) ||
        (value !== undefined && value !== DEFAULT_RUNNER_CONFIG[key as keyof typeof DEFAULT_RUNNER_CONFIG])) {
      throw new Error("AGY account login only supports the default WSL runner; remove runner overrides first.");
    }
  }
}

async function runInTerminal(tui: TerminalUI, command: string[]): Promise<AccountLoginResult> {
  try {
    try { tui.stop(); }
    catch { throw new Error("Could not release the OMP terminal for AGY account login."); }
    try {
      const exitCode = await Bun.spawn(command, {
        stdin: "inherit", stdout: "inherit", stderr: "inherit",
        cwd: windowsCwd, env: { SystemRoot: win32.dirname(windowsCwd) },
      }).exited;
      return { exitCode };
    } catch {
      // Raw spawn errors may include the command line. Child output stays in the terminal.
      throw new Error("Could not run the foreground AGY account login process.");
    }
  } finally {
    try { tui.start(); tui.requestRender(true); }
    catch { throw new Error("Could not restore the OMP terminal after AGY account login."); }
  }
}

/** Give the official CLI the foreground terminal; no authentication text passes through OMP. */
export async function openAccountLogin(ctx: AccountLoginContext, runner: RunnerConfig = {}): Promise<AccountLoginResult> {
  validateAccountLogin(ctx, runner);
  let source: string;
  try {
    source = (await Bun.file(LOGIN_SCRIPT).text()).replace(/\r\n/g, "\n");
    if (!source.trim()) throw new Error();
  } catch {
    throw new Error("Could not load the bundled AGY account login script.");
  }
  // Pass only repository-owned source, not user input. Base64 keeps Windows argv
  // quoting independent of the script, and bash -c leaves fd 0 free for login.
  const encoded = Buffer.from(source).toString("base64");
  const command = [wslPath, "--distribution", distribution, "--user", user, "--cd", home,
    "--exec", "/usr/bin/bash", "-p", "-c", `source <(/usr/bin/base64 -d <<<'${encoded}')`];

  let handoff: Promise<AccountLoginResult> | undefined;
  try {
    await ctx.ui.custom<void>(async (tui, _theme, _keys, done) => {
      if (!handoff && tui && typeof tui.stop === "function" && typeof tui.start === "function" && typeof tui.requestRender === "function") {
        handoff = runInTerminal(tui, command);
        await handoff.catch(() => {}); // The caller receives the sanitized error below.
      }
      done();
      return { render: () => [], invalidate: () => {} };
    });
  } catch {
    // If custom UI closes while the process owns the terminal, wait for the
    // child and TUI restoration before reporting any UI failure.
    if (handoff) await handoff;
    throw new Error("Could not open the OMP terminal for AGY account login.");
  }
  // A headless custom() stub may return without invoking its factory.
  if (!handoff) throw new Error(LOCAL_TUI_REQUIRED);
  return handoff;
}
