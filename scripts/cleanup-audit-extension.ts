import { closeSync, fstatSync, openSync, writeSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionController } from "../src/controller.ts";
import productionExtension, { SessionController as PublicSessionController } from "../index.ts";
import type { PreparedRunner, WorkerEvidence } from "../src/runner.ts";
import type { BridgeSnapshot } from "../src/bridge.ts";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

// Acceptance-only -e wrapper, loaded INSTEAD OF a separate index.ts entry. OMP
// isolates separate extension module graphs; delegating the real production
// factory here guarantees the intercepted class is the one that factory uses.
// No production behavior, result, permission or cleanup implementation is changed.
// The harness supplies a unique absolute, already-parented temporary audit path.
const PATH_ENV = "OMP_AGY_CLEANUP_AUDIT_PATH";
const MARKER = Symbol.for("omp-agy.acceptance.cleanup-audit.v1");
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_RECORDS = 4096;
const MAX_WORKERS = 128;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,160}$/;

type StopMethod = (this: SessionController, reason?: Error) => Promise<void>;
interface AuditState {
  path: string;
  fd: number;
  auditId: string;
  sequence: number;
  callSequence: number;
  bytes: number;
  truncated: boolean;
  writeFailed: boolean;
}
interface AuditSnapshot {
  snapshotAvailable: boolean;
  phase?: string;
  generation?: string;
  acpSessionId?: string;
  runtimePath?: string;
  cleanupReceiptPath?: string;
  distribution?: string;
  user?: string;
  home?: string;
  supervisorStartTime?: string;
  activeFlights?: number;
  candidate?: boolean;
  supervisorPid?: number;
  producerPid?: number;
  pgid?: number;
  workers?: WorkerEvidence[];
  workersTruncated?: boolean;
  bridge?: BridgeSnapshot;
  cleanup?: {
    status: "stopped" | "cleanup_failed";
    generation: string;
    workers: WorkerEvidence[];
    workersTruncated: boolean;
    errorCount: number;
    producerExit?: number;
  };
}

function capture(controller: SessionController): AuditSnapshot {
  try {
    // This public source getter also covers prepared/discovery identities before
    // runner assignment. No messages, model output, failure text or tool args.
    const snapshot = controller.snapshot();
    const generation = typeof snapshot.generation === "string" && IDENTIFIER.test(snapshot.generation) ? snapshot.generation : undefined;
    const session = controller.sessionId && IDENTIFIER.test(controller.sessionId) ? controller.sessionId : undefined;
    const workers = controller.runner?.evidence.workers ?? [];
    const cleanup = controller.cleanup;
    // Prepared-only failures must retain the same durable identity as running
    // sessions. This read-only audit never stops or reconfigures that runner.
    // TypeScript privacy hides this source-owned field, not its runtime shape.
    const auditedController = controller as unknown as { prepared?: PreparedRunner };
    const evidence = controller.runner?.evidence ?? auditedController.prepared?.evidence;
    const bridge = controller.bridge?.snapshot();
    return {
      snapshotAvailable: true,
      phase: controller.phase,
      generation,
      acpSessionId: session,
      runtimePath: evidence ? dirname(evidence.workspace).replaceAll("\\", "/") : undefined,
      cleanupReceiptPath: evidence?.cleanupReceiptPath,
      distribution: evidence?.distribution,
      user: evidence?.user,
      home: evidence?.home,
      supervisorStartTime: evidence?.supervisorStartTime,
      activeFlights: controller.activeFlights,
      candidate: controller.hasCandidate,
      supervisorPid: controller.runner?.evidence.supervisorPid,
      producerPid: controller.runner?.evidence.producerPid,
      pgid: controller.runner?.evidence.pgid,
      workers: workers.slice(0, MAX_WORKERS).map(worker => ({ pid: worker.pid, startTime: /^\d+$/.test(worker.startTime) ? worker.startTime : "invalid", pgid: worker.pgid, parentPid: worker.parentPid, state: worker.state })),
      workersTruncated: workers.length > MAX_WORKERS,
      bridge: bridge ? {
        accepting: bridge.accepting, revoked: bridge.revoked, initialized: bridge.initialized,
        activeTurn: bridge.activeTurn, sessionCount: bridge.sessionCount, connections: bridge.connections,
        pendingCount: bridge.pendingCount, queuedCount: bridge.queuedCount,
        dispatchedCount: bridge.dispatchedCount, deliveringCount: bridge.deliveringCount,
        deliveredCount: bridge.deliveredCount,
        catalogReadCount: bridge.catalogReadCount,
      } : undefined,
      cleanup: cleanup ? {
        status: cleanup.status,
        generation: IDENTIFIER.test(cleanup.generation) ? cleanup.generation : "invalid",
        workers: cleanup.workers.slice(0, MAX_WORKERS).map(worker => ({ pid: worker.pid, startTime: /^\d+$/.test(worker.startTime) ? worker.startTime : "invalid", pgid: worker.pgid, parentPid: worker.parentPid, state: worker.state })),
        workersTruncated: cleanup.workers.length > MAX_WORKERS,
        errorCount: cleanup.errors.length,
        producerExit: cleanup.producerExit,
      } : undefined,
    };
  } catch {
    // Missing snapshot evidence must fail acceptance, not replace a real stop's
    // outcome or prevent the original method from being invoked.
    return { snapshotAvailable: false };
  }
}

