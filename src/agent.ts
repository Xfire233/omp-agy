import type { ContentBlock, StopReason } from "@agentclientprotocol/sdk";
import type { PendingCall } from "./bridge.ts";
import type { ToolDefinition } from "./catalog.ts";
import { ActivationCleanupError, SessionController, type AdvertisedModel, type ControllerCallbacks, type ControllerEvent } from "./controller.ts";
import type { AgentPrompt, SessionConfig, SteeringReceipt } from "./protocol.ts";
import type { TrustedResult } from "./results.ts";
import type { RunnerFactory } from "./runner.ts";

export type AgentUpdate = ControllerEvent | { type: "tool_call"; call: PendingCall } | { type: "done"; stopReason: StopReason };

/** Runs only catalogued, schema-validated calls. The callback owns all authorization and side effects. */
export type ToolExecutor = (call: PendingCall, signal: AbortSignal) => TrustedResult | Promise<TrustedResult>;

export interface AgentOptions extends ControllerCallbacks {
  config?: Partial<SessionConfig>;
  /** Fixed for the session. No catalog means no caller tool capabilities. */
  tools?: readonly ToolDefinition[];
  /** Omit to handle each tool_call update yourself and return it with complete(). */
  executeTool?: ToolExecutor;
  /** Startup only. Use send(..., { signal }) or close() to cancel generation. */
  signal?: AbortSignal;
  /** Optional replacement for the built-in WSL/POSIX launcher. ACP and MCP policy are unchanged. */
  bootstrap?: RunnerFactory;
  /** Explicit system prompt for the runner's omp-system profile, irrespective of caller. */
  hostSystemPrompt?: string;
}

interface Turn {
  abort: AbortController;
  external?: AbortSignal;
  cancel?: () => void;
  receiving: boolean;
}

function promptBlocks(prompt: AgentPrompt): ContentBlock[] {
  return typeof prompt === "string" ? [{ type: "text", text: prompt }] : [...prompt];
}

/** One Antigravity conversation and one active turn. Use `try/finally` and await close(). */
export class Agent {
  private turn?: Turn;

  private constructor(private readonly controller: SessionController, private readonly executeTool?: ToolExecutor) {}

  /** Start the configured CLI and verify ACP session and MCP catalog readiness. */
  static async open({ config, tools = [], executeTool, signal, hostSystemPrompt, bootstrap, ...callbacks }: AgentOptions = {}): Promise<Agent> {
    let agent: Agent | undefined;
    const controller = await SessionController.open({ ...config, profile: config?.profile ?? "custom-clean" }, tools, {
      ...callbacks,
      failed(error) {
        agent?.turn?.abort.abort(error);
        callbacks.failed?.(error);
      },
    }, signal, hostSystemPrompt, bootstrap);
    agent = new Agent(controller, executeTool);
    return agent;
  }

  get sessionId() { return this.controller.sessionId; }
  get models(): readonly AdvertisedModel[] { return this.controller.models; }
  get selectedModel() { return this.controller.selectedModel; }
  get thinking() { return this.controller.thinking; }
  get capabilities() { return this.controller.capabilities; }
  /** Published MCP names and the corresponding original caller tool names. */
  get catalog() { return this.controller.bridge.catalog; }
  get cleanup() { return this.controller.cleanup; }

  selectModel(id: string): Promise<void> { return this.controller.selectModel(id); }
  selectThinking(value: string): Promise<void> { return this.controller.selectThinking({ reasoning: value }); }

  /** Submit one prompt. Start consuming receive() promptly, before submitting another prompt. */
  send(prompt: AgentPrompt, { signal }: { signal?: AbortSignal } = {}): void {
    signal?.throwIfAborted();
    if (this.turn) throw new Error("Drain the active turn with receive() before sending another prompt");
    const controller = this.controller;
    if (controller.failure) throw controller.failure;
    if (controller.phase !== "idle") throw new Error(`Cannot send while AGY session is ${controller.phase}`);
    if (!controller.models.some(model => model.id === controller.selectedModel)) throw new Error("Select an advertised model before sending");
    const blocks = promptBlocks(prompt);
    if (!blocks.length || blocks.every(block => block.type === "text" && !block.text)) throw new Error("Cannot send an empty prompt");
    controller.begin(blocks);
    const turn: Turn = { abort: new AbortController(), external: signal, receiving: false };
    this.turn = turn;
    if (signal) {
      turn.cancel = () => { void this.close(signal.reason).catch(() => {}); };
      signal.addEventListener("abort", turn.cancel, { once: true });
      if (signal.aborted) turn.cancel();
    }
  }

