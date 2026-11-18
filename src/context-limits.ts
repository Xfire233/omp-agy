/** Version-pinned local ceilings, not live ACP capacity metadata or a universal AGY-native capacity claim. */
export interface ContextLimit {
  readonly contextWindow: number;
  readonly source: {
    readonly kind: "agy-observed-window" | "official-public-model-spec";
    readonly model: string;
    readonly observedOn: string;
    readonly references: readonly string[];
  };
}
export const CONTEXT_LIMITS_BY_CLI_VERSION: Readonly<Record<string, Readonly<Record<string, ContextLimit>>>> = Object.freeze({
  "1.5.10": Object.freeze({
    "gemini-4-argon": Object.freeze({ contextWindow: 1048576, source: {
      kind: "agy-observed-window" as const, model: "gemini-4-argon", observedOn: "2026-11-18",
      references: [
        ".acceptance/native-context/table-verification/serialized-transitions/gemini-4-argon/result.json",
        ".acceptance/native-context/table-verification/serialized-transitions/gemini-4-argon/raw-events.jsonl:3-27",
      ],
    } }),
    "gemini-4-hydrogen": Object.freeze({ contextWindow: 1048576, source: {
      kind: "agy-observed-window" as const, model: "gemini-4-hydrogen", observedOn: "2026-11-18",
      references: [
        ".acceptance/hydrogen-extra-review/tuple-compatible/observer.jsonl:5-7",
        ".acceptance/hydrogen-extra-review/tuple-compatible/result.json:2-18",
        ".acceptance/hydrogen-extra-review/tuple-compatible/report.json:1404-1476",
        ".acceptance/native-context/table-verification/serialized-transitions/gemini-4-hydrogen/result.json",
        ".acceptance/native-context/table-verification/serialized-transitions/gemini-4-hydrogen/raw-events.jsonl",
      ],
    } }),
    "gemini-pro-orchestrator-g1-pro": Object.freeze({ contextWindow: 1048576, source: {
      kind: "agy-observed-window" as const, model: "gemini-pro-orchestrator-g1-pro", observedOn: "2026-11-18",
      references: [
        ".acceptance/native-context/table-verification/serialized-transitions/gemini-pro-orchestrator-g1-pro/result.json",
        ".acceptance/native-context/table-verification/serialized-transitions/gemini-pro-orchestrator-g1-pro/raw-events.jsonl",
      ],
    } }),
    "gemini-3.8-flash": Object.freeze({ contextWindow: 1048576, source: {
      kind: "agy-observed-window" as const, model: "gemini-3.8-flash", observedOn: "2026-11-18",
      references: [
        ".acceptance/native-context/table-verification/serialized-transitions/gemini-3.8-flash/result.json",
        ".acceptance/native-context/table-verification/serialized-transitions/gemini-3.8-flash/raw-events.jsonl",
      ],
    } }),
    "claude-opus-5-5": Object.freeze({ contextWindow: 1000000, source: {
      kind: "agy-observed-window" as const, model: "claude-opus-5-5", observedOn: "2026-11-18",
      references: [
        ".acceptance/native-context/table-verification/serialized-transitions/claude-opus-5-5/result.json",
        ".acceptance/native-context/table-verification/serialized-transitions/claude-opus-5-5/raw-events.jsonl",
      ],
    } }),
    "claude-sonnet-5-5": Object.freeze({ contextWindow: 1000000, source: {
      kind: "agy-observed-window" as const, model: "claude-sonnet-5-5", observedOn: "2026-11-18",
      references: [
        ".acceptance/native-context/table-verification/serialized-transitions/claude-sonnet-5-5/result.json",
        ".acceptance/native-context/table-verification/serialized-transitions/claude-sonnet-5-5/raw-events.jsonl",
      ],
    } }),
    "gpt-oss-120b-medium": Object.freeze({ contextWindow: 131072, source: {
      kind: "agy-observed-window" as const, model: "gpt-oss-120b-medium", observedOn: "2026-11-18",
      references: [
        ".acceptance/native-context/table-verification/serialized-transitions/gpt-oss-120b-medium/result.json",
        ".acceptance/native-context/table-verification/serialized-transitions/gpt-oss-120b-medium/raw-events.jsonl",
      ],
    } }),
  }),
});

export class ContextLimitError extends Error {
  override name = "ContextLimitError";
}

export function contextLimitFor(version: string, modelId: string): ContextLimit | undefined {
  if (!Object.hasOwn(CONTEXT_LIMITS_BY_CLI_VERSION, version)) return undefined;
  const models = CONTEXT_LIMITS_BY_CLI_VERSION[version]!;
  return Object.hasOwn(models, modelId) ? models[modelId] : undefined;
}

export function resolveContextWindow(version: string, modelId: string, requested?: number): number {
  if (requested !== undefined && (!Number.isSafeInteger(requested) || requested <= 0)) {
    throw new ContextLimitError("AGY contextWindow / OMP_AGY_CONTEXT_WINDOW must be a positive safe integer; no prompt was submitted.");
  }
  const ceiling = contextLimitFor(version, modelId)?.contextWindow;
  return ceiling === undefined ? requested ?? 400000 : Math.min(requested ?? ceiling, ceiling);
}