function append(state: AuditState, fields: Record<string, unknown>): void {
  if (state.truncated || state.writeFailed) return;
  try {
    let record = JSON.stringify({
      schemaVersion: 1, auditId: state.auditId, sequence: ++state.sequence,
      at: new Date().toISOString(), monotonicMs: performance.now(), processId: process.pid,
      ...fields,
    }) + "\n";
    let bytes = Buffer.from(record);
    if (bytes.byteLength > MAX_RECORD_BYTES || state.sequence > MAX_RECORDS || state.bytes + bytes.byteLength > MAX_BYTES - 1024) {
      state.truncated = true;
      record = JSON.stringify({ schemaVersion: 1, kind: "audit_truncated", auditId: state.auditId, sequence: state.sequence, processId: process.pid, maxBytes: MAX_BYTES, maxRecords: MAX_RECORDS, maxRecordBytes: MAX_RECORD_BYTES }) + "\n";
      bytes = Buffer.from(record);
    }
    // append-only writes are synchronous and bounded. Parent/child extension
    // factories in one host cannot interleave partial JSON lines on its JS thread.
    let written = 0;
    while (written < bytes.byteLength) {
      const count = writeSync(state.fd, bytes, written, bytes.byteLength - written);
      if (count <= 0) throw new Error("Audit write made no progress");
      written += count;
    }
    state.bytes += bytes.byteLength;
  } catch {
    state.writeFailed = true;
    // Constant-only diagnostic: never leak filesystem errors, stop reason,
    // exception messages, token/config contents, URLs or request inputs.
    process.stderr.write("[omp-agy-cleanup-audit] receipt write failed; acceptance evidence is incomplete\n");
  }
}

export default async function cleanupAuditExtension(pi: ExtensionAPI): Promise<void> {
  const path = process.env[PATH_ENV];
  if (!path || !isAbsolute(path) || /[\0\r\n]/.test(path)) throw new Error("Cleanup audit requires an explicit absolute OMP_AGY_CLEANUP_AUDIT_PATH");
  if (SessionController !== PublicSessionController) throw new Error("Cleanup audit source controller differs from index.ts public export; instrumentation identity is unproven");
  const prototype = SessionController.prototype;
  // Only this extension writes this symbol on the known source prototype.
  const prior = Object.getOwnPropertyDescriptor(prototype, MARKER)?.value as AuditState | undefined;
  if (prior) {
    if (prior.path !== path) throw new Error("Cleanup audit path changed within an instrumented host");
    await productionExtension(pi);
    return;
  }
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "stop");
  if (!descriptor || typeof descriptor.value !== "function") throw new Error("Cleanup audit cannot find the actual source stop method");
  const original: StopMethod = prototype.stop;
  const fd = openSync(path, "a", 0o600);
  const bytes = fstatSync(fd).size;
  if (bytes > MAX_BYTES - 1024) { closeSync(fd); throw new Error("Cleanup audit evidence path is already full"); }
  const state: AuditState = { path, fd, auditId: randomUUID(), sequence: 0, callSequence: 0, bytes, truncated: false, writeFailed: false };
  const wrapped: StopMethod = async function (this: SessionController, reason?: Error): Promise<void> {
    const callId = `${process.pid}:${++state.callSequence}`;
    const before = capture(this);
    const identity = {
      callId, generation: before.generation, acpSessionId: before.acpSessionId,
      beforePhase: before.phase,
      classIdentityMatchesPublicExport: SessionController === PublicSessionController,
      receiverUsesSourceClass: this instanceof SessionController,
      hookIsCurrent: this.stop === wrapped,
    };
    append(state, { kind: "stop_before", ...identity, before });
    try {
      // Exactly one awaited real delegation per intercepted call. No reason,
      // result, promise, hook, bridge capability or cleanup report is rewritten.
      await original.call(this, reason);
    } catch (error) {
      append(state, { kind: "stop_throw", ...identity, before, after: capture(this), delegateOutcome: "threw", thrownType: error instanceof Error ? "Error" : typeof error });
      throw error;
    }
    append(state, { kind: "stop_after", ...identity, before, after: capture(this), delegateOutcome: "fulfilled" });
  };
  Object.defineProperty(prototype, "stop", { ...descriptor, value: wrapped });
  Object.defineProperty(prototype, MARKER, { value: state, configurable: false, enumerable: false, writable: false });
  process.once("exit", () => { try { closeSync(fd); } catch { /* Receipt completeness is checked by the external harness. */ } });
  append(state, {
    kind: "audit_install", classIdentityMatchesPublicExport: SessionController === PublicSessionController,
    delegatesActualProductionFactory: true,
    sourceControllerModule: new URL("../src/controller.ts", import.meta.url).href,
    publicIndexModule: new URL("../index.ts", import.meta.url).href,
    maxBytes: MAX_BYTES, maxRecords: MAX_RECORDS, maxRecordBytes: MAX_RECORD_BYTES,
  });
  // OMP rebinds this wrapper for each real child; always delegate the unchanged
  // original factory once, including when its class hook was installed earlier.
  await productionExtension(pi);
}
