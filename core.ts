/** Standalone Antigravity ACP/MCP session for Bun; this entry does not load the OMP extension. */
export { Agent, type AgentOptions, type AgentUpdate, type ToolExecutor } from "./src/agent.ts";
export { SessionController, ActivationCleanupError, discoverModels, type AdvertisedModel, type ControllerCallbacks, type ControllerEvent, type ModelDiscovery } from "./src/controller.ts";
export { ThinkingSelectionError, type AgentPrompt, type SessionConfig, type SteeringReceipt, type ThoughtOptions, type ToolResultContent } from "./src/protocol.ts";
export type { PendingCall } from "./src/bridge.ts";
export type { Catalog, ToolDefinition } from "./src/catalog.ts";
export type { DebugContext, DebugObserver } from "./src/debug.ts";
export { bootstrapRunner, DEFAULT_RUNNER_CONFIG, RUNNER_PROFILES, runnerCapabilities, type CleanupReport, type PreparedRunner, type RunnerConfig, type RunnerEvidence, type RunnerFactory, type RunnerMode, type RunnerProfile, type RunnerStartOptions, type RunningRunner } from "./src/runner.ts";
export type { TrustedResult } from "./src/results.ts";
export type { ContentBlock, StopReason } from "@agentclientprotocol/sdk";
