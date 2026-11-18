import { createHash } from "node:crypto";
import type { ContentBlock, PromptCapabilities } from "@agentclientprotocol/sdk";
import type { AssistantMessage, DeveloperMessage, ImageContent, Message, UserMessage } from "@oh-my-pi/pi-ai";
import { assertJsonValue } from "./catalog.ts";

/** Stable object ordering is for semantic equality, not a replacement for protocol JSON. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function semanticContent(content: Message["content"]): unknown {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map(block => {
    switch (block.type) {
      case "text": return { type: "text", text: block.text };
      case "thinking": return { type: "thinking", thinking: block.thinking };
      case "image": return { type: "image", mimeType: block.mimeType, data: block.data };
      case "toolCall": return { type: "toolCall", id: block.id, name: block.name, arguments: block.arguments };
      default: return block; // Preserve other native semantic blocks; never delete their content.
    }
  });
}

export function semanticMessage(message: Message): unknown {
  return message.role === "toolResult"
    ? { role: message.role, toolCallId: message.toolCallId, toolName: message.toolName,
        isError: message.isError, content: semanticContent(message.content) }
    : { role: message.role, content: semanticContent(message.content) };
}
export const messageKey = (message: Message): string => canonical(semanticMessage(message));

interface ImageProjectionSource {
  capture: number;
  images: { index: number; key: string }[];
  total: number;
  offset: number;
  blockCount: number;
  messageKey: string;
}

export interface HostContextImageMessage {
  role: string;
  content?: unknown;
  summary?: unknown;
  blocks?: unknown;
  images?: unknown;
  timestamp?: number;
  historyRewriteAt?: number;
}

interface SummaryImageProjection {
  images: ImageProjectionSource["images"];
  total: number;
  offset: number;
  blockCount: number;
  texts: string[];
  stableKey: string;
}

function hostImageBlocks(message: HostContextImageMessage): Exclude<Message["content"], string> | undefined {
  if (message.role === "assistant") return undefined;
  const content = message.role === "compactionSummary" ? message.blocks ?? message.images : message.content;
  return Array.isArray(content) ? content as Exclude<Message["content"], string> : undefined;
}

const imageIdentity = (block: ImageContent): string => canonical({ mimeType: block.mimeType, sha256: createHash("sha256").update(block.data).digest("hex") });

// Pinned OMP count-clamp fallback for a message whose images were its entire content.
const IMAGE_OMISSION_KEY = canonical({ type: "text", text: "[image omitted: provider image limit]" });

export class ContextLedger {
  private prefix: string[] = [];
  private accepted: string[] = [];
  // OMP's provider image cap removes oldest images from a per-request copy,
  // not from host history. Only this ledger's pre-transform context hook can
  // attest that source; untagged/direct provider inputs retain strict equality.
  private readonly imageSource = Symbol("omp-agy source context images");
  // Only captured originals own mutable attestations; a spread clone must not
  // overwrite the attestation shared by another message's cached conversion.
  private readonly imageSources = new WeakMap<object, ImageProjectionSource>();
  private imageCapture = 0;
  // Summary conversion constructs a fresh UserMessage instead of spreading the
  // original. Index candidates per capture; their full visible shape is checked.
  private readonly summaryImages = new Map<string, SummaryImageProjection | null>();
  private imageBudget = Number.POSITIVE_INFINITY;

  setImageBudget(budget: number): void { this.imageBudget = budget; }

  captureContextImages(messages: readonly HostContextImageMessage[]): void {
    const capture = ++this.imageCapture;
    this.summaryImages.clear();
    let total = 0;
    const counts = messages.map(message => {
      let count = 0;
      for (const block of hostImageBlocks(message) ?? []) if (block.type === "image") count++;
      total += count; return count;
    });
    let before = 0;
    for (const [index, message] of messages.entries()) {
      const offset = before; before += counts[index]!;
      if (message.role === "compactionSummary") {
        const { timestamp, historyRewriteAt, summary } = message;
        if (typeof timestamp !== "number") continue;
        const identity = `${timestamp}:${historyRewriteAt ?? timestamp}`;
        if (this.summaryImages.has(identity)) { this.summaryImages.set(identity, null); continue; }
        if (!counts[index] || typeof summary !== "string" || !Array.isArray(message.blocks)) { this.summaryImages.set(identity, null); continue; }
        const images: SummaryImageProjection["images"] = [];
        const texts = [summary];
        for (const [index, block] of (hostImageBlocks(message) ?? []).entries()) {
          if (block.type === "image") images.push({ index: index + 1, key: imageIdentity(block) });
          else if (block.type === "text") texts.push(block.text);
        }
        this.summaryImages.set(identity, { images, total, offset, blockCount: message.blocks.length + 1, texts,
          stableKey: canonical({ source: "compactionSummary", texts, images }) });
        continue;
      }
      const previous = this.imageSources.get(message);
      if (message.role === "assistant" || !Array.isArray(message.content)) {
        if (previous) previous.images = [];
        this.imageSources.delete(message);
        Reflect.deleteProperty(message, this.imageSource); continue;
      }
      // These are trusted host ContextEvent messages, not external JSON input.
      const content = message.content as Exclude<Message["content"], string>;
      const images = content.flatMap((block, index) => block.type === "image"
        ? [{ index, key: imageIdentity(block) }] : []);
      if (images.length) {
        const blockCount = content.length;
        const key = messageKey({ ...message, content: content.filter(block => block.type !== "image") } as Message);
        // convertToLlm caches object-spread copies. Keep their shared attestation
        // current as the host appends images, without retaining any image bytes.
        // Retain source text/header identity too, so a stale converted copy
        // cannot conceal a real edit to the captured host history.
        if (previous) {
          previous.capture = capture;
          previous.images = images; previous.total = total; previous.offset = offset;
          previous.blockCount = blockCount; previous.messageKey = key;
        }
        else {
          const source: ImageProjectionSource = { capture, images, total, offset, blockCount, messageKey: key };
          this.imageSources.set(message, source);
          Object.defineProperty(message, this.imageSource, { value: source, enumerable: true, configurable: true });
        }
      } else {
        // Invalidate cached copies too: a source-side deletion is not a clamp.
        if (previous) previous.images = [];
        this.imageSources.delete(message);
        Reflect.deleteProperty(message, this.imageSource);
      }
    }
  }

  /** Only the just-prepared host invocation can attest a converted summary. */
  discardCapturedSummaries(): void { this.summaryImages.clear(); }

  private summarySource(message: Message): SummaryImageProjection | undefined {
    if (message.role !== "user" || message.attribution !== "agent" || message.historyRewriteAt === undefined) return;
    return this.summaryImages.get(`${message.timestamp}:${message.historyRewriteAt}`) ?? undefined;
  }

  private summaryKey(message: Message, source: SummaryImageProjection): string | undefined {
    if (typeof message.content === "string") return;
    const drops = Math.min(source.images.length, Math.max(0, source.total - this.imageBudget - source.offset));
    // OMP may prepend its date/CWD reminder after clamping. Keep that actual
    // leading block in the equality key; never hide additions or edits to it.
    const leading = message.content.length - (source.blockCount - drops);
    const first = message.content[0];
    if (leading < 0 || leading > 1 || (leading === 1 && first?.type !== "text")) return;
    let nextImage = drops, nextText = 0;
    for (let position = leading; position < message.content.length; position++) {
      const block = message.content[position]!;
      const expected = source.images[nextImage];
      if (expected?.index === position - leading + drops) {
        if (block.type !== "image" || imageIdentity(block) !== expected.key) return;
        nextImage++;
      } else if (block.type !== "text" || block.text !== source.texts[nextText++]) return;
    }
    if (nextImage !== source.images.length || nextText !== source.texts.length) return;
    return leading === 1 && first?.type === "text" ? `${JSON.stringify(first.text)}\n${source.stableKey}` : source.stableKey;
  }

  private sourceFor(message: Message): ImageProjectionSource | undefined {
    // Only captureContextImages writes this factory-private symbol.
    return (message as unknown as Record<symbol, ImageProjectionSource | undefined>)[this.imageSource];
  }

  private historyKey(message: Message): string | undefined {
    const source = this.sourceFor(message);
    // A cached conversion can outlive the source object that produced it. Do
    // not use its tag to attest the replacement, even if the omission is equal.
    if (source && source.capture !== this.imageCapture) return;
    return this.key(message, source);
  }

  private key(message: Message, source: ImageProjectionSource | undefined): string {
    const summary = this.summarySource(message);
    if (summary) return this.summaryKey(message, summary) ?? messageKey(message);
    if (message.role === "assistant" || !source?.images.length || typeof message.content === "string") return messageKey(message);
    // Match the pinned host's count-cap projection, not arbitrary image removal.
    // Byte clamps/transcodes/other rewrites stay conservative unless separately
    // attested; no missing image is accepted merely because it is missing.
    const drops = Math.min(source.images.length, Math.max(0, source.total - this.imageBudget - source.offset));
    const omitted = drops === source.blockCount;
    // OMP can prepend a date/CWD block after clamping. Allow that shape but
    // retain the actual leading text in the key, including after full eviction.
    const leading = message.content.length - (omitted ? 1 : source.blockCount - drops);
    if (leading < 0 || leading > 1 || (leading === 1 && message.content[0]?.type !== "text")) return messageKey(message);
    if (omitted && canonical(message.content[leading]) !== IMAGE_OMISSION_KEY) return messageKey(message);
    let nextImage = drops;
    for (let index = leading; !omitted && index < message.content.length; index++) {
      const block = message.content[index]!;
      const expected = source.images[nextImage];
      if (expected?.index === index - leading + drops) {
        if (block.type !== "image" || imageIdentity(block) !== expected.key) return messageKey(message);
        nextImage++;
      } else if (block.type === "image") return messageKey(message);
    }
    if (!omitted && nextImage !== source.images.length) return messageKey(message);
    const content = omitted ? message.content.slice(0, leading) : message.content.filter(block => block.type !== "image");
    return canonical({ message: semanticMessage({ ...message, content } as Message), sourceMessage: source.messageKey, sourceImages: source.images });
  }

  private submissionKey(message: UserMessage | DeveloperMessage): string {
    // Keep the old submission identity for an unchanged stale provider view:
    // it must not bypass the dirty-attempt fence on account of a cache hit.
    return canonical([message.timestamp, this.key(message, this.sourceFor(message))]);
  }

  /** Dirty-attempt identity uses the attested projection and the host submission timestamp.
   * History continuity itself remains semantic and timestamp-independent. */
  explicitInputKeys(messages: readonly Message[]): string[] {
    const keys: string[] = [];
    for (const message of messages) {
      if ((message.role === "user" || message.role === "developer") && !message.synthetic) {
        keys.push(this.submissionKey(message));
      }
    }
    return keys;
  }

  compare(messages: readonly Message[]): { continuous: boolean; appended: Message[]; acceptedObserved: number } {
    const continuous = messages.length >= this.prefix.length && this.prefix.every((key, index) => key === this.historyKey(messages[index]!));
    if (!continuous) return { continuous: false, appended: [...messages], acceptedObserved: 0 };
    const appended: Message[] = [];
    let acceptedObserved = 0;
    for (const message of messages.slice(this.prefix.length)) {
      const accepted = this.accepted[acceptedObserved];
      if (accepted && message.role === "user" && this.submissionKey(message) === accepted) acceptedObserved++;
      else appended.push(message);
    }
    return { continuous: true, appended, acceptedObserved };
  }
  /** Opt-in debug metadata only: no content, paths or image bytes are returned. */
  explain(messages: readonly Message[]): Record<string, unknown> {
    const index = this.prefix.findIndex((key, index) => !messages[index] || key !== this.historyKey(messages[index]!));
    const actual = index < 0 || !messages[index] ? undefined : this.historyKey(messages[index]!);
    let sourceImages = 0; let visibleImages = 0; let projectedResults = 0;
    for (const message of messages) {
      const source = this.summarySource(message) ?? this.sourceFor(message);
      if (message.role === "assistant" || !source?.images.length || typeof message.content === "string") continue;
      projectedResults++; sourceImages += source.images.length;
      visibleImages += message.content.filter(block => block.type === "image").length;
    }
    return { prefixMessages: this.prefix.length, currentMessages: messages.length, firstMismatchIndex: index < 0 ? undefined : index,
      firstMismatchRole: index < 0 ? undefined : messages[index]?.role,
      expectedSha256: index < 0 ? undefined : createHash("sha256").update(this.prefix[index]!).digest("hex"),
      actualSha256: actual === undefined ? undefined : createHash("sha256").update(actual).digest("hex"),
      projectedResults, sourceImages, visibleImages, elidedImages: sourceImages - visibleImages, imageBudget: this.imageBudget };
  }
  checkpoint(messages: readonly Message[]): void {
    const comparison = this.compare(messages);
    if (comparison.continuous && comparison.acceptedObserved) this.accepted.splice(0, comparison.acceptedObserved);
    this.prefix = messages.map(message => this.key(message, this.sourceFor(message)));
  }
  acceptSteering(messages: readonly UserMessage[]): void {
    for (const message of messages) this.accepted.push(this.submissionKey(message));
  }
  /** Accepted inputs remain separate until OMP commits them, possibly after tool results. */
  commitOutput(message: AssistantMessage): void { this.prefix.push(messageKey(message)); }
  clear(): void { this.prefix = []; this.accepted = []; }
}

