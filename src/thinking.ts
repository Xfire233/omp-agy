import { THINKING_EFFORTS, type Model } from "@oh-my-pi/pi-ai";
import { ThinkingSelectionError, type ThoughtOptions } from "./protocol.ts";

/** Only exact, unambiguous canonical values authorize OMP's native effort selector. */
export function thinkingMetadata(thought?: ThoughtOptions): { reasoning: boolean; thinking?: Model["thinking"] } {
  if (!thought) return { reasoning: false };
  const values = new Set<string>();
  for (const option of thought.options) {
    if (values.has(option.value)) throw new ThinkingSelectionError(`ACP thought selector '${thought.configId}' advertises duplicate value '${option.value}'`);
    values.add(option.value);
  }
  const efforts = THINKING_EFFORTS.filter(effort => values.has(effort));
  if (!efforts.length) return { reasoning: false };
  const defaultLevel = efforts.find(effort => effort === thought.currentValue);
  return { reasoning: true, thinking: { mode: "effort", efforts, ...(defaultLevel ? { defaultLevel } : {}) } };
}
