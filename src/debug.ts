import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";

export type DebugMode = "metadata" | "content";
export interface DebugContext {
  ompSessionId?: string;
  activationGeneration?: string | number;
  acpSessionId?: string;
  requestId?: string | number;
  toolCallId?: string;
  mcpSessionId?: string;
}
export interface DebugObserver {
  readonly enabled: boolean;
  event(name: string, payload?: unknown | (() => unknown), context?: DebugContext | (() => DebugContext)): void;
}
export interface DebugStatus {
  state: "disabled" | "enabled" | "failed" | "closed";
  mode: DebugMode;
  runtimeId: string;
  path?: string;
  rows: number;
  bytes: number;
  truncated: boolean;
  error?: string;
  permissions: "posix-owner-only" | "windows-best-effort";
}
export interface DebugLimits {
  maxBytes?: number;
  maxRows?: number;
  maxRecordBytes?: number;
  maxTextBytes?: number;
}

/** Observers cannot alter provider/transport success, including user-supplied observers. */
export function debugEvent(debug: DebugObserver | undefined, name: string, payload?: unknown | (() => unknown), context?: DebugContext | (() => DebugContext)): void {
  try { if (debug?.enabled) debug.event(name, payload, context); } catch { /* Optional observation is never execution policy. */ }
}

