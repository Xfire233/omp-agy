import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createBridge } from "../src/bridge.ts";
import { DebugTrace, debugEvent, type DebugObserver } from "../src/debug.ts";

const directories: string[] = [];
const traces: DebugTrace[] = [];
afterEach(async () => {
  await Promise.all(traces.splice(0).map(trace => trace.close()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
async function fixture(options: ConstructorParameters<typeof DebugTrace>[0] = {}, mode: "metadata" | "content" = "metadata") {
  const directory = await mkdtemp(join(tmpdir(), "omp-agy-debug-"));
  directories.push(directory);
  const trace = new DebugTrace(options);
  traces.push(trace);
  await trace.enable(directory, mode);
  return { trace, directory };
}
async function records(trace: DebugTrace) {
  await trace.disable();
  const text = await readFile(trace.status().path!, "utf8");
  return { text, rows: text.trim().split("\n").map(line => JSON.parse(line)) };
}

describe("private opt-in boundary tracing", () => {
  test("disabled and failed observers never evaluate payloads or interfere with work", async () => {
    const trace = new DebugTrace();
    let evaluated = 0;
    const payload = () => { evaluated++; throw new Error("Must not be evaluated"); };
    const context = () => { evaluated++; throw new Error("Must not be evaluated"); };
    trace.event("disabled", payload, context);
    debugEvent(trace, "disabled", payload, context);
    expect(evaluated).toBe(0);
    expect(trace.status().state).toBe("disabled");
    const throwing: DebugObserver = { enabled: true, event() { throw new Error("Observer failed"); } };
    expect(() => debugEvent(throwing, "boundary", { legitimate: true })).not.toThrow();
    const brokenEnabled: DebugObserver = { get enabled(): boolean { throw new Error("Broken observer status"); }, event() {} };
    expect(() => debugEvent(brokenEnabled, "boundary", payload)).not.toThrow();
    await trace.close();
    expect(trace.status().state).toBe("closed");
  });

  test("metadata preserves correlation and exact text hashes, never private conversation or argument values", async () => {
    const { trace } = await fixture();
    const privateText = "Private conversation not intended for logs";
    trace.event("omp.provider.input", {
      messages: [{ role: "user", content: [{ type: "text", text: privateText }] }],
      arguments: { path: "/private/project", count: 17, nested: { action: "secret-action", enabled: true } },
      headers: { Authorization: "Bearer private-bearer", "X-Api-Key": "nested-api-secret" },
      nested: { mcpToken: "nested-mcp-secret", credentials: { password: "nested-password" } },
    }, { ompSessionId: "omp-session-1", activationGeneration: "actual-generation", acpSessionId: "acp-session-1", requestId: 24 });
    const { text, rows } = await records(trace);
    const row = rows.find(row => row.event === "omp.provider.input");
    expect(row).toMatchObject({ ompSessionId: "omp-session-1", activationGeneration: "actual-generation", acpSessionId: "acp-session-1", requestId: 24 });
    expect(row).not.toHaveProperty("toolCallId");
    expect(row.payload.messages[0].content[0].text).toEqual({ type: "string", bytes: Buffer.byteLength(privateText), sha256: createHash("sha256").update(privateText).digest("hex") });
    expect(row.payload.arguments).toEqual({ path: "string", count: "number", nested: { action: "string", enabled: "boolean" } });
    expect(row.payload.headers.Authorization).toEqual({ redacted: true });
    expect(row.payload.nested.credentials).toEqual({ redacted: true });
    for (const secret of [privateText, "/private/project", "secret-action", "private-bearer", "nested-api-secret", "nested-mcp-secret", "nested-password"]) expect(text).not.toContain(secret);
  });

  test("explicit content mode redacts nested secrets, HTTP headers, and secrets embedded in tool text", async () => {
    const { trace } = await fixture({ maxTextBytes: 512 }, "content");
    trace.event("mcp.out", { result: { content: [{ type: "text", text: [
      "A harmless result. Authorization: Bearer credential-aaa",
      'mcp_token="credential-bbb" password: credential-ccc',
      '{"nested":{"apiKey":"credential-ddd","access_token":"credential-eee"}}',
      "curl --token credential-fff --header 'X-Api-Key: credential-ggg'",
      "https://username:credential-hhh@example.test/",
      '{"type":"image","mimeType":"image/png","data":"aW1hZ2U="}',
    ].join("\n") }], details: { headers: { authorization: "credential-iii" }, password: "credential-jjj" } } });
    const { text, rows } = await records(trace);
    expect(text).toContain("A harmless result.");
    expect(text).toContain("REDACTED");
    expect(text).not.toContain("aW1hZ2U=");
    for (const suffix of ["aaa", "bbb", "ccc", "ddd", "eee", "fff", "ggg", "hhh", "iii", "jjj"]) expect(text).not.toContain(`credential-${suffix}`);
    expect(rows.find(row => row.event === "debug.enabled").payload.sensitiveContent).toBe(true);
  });

  test("images, audio and byte arrays retain only type/MIME, decoded byte count, and SHA256 in both modes", async () => {
    const bytes = Buffer.from("private binary image bytes");
    const base64 = bytes.toString("base64");
    const hash = createHash("sha256").update(bytes).digest("hex");
    for (const mode of ["metadata", "content"] as const) {
      const { trace } = await fixture({}, mode);
      trace.event("image.boundary", { blocks: [
        { type: "image", mimeType: "image/png", data: base64 },
        { type: "audio", mimeType: "audio/wav", data: base64 },
        { type: "resource", resource: { mimeType: "application/octet-stream", blob: base64 } },
        { type: "image", source: { type: "base64", media_type: "image/png", data: base64 } },
        { url: `data:image/png;base64,${base64}` },
      ], bytes });
      const { text, rows } = await records(trace);
      const payload = rows.find(row => row.event === "image.boundary").payload;
      expect(payload.blocks[0].data).toEqual({ type: "image", mimeType: "image/png", bytes: bytes.length, sha256: hash });
      expect(payload.blocks[1].data).toEqual({ type: "audio", mimeType: "audio/wav", bytes: bytes.length, sha256: hash });
      expect(payload.blocks[2].resource.blob).toEqual({ type: "binary", mimeType: "application/octet-stream", bytes: bytes.length, sha256: hash });
      expect(payload.blocks[3].source.data).toEqual({ type: "binary", mimeType: "image/png", bytes: bytes.length, sha256: hash });
      expect(payload.blocks[4].url).toEqual({ type: "binary", mimeType: "image/png", bytes: bytes.length, sha256: hash });
      expect(payload.bytes).toEqual({ type: "binary", bytes: bytes.length, sha256: hash });
      expect(text).not.toContain(base64);
      expect(text).not.toContain(bytes.toString());
    }
  });

  test("long OMP history retains latest image hashes and actual tool identities beyond summary and record limits", async () => {
    const { trace } = await fixture({ maxRecordBytes: 4096 });
    const privateText = "private conversation not for trace content";
    const images = Array.from({ length: 7 }, (_, index) => Buffer.from(`private-image-${index}`));
    const messages = Array.from({ length: 446 }, (_, index) => ({ role: "toolResult", toolCallId: `actual-tool-${index}`,
      content: index >= 439 ? [{ type: "image", mimeType: "image/png", data: images[index - 439]!.toString("base64") }]
        : [{ type: "text", text: privateText.repeat(20) }] }));
    trace.event("omp.provider.input", { messages }, { ompSessionId: "actual-omp-session", acpSessionId: "actual-acp-session" });
    const { text, rows } = await records(trace);
    const eventHash = createHash("sha256").update("omp.provider.input").digest("hex");
    const row = rows.find(row => row.eventSha256 === eventHash);
    expect(row).toMatchObject({ event: "debug.record.truncated", ompSessionId: "actual-omp-session", acpSessionId: "actual-acp-session" });
    expect(row.audit.payloadHash).toMatchObject({ encoding: "typed-structure-v1", complete: true });
    expect(row.audit.payloadHash.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(row.audit.media).toMatchObject({ total: 7, omitted: 0 });
    expect(row.audit.media.latest).toHaveLength(7);
    for (let index = 0; index < images.length; index++) {
      expect(row.audit.media.latest[index]).toMatchObject({ type: "image", mimeType: "image/png", bytes: images[index]!.length,
        sha256: createHash("sha256").update(images[index]!).digest("hex"), path: ["messages", 439 + index, "content", 0, "data"],
        toolCallIdSha256: createHash("sha256").update(`actual-tool-${439 + index}`).digest("hex") });
      expect(text).not.toContain(images[index]!.toString("base64"));
    }
    expect(text).not.toContain(privateText);
    expect(text).not.toContain("actual-tool-445");
    for (const line of text.trim().split("\n")) expect(Buffer.byteLength(line + "\n")).toBeLessThanOrEqual(4096);
    const capped = await fixture();
    capped.trace.event("media-cap", { messages: Array.from({ length: 20 }, (_, index) => ({ toolCallId: `call-${index}`, content: [{ type: "image", mimeType: "image/png", data: images[0]!.toString("base64") }] })),
      arguments: { image: { type: "image", mimeType: "image/png", data: images[0]!.toString("base64") } },
      credentials: { image: { type: "image", data: images[0]!.toString("base64") } } });
    const cappedRecords = await records(capped.trace);
    const audit = cappedRecords.rows.find(row => row.event === "media-cap").audit;
    expect(audit.media).toMatchObject({ total: 20, omitted: 4 });
    expect(audit.media.latest).toHaveLength(16);
    expect(audit.media.latest[0].path).toEqual(["messages", 4, "content", 0, "data"]);
  });

  test("row, byte, record and text bounds always leave an explicit truncation indicator", async () => {
    const { trace } = await fixture({ maxRows: 4, maxBytes: 4096, maxRecordBytes: 512, maxTextBytes: 16 }, "content");
    trace.event("long", { text: "long private text ".repeat(1000), columns: Array.from({ length: 100 }, () => ({ text: "some text" })) });
    for (let index = 0; index < 20; index++) trace.event("bounded", { index });
    const { text, rows } = await records(trace);
    expect(rows.length).toBeLessThanOrEqual(4);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096);
    for (const line of text.trim().split("\n")) expect(Buffer.byteLength(line + "\n")).toBeLessThanOrEqual(512);
    expect(rows.some(row => row.truncated === true && row.reason === "record_bytes")).toBe(true);
    expect(rows.at(-1)).toMatchObject({ event: "debug.truncated", truncated: true, reason: "trace_limit" });
    expect(trace.status().truncated).toBe(true);
    expect(trace.enabled).toBe(false);
    const boundedText = await fixture({ maxTextBytes: 8 }, "content");
    boundedText.trace.event("text", { text: "x".repeat(32) });
    const content = await records(boundedText.trace);
    expect(content.rows.find(row => row.event === "text").payload.text).toMatchObject({ text: "xxxxxxxx", truncated: true, bytes: 32 });
    const byteBound = await fixture({ maxBytes: 1536, maxRecordBytes: 512, maxRows: 100 });
    for (let index = 0; index < 20; index++) byteBound.trace.event("bytes", { index });
    const byteRecords = await records(byteBound.trace);
    expect(Buffer.byteLength(byteRecords.text)).toBeLessThanOrEqual(1536);
    expect(byteRecords.rows.at(-1).event).toBe("debug.truncated");
    const escaped = await fixture({ maxBytes: 4096, maxRecordBytes: 512, maxTextBytes: 5 }, "content");
    escaped.trace.event("unicode", { text: "\u6f22\u6f22" });
    escaped.trace.event('"'.repeat(128), { text: '"'.repeat(1024) });
    const escapedRecords = await records(escaped.trace);
    const unicode = escapedRecords.rows.find(row => row.event === "unicode").payload.text;
    expect(Buffer.byteLength(unicode.text)).toBeLessThanOrEqual(5);
    expect(unicode.text).toBe("\u6f22");
    for (const line of escapedRecords.text.trim().split("\n")) expect(Buffer.byteLength(line + "\n")).toBeLessThanOrEqual(512);
  });

  test("each enable uses a new private append file, disable flushes, and error status is honest", async () => {
    const { trace, directory } = await fixture();
    const first = trace.status().path!;
    trace.event("first", { ok: true });
    await trace.disable();
    if (process.platform !== "win32") expect((await stat(first)).mode & 0o777).toBe(0o600);
    else expect(trace.status().permissions).toBe("windows-best-effort");
    await trace.enable(directory);
    expect(trace.status().path).not.toBe(first);
    trace.event("second", { ok: true });
    await trace.disable();
    expect(await readFile(first, "utf8")).toContain('"event":"first"');
    expect(await readFile(first, "utf8")).not.toContain('"event":"second"');
    const nonDirectory = join(directory, "not-a-directory");
    await writeFile(nonDirectory, "owned test file");
    await trace.enable(nonDirectory);
    expect(trace.status()).toMatchObject({ state: "failed" });
    expect(trace.status().error).toBeTruthy();
    expect(trace.enabled).toBe(false);
    await trace.enable(directory);
    trace.event("throws", () => { throw new Error("Observation failure"); });
    await trace.close();
    expect(trace.status()).toMatchObject({ state: "failed", error: "Observation failure" });
  });

  test("asynchronous log write failure is isolated and closes its handle", async () => {
    const { trace, directory } = await fixture();
    // Patch the real fs FileHandle seam, not trace internals; event payload execution still succeeds.
    await trace.disable();
    const probe = await open(join(directory, "probe"), "ax", 0o600);
    const prototype = Object.getPrototypeOf(probe);
    await probe.close();
    const append = spyOn(prototype, "appendFile").mockRejectedValue(new Error("controlled disk write failure"));
    try {
      await trace.enable(directory);
      expect(trace.status()).toMatchObject({ state: "failed", error: "controlled disk write failure" });
      trace.event("legitimate-work", { delivered: true });
      await trace.close();
      expect(trace.status()).toMatchObject({ state: "failed", error: "controlled disk write failure" });
      expect(trace.enabled).toBe(false);
    } finally { append.mockRestore(); }
  });

  test("real MCP call/result delivery is observed without changing payloads or fabricating ACP IDs", async () => {
    const { trace } = await fixture();
    const activity = new Set<() => void>();
    const failures: Error[] = [];
    const bridge = await createBridge({
      hostname: "127.0.0.1", sourceAddress: "127.0.0.1",
      tools: [{ name: "read", description: "Read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
      debug: trace, debugContext: () => ({ ompSessionId: "actual-omp-session", activationGeneration: "actual-runner-generation" }),
      onActivity() { for (const wake of activity) wake(); }, onFatal(error) { failures.push(error); },
    });
    const client = new Client({ name: "debug-regression", version: "1.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url), { requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } } }));
      await client.listTools();
      bridge.beginTurn();
      const pending = Promise.withResolvers<void>();
      const wake = () => { if (bridge.pendingCount) pending.resolve(); };
      activity.add(wake);
      const result = client.callTool({ name: bridge.aliases[0]!, arguments: { path: "/private/fixture" } });
      wake();
      await Promise.race([pending.promise, result.then(() => { throw new Error("MCP completed before host dispatch"); })]);
      activity.delete(wake);
      const call = bridge.takeNext()!;
      expect(call.arguments).toEqual({ path: "/private/fixture" });
      const expected = { content: [{ type: "text" as const, text: "exact tool result" }], isError: false };
      await bridge.complete(call.id, { source: "mcp", result: expected, isError: false });
      expect(await result).toEqual(expected);
      expect(failures).toEqual([]);
      const { text, rows } = await records(trace);
      const queued = rows.find(row => row.event === "mcp.call.queued");
      const delivered = rows.find(row => row.event === "mcp.result.delivered");
      expect(queued).toMatchObject({ ompSessionId: "actual-omp-session", activationGeneration: "actual-runner-generation", toolCallId: call.id });
      expect(delivered.requestId).toBe(queued.requestId);
      expect(delivered.mcpSessionId).toBe(queued.mcpSessionId);
      expect(delivered).not.toHaveProperty("acpSessionId");
      expect(rows.some(row => row.event === "mcp.in")).toBe(true);
      expect(rows.some(row => row.event === "mcp.out")).toBe(true);
      expect(text).not.toContain(bridge.token);
      expect(text).not.toContain("/private/fixture");
    } finally { await bridge.revoke(new Error("Debug test cleanup")); await client.close(); }
  });
});