  /** Send replacement input to the active flight, not a new turn. Receipt does not mean turn success. */
  async steer(prompt: AgentPrompt, receipt?: SteeringReceipt): Promise<void> {
    if (this.controller.bridge.pendingCount) {
      receipt?.onUnsent?.();
      throw new Error("Finish outstanding tool work before steering this session");
    }
    await this.controller.steer(promptBlocks(prompt), receipt);
  }

  /**
   * Drain a submitted turn as an async iterable. Exactly one receiver per turn.
   * Failure rejects the iterator; leaving early closes the session (no replay).
   * Without an executor, return each tool_call's result via complete() before waiting for the turn to finish.
   * For example: `if (update.type === "tool_call") await agent.complete(update.call.id, result)`.
   */
  async *receive(): AsyncGenerator<AgentUpdate, void> {
    const turn = this.turn;
    if (!turn) throw new Error("Submit a prompt with send() before calling receive()");
    if (turn.receiving) throw new Error("The turn already has a receiver");
    turn.receiving = true;
    const controller = this.controller;
    let done: StopReason | undefined;
    let failure: unknown;
    try {
      for (;;) {
        const version = controller.version;
        turn.abort.signal.throwIfAborted();
        if (controller.failure) throw controller.failure;
        if (controller.phase !== "active") throw new Error(`AGY session is ${controller.phase}`);
        const update = controller.shiftEvent();
        if (update) { yield update; continue; }
        const call = controller.takeNext();
        if (call) {
          controller.guardToolHandoff();
          if (controller.failure) throw controller.failure;
          if (this.executeTool) void this.runTool(call, this.executeTool, turn.abort.signal);
          yield { type: "tool_call", call };
          continue;
        }
        if (!controller.activeFlights && !controller.hasCandidate && !controller.bridge.pendingCount) {
          done = controller.finishTurn();
          break;
        }
        await controller.wait(version, turn.abort.signal);
      }
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      if (turn.cancel) turn.external?.removeEventListener("abort", turn.cancel);
      try {
        if (done === undefined) await this.close(failure ?? new Error("AGY turn receiver stopped before completion"));
      } finally { this.turn = undefined; }
    }
    if (done !== undefined) yield { type: "done", stopReason: done };
  }

  /** Return the result for a tool_call update exactly once in manual mode. */
  async complete(id: string, result: TrustedResult): Promise<void> {
    if (this.executeTool) throw new Error("The configured executor owns tool completion");
    this.turn?.abort.signal.throwIfAborted();
    if (this.controller.phase !== "active" || this.controller.failure) throw new Error("No active tool work to complete");
    await this.controller.complete(id, result);
  }

  private async runTool(call: PendingCall, execute: ToolExecutor, signal: AbortSignal): Promise<void> {
    const id = call.id;
    try {
      const result = await execute(call, signal);
      signal.throwIfAborted();
      await this.controller.complete(id, result);
    } catch (error) {
      // An executor may report ordinary tool failures as results. A throw is an
      // integration failure: effects may have occurred, so never retry the call.
      if (!signal.aborted) await this.controller.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** Revoke bridge work, cancel ACP, and wait for producer cleanup. Does not undo tool effects. */
  async close(reason: unknown = new Error("AGY session closed")): Promise<void> {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    const turn = this.turn;
    if (turn?.cancel) turn.external?.removeEventListener("abort", turn.cancel);
    turn?.abort.abort(error);
    await this.controller.stop(error);
    if (this.controller.phase === "cleanup_failed") {
      throw this.controller.failure ?? new ActivationCleanupError(this.controller.cleanup, "unconfirmed session cleanup");
    }
  }
}
