import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { ProviderRuntime } from "../src/provider.ts";
import { SessionController } from "../src/controller.ts";
import { ProviderRuntime as PublicRuntime, SessionController as PublicController } from "../index.ts";
import cleanupAuditExtension from "./cleanup-audit-extension.ts";

// Acceptance-only entry, loaded instead of index.ts. The existing cleanup audit
// delegates the unchanged production factory in this same isolated module graph.
// No prompt, stream, permission, model, result or cleanup implementation is changed.
const MARKER = Symbol.for("omp-agy.acceptance.context-audit.v1");
const MAX_RECORDS = 64;
type StreamMethod = ProviderRuntime["stream"];
type BeginMethod = SessionController["begin"];

export default async function contextAuditExtension(pi: ExtensionAPI): Promise<void> {
  const path = process.env.OMP_AGY_CONTEXT_AUDIT_PATH;
  const fixturePath = process.env.OMP_AGY_CONTEXT_FIXTURE_PATH;
  if (!path || !fixturePath || !isAbsolute(path) || !isAbsolute(fixturePath)) throw new Error("Context audit requires explicit absolute evidence and fixture paths");
  if (ProviderRuntime !== PublicRuntime || SessionController !== PublicController) throw new Error("Context audit production class identity is unproven");
  const prior = Object.getOwnPropertyDescriptor(SessionController.prototype, MARKER)?.value;
  if (prior) {
    if (prior !== path) throw new Error("Context audit path changed within one host");
    await cleanupAuditExtension(pi); return;
  }
  const fixture = readFileSync(fixturePath, "utf8");
  if (fixture.length > 4096) throw new Error("Context audit fixture exceeds its bound");
  const fileMarker = fixture.match(/FILE_CONTEXT_[0-9a-f]{32}/)?.[0];
  const systemIndex = process.argv.indexOf("--system-prompt");
  const systemMarker = systemIndex >= 0 ? process.argv[systemIndex + 1]?.match(/SYS_CONTEXT_[0-9a-f]{32}/)?.[0] : undefined;
  if (!fileMarker || !systemMarker || fileMarker === systemMarker) throw new Error("Independent fixture and standalone CLI system markers are required");
  const fd = openSync(path, "a", 0o600); let sequence = 0; let failed = false;
  const append = (fields: Record<string, unknown>) => {
    if (failed) return;
    try {
      if (++sequence > MAX_RECORDS) { writeSync(fd, JSON.stringify({ kind: "audit_truncated", maxRecords: MAX_RECORDS }) + "\n"); failed = true; return; }
      writeSync(fd, JSON.stringify({ schemaVersion: 1, sequence, processId: process.pid, ...fields }) + "\n");
    } catch { failed = true; }
  };
  const originalStream = ProviderRuntime.prototype.stream;
  const streamDescriptor = Object.getOwnPropertyDescriptor(ProviderRuntime.prototype, "stream");
  const beginDescriptor = Object.getOwnPropertyDescriptor(SessionController.prototype, "begin");
  const originalBegin = SessionController.prototype.begin;
  if (!streamDescriptor || !beginDescriptor) { closeSync(fd); throw new Error("Context audit source methods are missing"); }
  const wrappedStream: StreamMethod = function (this: ProviderRuntime, ...args: Parameters<StreamMethod>): ReturnType<StreamMethod> {
    const context = args[1];
    const text = context.messages.map(message => typeof message.content === "string" ? message.content :
      message.content.filter(block => block.type === "text").map(block => block.type === "text" ? block.text : "").join("\n")).join("\n");
    append({ kind: "provider_context", classIdentityMatchesPublicExport: ProviderRuntime === PublicRuntime,
      receiverUsesSourceClass: this instanceof ProviderRuntime, hookIsCurrent: this.stream === wrappedStream,
      standaloneSystemMarkerPresent: context.systemPrompt?.includes(systemMarker) === true,
      standaloneSystemMarkerInEffectiveMessages: text.includes(systemMarker), fileMarkerInEffectiveMessages: text.includes(fileMarker),
      messageCount: context.messages.length, effectiveTextCharacters: text.length });
    return originalStream.apply(this, args);
  };
  const wrappedBegin: BeginMethod = function (this: SessionController, ...args: Parameters<BeginMethod>): ReturnType<BeginMethod> {
    const prompt = args[0]; const chunks = prompt.filter(block => block.type === "text");
    const text = chunks.map(block => block.text).join("\n");
    append({ kind: "acp_begin", classIdentityMatchesPublicExport: SessionController === PublicController,
      generation: this.snapshot().generation,
      receiverUsesSourceClass: this instanceof SessionController, hookIsCurrent: this.begin === wrappedBegin,
      fileMarkerPresent: text.includes(fileMarker), standaloneSystemMarkerPresent: text.includes(systemMarker),
      contentBlockCount: prompt.length, textBlockCount: chunks.length, textCharacters: text.length });
    return originalBegin.apply(this, args);
  };
  Object.defineProperty(ProviderRuntime.prototype, "stream", { ...streamDescriptor, value: wrappedStream });
  Object.defineProperty(SessionController.prototype, "begin", { ...beginDescriptor, value: wrappedBegin });
  Object.defineProperty(SessionController.prototype, MARKER, { value: path });
  process.once("exit", () => { try { closeSync(fd); } catch { /* External harness checks receipt completeness. */ } });
  append({ kind: "audit_install", classIdentityMatchesPublicExport: true, delegatesActualProductionFactory: true,
    fixtureMarkerSource: "fixture contents only; no marker literal in user prompt", systemMarkerSource: "standalone --system-prompt argv only",
    recordsContainOnlyBooleansCountsGenerationAndIdentityAssertions: true });
  await cleanupAuditExtension(pi);
}
