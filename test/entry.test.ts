import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore, type Model } from "@oh-my-pi/pi-ai";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ProviderConfig, ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../index.ts";
import { ProviderRuntime, SYSTEM_PROMPT_BOUNDARY } from "../src/provider.ts";
import * as configuration from "../src/config.ts";
import * as accountLogin from "../src/account-login.ts";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SessionController } from "../src/controller.ts";
import { routeProviderStream } from "../src/router.ts";

const defaultConfig = configuration.readConfig({});
let config = defaultConfig;
let configMock: Mock<typeof configuration.readConfig>;
beforeEach(() => { config = { ...defaultConfig }; configMock = spyOn(configuration, "readConfig").mockImplementation(() => config); });
afterEach(() => { configMock.mockRestore(); });
const liveModel = (id: string): ProviderModelConfig => ({ id, name: id, reasoning: false, input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 8192 });

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
type Handler = (event: unknown, context: ExtensionContext) => unknown;
function hostFixture(registry?: ModelRegistry) {
  const events = new Map<string, Handler>();
  const commands = new Map<string, Command>();
  const providers: { name: string; config: ProviderConfig }[] = [];
  const notices: { message: string; level: string | undefined }[] = [];
  const selected: Model[] = [];
  const models = new Map<string, Model>();
  const pi = {
    on: (name: string, handler: Handler) => { events.set(name, handler); },
    registerCommand: (name: string, command: Command) => { commands.set(name, command); },
    registerProvider: (name: string, config: ProviderConfig) => {
      providers.push({ name, config });
      if (registry) { registry.registerProvider(name, config, "entry-regression"); return; }
      if (config.models?.length) {
        models.clear();
        for (const model of config.models) models.set(`${name}/${model.id}`, {
          ...model, api: config.api!, provider: name, baseUrl: config.baseUrl!, identity: { class: "unknown" }, compat: undefined,
        });
      }
    },
    unregisterProvider: (name: string) => { if (registry) registry.unregisterProvider(name); else models.clear(); },
    setModel: async (model: Model) => { selected.push(model); return true; },
    getAllTools: () => [],
  } as unknown as ExtensionAPI;
  const context = {
    hasUI: false, agent: { kind: "main" },
    ui: { notify: (message: string, level?: string) => { notices.push({ message, level }); }, setStatus: () => {}, setWidget: () => {} },
    sessionManager: { getSessionId: () => "entry-regression-session", getBranch: () => [], getEntries: () => [] }, abort: () => {},
    modelRegistry: registry ?? { find: (provider: string, id: string) => models.get(`${provider}/${id}`) },
  } as unknown as ExtensionCommandContext;
  return { pi, context, events, commands, providers, notices, selected };
}