const secretKey = /(?:authorization|authentication|cookie|password|passwd|secret|credential|token|api[-_]?key|private[-_]?key)/i;
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function redact(text: string): string {
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[REDACTED]")
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;\"'<>]+/gi, "[REDACTED]")
    .replace(/((?:[\"']?)(?:[\w.-]*(?:token|password|passwd|secret|credential|authorization|api[-_]?key|private[-_]?key)[\w.-]*)(?:[\"']?)\s*(?:[:=]|\s)\s*)(?:\"[^\"]*\"|'[^']*'|[^\s,;}]+)/gi, "$1[REDACTED]")
    .replace(/\b(?:sk-|gh[pousr]_|github_pat_)[a-zA-Z0-9_-]+/g, "[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/data:[^\s;,]+;base64,[a-zA-Z0-9+/=\r\n]+/gi, "[BINARY REDACTED]")
    .replace(/(["'](?:data|blob)["']\s*:\s*)(["'])[a-zA-Z0-9+/=\s]*\2/gi, '$1"[BINARY REDACTED]"')
    .replace(/[a-zA-Z0-9+/]{80,}={0,2}/g, "[BINARY REDACTED]");
}
function clipped(text: string, bytes: number): string {
  const encoded = Buffer.from(text);
  if (encoded.byteLength <= bytes) return text;
  let end = bytes;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--;
  return encoded.subarray(0, end).toString("utf8");
}
const discriminator = /^(?:text|image|audio|resource|resource_link|thinking|toolCall|toolResult|user|assistant|developer|system|select|number|boolean|string|object|array|agent_message_chunk|agent_thought_chunk|user_message_chunk|tool_call|tool_call_update|usage_update|config_option_update|available_commands_update|end_turn|cancelled|error|success|completed|in_progress|pending|failed)$/;
const wireMethod = /^(?:initialize|initialized|ping|tools\/(?:call|list)|notifications\/[a-z_\/]+|session\/[a-zA-Z_\/]+)$/;

/** A factory-local, bounded JSONL observer. Content mode remains sensitive despite redaction. */
export class DebugTrace implements DebugObserver {
  private readonly limits: Required<DebugLimits>;
  private current: DebugStatus = {
    state: "disabled", mode: "metadata", runtimeId: randomUUID(), rows: 0, bytes: 0, truncated: false,
    permissions: process.platform === "win32" ? "windows-best-effort" : "posix-owner-only",
  };
  private handle?: FileHandle;
  private writes: Promise<void> = Promise.resolve();
  private lifecycle: Promise<void> = Promise.resolve();
  constructor(limits: DebugLimits = {}) {
    this.limits = { maxBytes: 8 * 1024 * 1024, maxRows: 20_000, maxRecordBytes: 32 * 1024, maxTextBytes: 2048, ...limits };
    for (const [key, value] of Object.entries(this.limits)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid debug limit: ${key}`);
    if (this.limits.maxRecordBytes < 512 || this.limits.maxBytes < this.limits.maxRecordBytes * 2 || this.limits.maxRows < 2) throw new Error("Debug limits require room for a record and explicit truncation marker");
  }
  get enabled(): boolean { return this.current.state === "enabled" && !this.current.truncated; }
  status(): DebugStatus { return { ...this.current }; }
  enable(directory: string, mode: DebugMode = "metadata"): Promise<void> {
    return this.transition(async () => {
      if (this.current.state !== "failed") this.current.state = "disabled";
      await this.finish();
      this.current = { ...this.current, state: "disabled", mode, path: undefined, rows: 0, bytes: 0, truncated: false, error: undefined };
      try {
        if (mode !== "metadata" && mode !== "content") throw new Error("Unsupported debug mode");
        const root = resolve(directory);
        await mkdir(root, { recursive: true, mode: 0o700 });
        const path = join(root, `omp-agy-${this.current.runtimeId}-${randomUUID()}.jsonl`);
        // Exclusive creation prevents symlink overwrite; every write is append-only.
        this.handle = await open(path, "ax", 0o600);
        this.current.path = path;
        this.current.state = "enabled";
        this.event("debug.enabled", { mode, sensitiveContent: mode === "content", windowsPermissionsBestEffort: process.platform === "win32" });
        // An awaited enable must surface even an asynchronous first-write failure.
        await this.writes;
      } catch (error) { this.fail(error); await this.finish(); }
    });
  }
  disable(): Promise<void> {
    return this.transition(async () => { if (this.current.state !== "failed") this.current.state = "disabled"; await this.finish(); });
  }
  close(): Promise<void> {
    return this.transition(async () => { if (this.current.state !== "failed") this.current.state = "closed"; await this.finish(); });
  }
  private transition(action: () => Promise<void>): Promise<void> {
    this.lifecycle = this.lifecycle.then(action).catch(error => this.fail(error));
    return this.lifecycle;
  }
  private fail(error: unknown): void {
    this.current.state = "failed";
    // Filesystem errors may contain paths, but never include provider payloads.
    this.current.error = clipped(redact(error instanceof Error ? error.message : String(error)), 1024);
  }
  private async finish(): Promise<void> {
    await this.writes;
    const handle = this.handle;
    this.handle = undefined;
    if (handle) try { await handle.close(); } catch (error) { this.fail(error); }
  }
  event(name: string, payload?: unknown | (() => unknown), context?: DebugContext | (() => DebugContext)): void {
    if (!this.enabled) return;
    try {
      const value = typeof payload === "function" ? payload() : payload;
      const binary = new WeakMap<object, Map<string, unknown>>();
      const audit = this.audit(value, binary);
      const identities = this.context(context);
      const record = {
        time: new Date().toISOString(), runtimeId: this.current.runtimeId, event: clipped(redact(name), 128),
        ...identities, payload: this.summarize(value, binary), audit,
      };
      let line = JSON.stringify(record) + "\n";
      if (Buffer.byteLength(line) > this.limits.maxRecordBytes) {
        const retained = { ...audit.media, latest: [...audit.media.latest] };
        const fallback: Record<string, unknown> = { time: record.time, runtimeId: record.runtimeId, event: "debug.record.truncated", eventSha256: sha256(name),
          ...identities, truncated: true, reason: "record_bytes", audit: { payloadHash: audit.payloadHash, media: retained } };
        line = JSON.stringify(fallback) + "\n";
        while (Buffer.byteLength(line) > this.limits.maxRecordBytes && retained.latest.length) {
          retained.latest.shift(); retained.omitted++;
          line = JSON.stringify(fallback) + "\n";
        }
        for (const key of Object.keys(identities)) {
          if (Buffer.byteLength(line) <= this.limits.maxRecordBytes) break;
          delete fallback[key]; fallback.truncatedContext = true;
          line = JSON.stringify(fallback) + "\n";
        }
      }
      // Always reserve one row and one full record for a terminal limit indicator.
      if (this.current.rows >= this.limits.maxRows - 1 || this.current.bytes + Buffer.byteLength(line) > this.limits.maxBytes - this.limits.maxRecordBytes) {
        this.current.truncated = true;
        this.append(JSON.stringify({ time: record.time, runtimeId: record.runtimeId, event: "debug.truncated", truncated: true, reason: "trace_limit" }) + "\n");
        return;
      }
      this.append(line);
    } catch (error) { this.fail(error); void this.finish(); }
  }
  private append(line: string): void {
    const handle = this.handle;
    if (!handle) { this.fail(new Error("Debug file is not open")); return; }
    this.current.rows++;
    this.current.bytes += Buffer.byteLength(line);
    this.writes = this.writes.then(async () => {
      if (this.current.state === "failed") return;
      try { await handle.appendFile(line, "utf8"); }
      catch (error) { this.fail(error); try { await handle.close(); } catch { /* Original write failure remains visible. */ } if (this.handle === handle) this.handle = undefined; }
    });
  }
  private context(contextInput?: DebugContext | (() => DebugContext)): DebugContext {
    const context = typeof contextInput === "function" ? contextInput() : contextInput;
    const result: DebugContext = {};
    for (const key of ["ompSessionId", "activationGeneration", "acpSessionId", "requestId", "toolCallId", "mcpSessionId"] as const) {
      const value = context?.[key];
      if (typeof value === "number" && Number.isFinite(value)) Object.assign(result, { [key]: value });
      else if (typeof value === "string") Object.assign(result, { [key]: clipped(redact(value), 256) });
    }
    return result;
  }
  private audit(value: unknown, binary: WeakMap<object, Map<string, unknown>>) {
    const hash = createHash("sha256");
    const ancestors = new Set<object>();
    const latest: { owner: object; key: string; data: string | Uint8Array; base64: boolean; path: (string | number)[]; type: string; mimeType?: string; toolCallIdSha256?: string }[] = [];
    let total = 0;
    let nodes = 0;
    let complete = true;
    const knownKey = /^(?:messages|content|blocks|prompt|params|result|resource|source|data|blob|image|audio|bytes|update|toolCall|toolResult)$/;
    const walk = (item: unknown, path: (string | number)[], depth: number, toolCallIdSha256?: string, retain = true): void => {
      if (++nodes > 200_000 || depth > 64) { complete = false; hash.update("[structure-limit]"); return; }
      const kind = item === null ? "null" : typeof item;
      hash.update(`${kind}:`);
      if (typeof item === "string") { hash.update(`${Buffer.byteLength(item)}:`); hash.update(item); return; }
      if (item === null || typeof item !== "object") { hash.update(String(item)); return; }
      if (item instanceof Uint8Array || item instanceof ArrayBuffer) {
        const bytes = item instanceof Uint8Array ? item : new Uint8Array(item);
        hash.update(`${bytes.byteLength}:`); hash.update(bytes);
        if (retain) {
          total++;
          latest.push({ owner: item, key: "", data: bytes, base64: false, path, type: "binary", toolCallIdSha256 });
          if (latest.length > 16) latest.shift();
        }
        return;
      }
      if (ancestors.has(item)) { complete = false; hash.update("[cycle]"); return; }
      ancestors.add(item);
      if (Array.isArray(item)) {
        hash.update(`array:${item.length}:`);
        for (let index = 0; index < item.length && nodes <= 200_000; index++) walk(item[index], retain ? [...path, index] : path, depth + 1, toolCallIdSha256, retain);
      } else {
        const object = item as Record<string, unknown>;
        const callId = retain && typeof object.toolCallId === "string" ? sha256(object.toolCallId) : toolCallIdSha256;
        const mime = typeof object.mimeType === "string" ? object.mimeType : typeof object.mime_type === "string" ? object.mime_type : typeof object.media_type === "string" ? object.media_type : undefined;
        const mediaType = typeof object.type === "string" && /^(image|audio|binary)$/.test(object.type) ? object.type : "binary";
        for (const key in object) {
          if (nodes > 200_000) break;
          if (!Object.prototype.hasOwnProperty.call(object, key)) continue;
          hash.update(`key:${Buffer.byteLength(key)}:`); hash.update(key);
          const child = object[key];
          const childPath = retain ? [...path, knownKey.test(key) ? key : `key-sha256:${sha256(key)}`] : path;
          // Tool argument values and credential subtrees are hashed, never retained as media/IDs.
          const privateTree = secretKey.test(key) || /^(?:arguments|args|rawInput|input|inputSchema|parameters)$/.test(key);
          const dataUrl = typeof child === "string" ? /^data:([^;,]+);base64,([\s\S]*)$/i.exec(child) : null;
          if (retain && !privateTree && typeof child === "string" && (dataUrl || (key === "data" && (mediaType !== "binary" || mime || object.type === "binary" || object.type === "base64" || object.encoding === "base64")) || key === "blob")) {
            total++;
            const mediaMime = dataUrl?.[1] ?? mime;
            latest.push({ owner: object, key, data: dataUrl?.[2] ?? child, base64: true, path: childPath, type: mediaType,
              mimeType: mediaMime && /^[\w.+-]+\/[\w.+-]+$/.test(mediaMime) ? mediaMime : undefined, toolCallIdSha256: callId });
            if (latest.length > 16) latest.shift();
          }
          // Keep the hash complete without allowing credential/tool-argument traversal into the retained-media side channel.
          walk(child, childPath, depth + 1, privateTree ? undefined : callId, retain && !privateTree);
        }
      }
      hash.update("end:");
      ancestors.delete(item);
    };
    walk(value, [], 0);
    const media = latest.map(entry => {
      const bytes = entry.base64 ? Buffer.from(entry.data as string, "base64") : entry.data as Uint8Array;
      const summary = { type: entry.type, mimeType: entry.mimeType, bytes: bytes.byteLength, sha256: sha256(bytes) };
      let cached = binary.get(entry.owner);
      if (!cached) { cached = new Map(); binary.set(entry.owner, cached); }
      cached.set(entry.key, summary);
      return { ...summary, path: entry.path, ...(entry.toolCallIdSha256 ? { toolCallIdSha256: entry.toolCallIdSha256 } : {}) };
    });
    return { payloadHash: { sha256: hash.digest("hex"), encoding: "typed-structure-v1", complete }, media: { total, omitted: total - media.length, latest: media } };
  }
  private summarize(value: unknown, binary: WeakMap<object, Map<string, unknown>>): unknown {
    let nodes = 0;
    const seen = new WeakSet<object>();
    const visit = (item: unknown, key = "", depth = 0, shape = false): unknown => {
      if (++nodes > 2048 || depth > 16) return { truncated: true, reason: "structure_limit" };
      if (secretKey.test(key)) return { redacted: true };
      if (item === null) return shape ? "null" : null;
      if (item instanceof Uint8Array || item instanceof ArrayBuffer) {
        const cached = binary.get(item)?.get("");
        if (cached) return cached;
        const bytes = item instanceof Uint8Array ? item : new Uint8Array(item);
        return { type: "binary", bytes: bytes.byteLength, sha256: sha256(bytes) };
      }
      if (typeof item === "string") {
        if (shape) return "string";
        const dataUrl = /^data:([^;,]+);base64,([\s\S]*)$/i.exec(item);
        if (dataUrl) {
          const bytes = Buffer.from(dataUrl[2]!, "base64");
          return { type: "binary", mimeType: /^[\w.+-]+\/[\w.+-]+$/.test(dataUrl[1]!) ? dataUrl[1] : undefined, bytes: bytes.byteLength, sha256: sha256(bytes) };
        }
        const bytes = Buffer.byteLength(item);
        if ((key === "type" || key === "role" || key === "sessionUpdate" || key === "stopReason" || key === "status") && discriminator.test(item)) return item;
        if ((key === "mimeType" || key === "mime_type") && /^[\w.+-]+\/[\w.+-]+$/.test(item)) return item;
        if (key === "method" && wireMethod.test(item)) return item;
        const summary: Record<string, unknown> = { type: "string", bytes, sha256: sha256(item) };
        if (this.current.mode === "content") {
          const safe = redact(item);
          summary.text = clipped(safe, this.limits.maxTextBytes);
          if (Buffer.byteLength(safe) > this.limits.maxTextBytes) summary.truncated = true;
        }
        return summary;
      }
      if (typeof item === "number" || typeof item === "boolean") return shape ? typeof item : item;
      if (typeof item !== "object") return { type: typeof item };
      if (seen.has(item)) return { truncated: true, reason: "cycle" };
      seen.add(item);
      if (Array.isArray(item)) {
        const startIndex = Math.max(0, item.length - 128);
        const values = item.slice(startIndex).map(entry => visit(entry, "", depth + 1, shape));
        return startIndex ? { type: "array", length: item.length, startIndex, values, truncated: true } : values;
      }
      const object = item as Record<string, unknown>;
      const output: Record<string, unknown> = Object.create(null);
      const media = typeof object.type === "string" && /^(image|audio|binary)$/.test(object.type);
      const mime = typeof object.mimeType === "string" ? object.mimeType : typeof object.mime_type === "string" ? object.mime_type : typeof object.media_type === "string" ? object.media_type : undefined;
      const entries = Object.entries(object);
      for (const [childKey, child] of entries.slice(0, 128)) {
        const safeKey = clipped(redact(childKey), 128);
        const cachedChild = !shape && !secretKey.test(childKey) ? binary.get(object)?.get(childKey) : undefined;
        if (cachedChild) { output[safeKey] = cachedChild; continue; }
        if (!shape && typeof child === "string" && ((childKey === "data" && (media || mime || object.type === "base64" || object.encoding === "base64")) || childKey === "blob")) {
          const cached = binary.get(object)?.get(childKey);
          if (cached) output[safeKey] = cached;
          else {
            const bytes = Buffer.from(child, "base64");
            output[safeKey] = { type: typeof object.type === "string" && media ? object.type : "binary", mimeType: mime && /^[\w.+-]+\/[\w.+-]+$/.test(mime) ? mime : undefined, bytes: bytes.byteLength, sha256: sha256(bytes) };
          }
        } else output[safeKey] = visit(child, childKey, depth + 1, shape || /^(?:arguments|args|rawInput|input|inputSchema|parameters)$/.test(childKey));
      }
      if (entries.length > 128) output.$truncated = { reason: "keys_limit", keys: entries.length };
      return output;
    };
    return visit(value);
  }
}