/** Capability-independent checks run before opening a costly ACP activation. */
export function validateMessages(messages: readonly Message[]): void {
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const block of message.content) {
      switch (block.type) {
        case "text": case "image": case "thinking": break;
        case "toolCall": assertJsonValue(block.arguments); break;
        default: throw new Error(`Unsupported OMP history content block '${block.type}'. Original content remains in OMP; no text-only substitution was sent.`);
      }
    }
  }
}

/** Only the effective messages enter ACP. Standalone systemPrompt is intentionally absent. */
export function encodeMessages(messages: readonly Message[], capabilities: PromptCapabilities, seed: boolean): ContentBlock[] {
  validateMessages(messages);
  const history = messages.some(message => message.role === "assistant" || message.role === "toolResult");
  const output: ContentBlock[] = [{ type: "text", text: seed
    ? history
      ? "OMP effective conversation follows. Historical assistant tool calls and tool results are records of actions already attempted, NOT requests to execute them again. Unknown or interrupted effects have not been rolled back. Only the final pending input is the current task. This reconstructs visible OMP history, not prior AGY hidden state."
      : "OMP input follows, in host order. The final pending input is the current task."
    : "Additional OMP input follows, in host order. Tool results are delivered separately through their original MCP request, not repeated here." }];
  let latest = -1;
  for (let index = 0; index < messages.length; index++) {
    if (messages[index]!.role === "user" || messages[index]!.role === "developer") latest = index;
  }
  messages.forEach((message, index) => {
    const label = seed && index === latest ? "CURRENT PENDING INPUT" : "CONVERSATION RECORD";
    output.push({ type: "text", text: `\n${label} ${canonical({ role: message.role, ...(message.role === "toolResult"
      ? { toolCallId: message.toolCallId, toolName: message.toolName, isError: message.isError } : {}) })}\n` });
    const blocks = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
    for (const block of blocks) {
      switch (block.type) {
        case "text": output.push({ type: "text", text: block.text }); break;
        case "image":
          if (!capabilities.image) throw new Error("ACP agent does not advertise image prompts. Attachment remains in OMP history; nothing was submitted.");
          output.push({ type: "image", data: block.data, mimeType: block.mimeType }); break;
        case "thinking": output.push({ type: "text", text: canonical({ historicalThinking: block.thinking }) }); break;
        case "toolCall": output.push({ type: "text", text: canonical({ historicalToolCall: { id: block.id, name: block.name, arguments: block.arguments }, alreadyAttempted: true }) }); break;
        default: throw new Error(`Unsupported OMP history content block '${block.type}'. Original content remains in OMP; no text-only substitution was sent.`);
      }
    }
  });
  return output;
}

/** Native steering is deliberately text-only, matching the host live-channel contract. */
export function steeringText(messages: readonly UserMessage[]): string {
  return messages.map(message => {
    if (typeof message.content === "string") return message.content;
    if (message.content.some(block => block.type !== "text")) throw new Error("Live steering attachments are deferred to the next provider boundary, not converted to text.");
    return message.content.map(block => block.type === "text" ? block.text : "").join("");
  }).join("\n\n");
}
