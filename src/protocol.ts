import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { RunnerConfig, RunnerProfile } from "./runner.ts";

/** Portable session settings. Runner defaults are used when runner is omitted. */
export interface SessionConfig {
  profile: RunnerProfile;
  /** User instructions interpreted according to the selected runner profile. */
  instructions?: string;
  /** Restrict selection to these exact IDs advertised by the live CLI. */
  allowedModels?: readonly string[];
  runner?: RunnerConfig;
  /** Steering receipt idle window in milliseconds (default 30 seconds). Official output extends it. */
  steeringConfirmationMs?: number;
}

/** Model discovery never receives or submits a caller's system prompt. */
export function discoveryConfig<T extends SessionConfig>(config: T): T {
  return config.profile === "omp-system" ? { ...config, profile: "custom-clean", instructions: undefined } : config;
}

/** A prompt is caller-prepared; the controller does not inject host history or instructions. */
export type AgentPrompt = string | readonly ContentBlock[];

/** Portable blocks for tool results; use a trusted MCP envelope for other MCP block types. */
export type ToolResultContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** Exact live ACP selector values and labels. */
export interface ThoughtOptions {
  configId: string;
  currentValue: string;
  options: { value: string; name: string }[];
}

/** Configuration failed before a prompt was submitted. */
export class ThinkingSelectionError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "ThinkingSelectionError"; }
}

/** Settle caller-owned input at most once. An unknown receipt never requests retransmission. */
export interface SteeringReceipt {
  /** Official echo or a non-cancelled response confirmed submission (not task success). */
  onReceived?: () => void;
  /** Rejected before submission; the caller still owns the input. */
  onUnsent?: () => void;
  /** Submitted but not confirmed. Do not resend automatically. */
  onUncertain?: (error: Error) => void;
}