describe("extension entry lifecycle", () => {
  test("default factory and non-AGY prepared child register no dynamic callback and never discover", async () => {
    const discover = spyOn(ProviderRuntime.prototype, "discover").mockRejectedValue(new Error("Unexpected WSL discovery"));
    const parent = hostFixture(), child = hostFixture();
    try {
      await extension(parent.pi); await extension(child.pi);
      expect(discover).toHaveBeenCalledTimes(0);
      for (const fixture of [parent, child]) {
        expect(fixture.providers).toHaveLength(1);
        expect(fixture.providers[0]!.config.fetchDynamicModels).toBeUndefined();
      }
    } finally { discover.mockRestore(); }
  });

  test("explicit startup mode discovers before factory resolution for CLI model selectors", async () => {
    config = { ...defaultConfig, discovery: "startup", instructions: "entry startup opt-in fixture" };
    const pending = Promise.withResolvers<ProviderModelConfig[]>();
    const discover = spyOn(ProviderRuntime.prototype, "discover").mockReturnValue(pending.promise);
    const fixture = hostFixture();
    try {
      let loaded = false;
      const loading = extension(fixture.pi).then(() => { loaded = true; });
      await Promise.resolve(); expect(loaded).toBe(false); expect(discover).toHaveBeenCalledTimes(1);
      pending.resolve([liveModel("entry-startup-live")]); await loading;
      expect(fixture.providers.at(-1)!.config.models!.some(model => model.id === "entry-startup-live")).toBe(true);
      const child = hostFixture(); await extension(child.pi);
      expect(discover).toHaveBeenCalledTimes(1);
      expect(child.providers.at(-1)!.config.models!.some(model => model.id === "entry-startup-live")).toBe(true);
    } finally { pending.resolve([]); discover.mockRestore(); }
  });

  test("/agy selects only an exact model from its newly cleaned live discovery", async () => {
    const row = liveModel("entry-explicit-live");
    const discover = spyOn(ProviderRuntime.prototype, "discover").mockResolvedValue([row]);
    const fixture = hostFixture();
    try {
      await extension(fixture.pi);
      await fixture.commands.get("agy")!.handler("", fixture.context);
      expect(discover).toHaveBeenCalledTimes(0); expect(fixture.selected).toHaveLength(0);
      await fixture.commands.get("agy")!.handler("entry-explicit", fixture.context);
      expect(fixture.selected).toHaveLength(0); expect(fixture.notices.at(-1)?.level).toBe("error");
      await fixture.commands.get("agy")!.handler(row.id, fixture.context);
      expect(discover).toHaveBeenCalledTimes(2);
      expect(fixture.selected.map(model => model.id)).toEqual([row.id]);
      expect(fixture.notices.at(-1)?.message).toContain("Submit a new explicit input");
    } finally { discover.mockRestore(); }
  });

  test("prepared factories republish immutable proven rows without another WSL session", async () => {
    const row = liveModel("entry-shared-live");
    const discover = spyOn(ProviderRuntime.prototype, "discover").mockResolvedValue([row]);
    const parent = hostFixture(), child = hostFixture();
    try {
      await extension(parent.pi); await parent.commands.get("agy-discover")!.handler("", parent.context);
      row.name = "untrusted later mutation"; row.input.length = 0;
      await extension(child.pi);
      expect(discover).toHaveBeenCalledTimes(1);
      const inherited = child.providers.at(-1)!.config.models!.find(model => model.id === row.id)!;
      expect(inherited.name).not.toContain("untrusted"); expect(inherited.input).toEqual(["text", "image"]);
      expect(child.providers.at(-1)!.config.fetchDynamicModels).toBeUndefined();
    } finally { discover.mockRestore(); }
  });

  test("shared model catalogs intersect effort ladders without leaking another configuration's default", async () => {
    config = { ...defaultConfig, instructions: "thinking catalog A" };
    const row: ProviderModelConfig = { ...liveModel("entry-thinking-shared"), reasoning: true,
      thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh], defaultLevel: Effort.XHigh } };
    const discover = spyOn(ProviderRuntime.prototype, "discover").mockResolvedValue([row]);
    const first = hostFixture(), second = hostFixture();
    try {
      await extension(first.pi); await first.commands.get("agy-discover")!.handler("", first.context);
      // A consumer may mutate its publication; the remembered source must remain immutable.
      const published = first.providers.at(-1)!.config.models!.find(model => model.id === row.id)!;
      (published.thinking!.efforts as string[]).push("max");
      const child = hostFixture(); await extension(child.pi);
      expect(child.providers.at(-1)!.config.models!.find(model => model.id === row.id)!.thinking!.efforts).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.XHigh]);
      config = { ...defaultConfig, instructions: "thinking catalog B" };
      discover.mockResolvedValue([{ ...row, thinking: { mode: "effort", efforts: [Effort.Low, Effort.High], defaultLevel: Effort.Low } }]);
      await extension(second.pi); await second.commands.get("agy-discover")!.handler("", second.context);
      const merged = second.providers.at(-1)!.config.models!.find(model => model.id === row.id)!;
      expect(merged.reasoning).toBe(true);
      expect(merged.thinking!.efforts).toEqual([Effort.Low, Effort.High]);
      expect(merged.thinking!.defaultLevel).toBeUndefined();
      config = { ...defaultConfig, instructions: "thinking catalog fixed" };
      discover.mockResolvedValue([liveModel(row.id)]);
      const fixed = hostFixture(); await extension(fixed.pi);
      await fixed.commands.get("agy-discover")!.handler("", fixed.context);
      const noDial = fixed.providers.at(-1)!.config.models!.find(model => model.id === row.id)!;
      expect(noDial.reasoning).toBe(false); expect(noDial.thinking).toBeUndefined();
    } finally { discover.mockRestore(); }
  });

  test("different target factories preserve proven IDs but do not treat them as their own live catalog", async () => {
    const row = liveModel("entry-account-specific");
    const discover = spyOn(ProviderRuntime.prototype, "discover").mockResolvedValue([row]);
    const parent = hostFixture(), child = hostFixture();
    try {
      await extension(parent.pi); await parent.commands.get("agy-discover")!.handler("", parent.context);
      config = { ...defaultConfig, runner: { accountDirectory: "/home/agy/other-explicit-account" } };
      await extension(child.pi);
      expect(discover).toHaveBeenCalledTimes(1);
      expect(child.providers.at(-1)!.config.models!.find(model => model.id === row.id)!.name).toContain("configuration-specific");
      discover.mockResolvedValue([liveModel("entry-other-account-only")]);
      await child.commands.get("agy")!.handler(row.id, child.context);
      expect(child.selected).toHaveLength(0); expect(child.notices.at(-1)?.message).toContain("not advertised");
    } finally { discover.mockRestore(); }
  });

  test("discovery failure cannot select a remembered model or register fabricated replacements", async () => {
    const discover = spyOn(ProviderRuntime.prototype, "discover").mockRejectedValue(new Error("cleanup_failed: unconfirmed discovery cleanup"));
    const fixture = hostFixture();
    try {
      await extension(fixture.pi); const registrations = fixture.providers.length;
      await fixture.commands.get("agy")!.handler("entry-never-advertised", fixture.context);
      expect(fixture.selected).toHaveLength(0); expect(fixture.providers).toHaveLength(registrations);
      expect(fixture.notices.at(-1)).toEqual({ message: "cleanup_failed: unconfirmed discovery cleanup", level: "error" });
    } finally { discover.mockRestore(); }
  });

  test("session_start for a non-AGY host does not display the D04 provider warning", async () => {
    const discover = spyOn(ProviderRuntime.prototype, "discover").mockResolvedValue([]);
    const fixture = hostFixture();
    try {
      await extension(fixture.pi);
      await fixture.events.get("session_start")!({}, fixture.context);
      expect(fixture.notices.filter(notice => notice.message === SYSTEM_PROMPT_BOUNDARY)).toEqual([]);
    } finally {
      await fixture.events.get("session_shutdown")?.({}, fixture.context);
      discover.mockRestore();
    }
  });

  test("cancelled login removes old overlays from OMP and reattaches only the canonical session display", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omp-agy-login-host-"));
    const auth = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), { usageProviderResolver: () => undefined });
    const registry = new ModelRegistry(auth, join(directory, "models.yml"), {
      ignoreLocalModelConfig: true, cacheDbPath: join(directory, "models.db"),
    });
    const fixture = hostFixture(registry), sibling = hostFixture(registry);
    const provider = "omp-agy", old = liveModel("entry-login-previous-account"), next = liveModel("entry-login-new-account");
    const discover = spyOn(ProviderRuntime.prototype, "discover").mockResolvedValue([old]);
    const validate = spyOn(accountLogin, "validateAccountLogin").mockImplementation(() => {});
    const during = Promise.withResolvers<{ exists: boolean; hasUsage: boolean }>();
    const terminal = Promise.withResolvers<{ exitCode: number }>();
    const open = spyOn(accountLogin, "openAccountLogin").mockImplementation(async () => {
      during.resolve({ exists: !!registry.find(provider, old.id), hasUsage: !!auth.usage.providerFor(provider) });
      return terminal.promise;
    });
    let attachments = 0, detachments = 0, commandAttachments = 0;
    const timer = {} as Timer;
    const canonical = Object.assign(Object.create(fixture.context) as ExtensionContext, {
      hasUI: true, setInterval: () => { attachments++; return timer; }, clearTimer: () => { detachments++; },
    });
    const command = { ...fixture.context, hasUI: true, isIdle: () => true, hasPendingMessages: () => false,
      setInterval: () => { commandAttachments++; return timer; }, clearTimer: () => {},
      ui: { ...fixture.context.ui, confirm: async () => true } } as ExtensionCommandContext;
    try {
      await extension(fixture.pi);
      await fixture.events.get("session_start")!({}, canonical);
      await fixture.commands.get("agy-discover")!.handler("", command);
      expect(registry.find(provider, old.id)).toBeDefined();
      expect(attachments).toBe(1);

      // A discovery in another factory that crossed the switch cannot bring back old rows.
      await extension(sibling.pi);
      const oldDiscovery = Promise.withResolvers<ProviderModelConfig[]>();
      discover.mockImplementationOnce(() => oldDiscovery.promise);
      const pendingDiscovery = sibling.commands.get("agy-discover")!.handler("", sibling.context);
      const login = fixture.commands.get("agy-login")!.handler("", command);
      const handoff = await Promise.race([during.promise, login.then(() => "login returned without opening the terminal")]);
      terminal.resolve({ exitCode: 1 });
      await login;
      oldDiscovery.resolve([old]); await pendingDiscovery;
      expect(handoff).toEqual({ exists: false, hasUsage: false });

      expect(registry.find(provider, old.id)).toBeUndefined();
      expect(auth.usage.providerFor(provider)).toBe(fixture.providers.at(-1)!.config.usage!);
      expect(fixture.providers.at(-1)!.config.streamSimple).toBe(routeProviderStream);
      expect(fixture.notices.at(-1)?.message).toContain("login was not verified");
      expect(attachments).toBe(2);
      expect(detachments).toBe(1);
      expect(commandAttachments).toBe(0);

      discover.mockResolvedValue([next]);
      await fixture.commands.get("agy-discover")!.handler("", command);
      expect(registry.find(provider, next.id)).toBeDefined();
      expect(registry.find(provider, old.id)).toBeUndefined();
    } finally {
      terminal.resolve({ exitCode: 1 });
      await fixture.events.get("session_shutdown")?.({}, canonical);
      open.mockRestore(); validate.mockRestore(); discover.mockRestore();
      registry.unregisterProvider(provider); auth.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a failed content-trace startup reports failure without claiming tracing is enabled", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omp-agy-debug-entry-"));
    const notDirectory = join(directory, "file");
    writeFileSync(notDirectory, "a regular file");
    config = { ...defaultConfig, debug: { directory: notDirectory, mode: "content" } };
    const fixture = hostFixture();
    try {
      await extension(fixture.pi);
      await fixture.events.get("session_start")!({}, fixture.context);
      expect(fixture.notices).toEqual([{ message: expect.stringMatching(/^AGY debug tracing failed: .+/), level: "warning" }]);
      await fixture.commands.get("agy-debug")!.handler("status", fixture.context);
      expect(JSON.parse(fixture.notices.at(-1)!.message)).toMatchObject({ state: "failed", mode: "content" });
    } finally {
      await fixture.events.get("session_shutdown")?.({}, fixture.context);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("reset reports verified recovery without implicitly discovering models or replaying a task", async () => {
    const discover = spyOn(ProviderRuntime.prototype, "discover").mockResolvedValue([]);
    const reset = spyOn(ProviderRuntime.prototype, "reset").mockResolvedValue({ recovered: ["activation.verified"] });
    const fixture = hostFixture();
    try {
      await extension(fixture.pi);
      const discoveryCalls = discover.mock.calls.length;
      await fixture.commands.get("agy-reset")!.handler("", fixture.context);
      expect(reset).toHaveBeenCalledTimes(1);
      expect(discover.mock.calls.length).toBe(discoveryCalls);
      expect(fixture.notices.at(-1)?.level).toBe("info");
      expect(fixture.notices.at(-1)?.message).toContain("activation.verified");
      expect(fixture.notices.at(-1)?.message).toContain("not replayed");
    } finally {
      await fixture.events.get("session_shutdown")?.({}, fixture.context);
      reset.mockRestore(); discover.mockRestore();
    }
  });

  test("failed reset surfaces the Runner refusal and never announces successful cleanup", async () => {
    const discover = spyOn(ProviderRuntime.prototype, "discover").mockResolvedValue([]);
    const reset = spyOn(ProviderRuntime.prototype, "reset").mockRejectedValue(new Error("cleanup_failed: activation.live still has a verified owner"));
    const fixture = hostFixture();
    try {
      await extension(fixture.pi);
      await fixture.commands.get("agy-reset")!.handler("", fixture.context);
      expect(fixture.notices.at(-1)).toEqual({ message: "cleanup_failed: activation.live still has a verified owner", level: "error" });
    } finally {
      await fixture.events.get("session_shutdown")?.({}, fixture.context);
      reset.mockRestore(); discover.mockRestore();
    }
  });
  test("tree navigation admits a healthy branch without importing an abandoned quarantine", async () => {
    const manager = SessionManager.inMemory(process.cwd());
    const input = { role: "user" as const, content: "fresh branch task", timestamp: 1 };
    const root = manager.appendMessage(input);
    const damaged = manager.appendCustomEntry("omp-agy-steering-uncertain", { version: -1 });
    manager.branch(root);
    const healthy = manager.appendMessage({ ...input, timestamp: 2 });
    const fixture = hostFixture();
    const context = { ...fixture.context, sessionManager: manager };
    const model = { ...liveModel("branch-admission"), api: "omp-agy-acp", provider: "omp-agy", baseUrl: "acp://fixture", identity: { class: "unknown" }, compat: undefined } as Model;
    const open = spyOn(SessionController, "open").mockRejectedValue(new Error("External ACP admission reached"));
    const invoke = () => routeProviderStream(model, { messages: [input] }, { sessionId: manager.getSessionId() }).result();
    try {
      await extension(fixture.pi);
      await fixture.events.get("session_start")!({}, context);
      expect(manager.getEntries().some(entry => entry.id === damaged)).toBe(true);
      expect((await invoke()).errorMessage).toBe("External ACP admission reached");
      manager.branch(damaged);
      await fixture.events.get("session_tree")!({}, context);
      expect((await invoke()).errorMessage).toContain("quarantine is invalid");
      expect(open).toHaveBeenCalledTimes(1);
      manager.branch(healthy);
      await fixture.events.get("session_tree")!({}, context);
      expect((await invoke()).errorMessage).toBe("External ACP admission reached");
      manager.branch(damaged);
      await fixture.events.get("session_tree")!({}, context);
      expect((await invoke()).errorMessage).toContain("quarantine is invalid");
      expect(open).toHaveBeenCalledTimes(2);
    } finally {
      await fixture.events.get("session_shutdown")?.({}, context);
      open.mockRestore();
    }
  });
  test("cold startup ignores invalid abandoned markers but fences valid UNKNOWN restored queue entries", async () => {
    const manager = SessionManager.inMemory(process.cwd());
    const fresh = { role: "user" as const, content: "new healthy branch input", timestamp: 10 };
    const unknown = { role: "user" as const, content: "original sent-unknown steering", timestamp: 11 };
    const root = manager.appendMessage(fresh);
    manager.appendCustomEntry("omp-agy-steering-uncertain", {
      version: 1, sessionId: manager.getSessionId(), messages: [unknown], reason: "unconfirmed receipt", recordedAt: 12,
    });
    manager.appendCustomEntry("omp-agy-steering-uncertain", { version: -1 });
    manager.branch(root);
    const model = { ...liveModel("cold-branch-admission"), api: "omp-agy-acp", provider: "omp-agy", baseUrl: "acp://fixture", identity: { class: "unknown" }, compat: undefined } as Model;
    const open = spyOn(SessionController, "open").mockRejectedValue(new Error("External ACP admission reached"));
    try {
      for (let reopen = 0; reopen < 2; reopen++) {
        const fixture = hostFixture();
        const context = { ...fixture.context, sessionManager: manager };
        try {
          await extension(fixture.pi);
          await fixture.events.get("session_start")!({}, context);
          const admitted = await routeProviderStream(model, { messages: [fresh] }, { sessionId: manager.getSessionId() }).result();
          expect(admitted.errorMessage).toBe("External ACP admission reached");
          const replay = await routeProviderStream(model, { messages: [fresh, unknown] }, { sessionId: manager.getSessionId() }).result();
          expect(replay.errorMessage).toContain("quarantined");
          expect(open).toHaveBeenCalledTimes(reopen + 1);
        } finally { await fixture.events.get("session_shutdown")?.({}, context); }
      }
    } finally { open.mockRestore(); }
  });
});
