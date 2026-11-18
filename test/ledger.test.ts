import { describe, expect, test } from "bun:test";
import type { AssistantMessage, ImageContent, Message, Model, UserMessage } from "@oh-my-pi/pi-ai";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { clampProviderContextImages } from "@oh-my-pi/pi-coding-agent/session/provider-image-budget";
import { DateCwdReminderInjector } from "@oh-my-pi/pi-coding-agent/session/date-cwd-reminder";
import { providerImageBudget } from "@oh-my-pi/snapcompact/snapcompact";
import { ContextLedger, canonical, encodeMessages, messageKey, steeringText } from "../src/ledger.ts";

const user = (text: string, timestamp = 1): UserMessage => ({ role: "user", content: text, timestamp });
const assistant: AssistantMessage = {
  role: "assistant", api: "omp-agy-acp", provider: "omp-agy", model: "fixture-model", timestamp: 1,
  content: [{ type: "text", text: "result" }], stopReason: "stop",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
};

const vision: Model = { id: "gemini-4-argon", name: "Image projection fixture", identity: { class: "unknown" }, compat: undefined,
  api: "omp-agy-acp", provider: "omp-agy", baseUrl: "acp://fixture", reasoning: false, input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 400000, maxTokens: 8192 };
const omission = { type: "text" as const, text: "[image omitted: provider image limit]" };
type ImageRole = "user" | "developer" | "toolResult";
const imageBlock = (id: number): ImageContent => ({ type: "image", mimeType: "image/png", data: Buffer.from(`image-${id}`).toString("base64") });
function imageMessage(role: ImageRole, id: number, pure = false): Exclude<Message, AssistantMessage> {
  const content = pure ? [imageBlock(id)] : [{ type: "text" as const, text: `Image ${id}` }, imageBlock(id)];
  return role === "toolResult"
    ? { role, toolCallId: `read-${id}`, toolName: "read", isError: false, timestamp: id, content }
    : { role, timestamp: id, content };
}
function hostProjection(ledger: ContextLedger, history: Message[], model = vision): Message[] {
  ledger.captureContextImages(history);
  ledger.setImageBudget(model.input.includes("image") ? providerImageBudget(model) : Number.POSITIVE_INFINITY);
  return clampProviderContextImages({ messages: convertToLlm(history) }, model).messages;
}

describe("semantic context ledger", () => {
  test("timestamps do not invalidate a prefix, but actual content does", () => {
    const ledger = new ContextLedger(); ledger.checkpoint([user("retained")]);
    expect(ledger.compare([user("retained", 999), user("new")])).toEqual({ continuous: true, appended: [user("new")], acceptedObserved: 0 });
    expect(ledger.compare([user("changed")]).continuous).toBe(false);
    expect(ledger.compare([]).continuous).toBe(false);
  });
  test("accepted live steering is checkpointed after output and never sent twice", () => {
    const ledger = new ContextLedger(); const initial = user("task"); const steer = user("steer");
    ledger.checkpoint([initial]); ledger.acceptSteering([steer]); ledger.commitOutput(assistant);
    expect(ledger.compare([initial, assistant, steer, user("next")])).toEqual({ continuous: true, appended: [user("next")], acceptedObserved: 1 });
  });
  test("an accepted steering receipt does not consume a fresh same-text submission", () => {
    const ledger = new ContextLedger(); const initial = user("task");
    const steer = user("steer", 2); const fresh = user("steer", 3);
    ledger.checkpoint([initial]); ledger.acceptSteering([steer]); ledger.commitOutput(assistant);
    expect(ledger.compare([initial, assistant, fresh])).toEqual({ continuous: true, appended: [fresh], acceptedObserved: 0 });
    expect(ledger.compare([initial, assistant, steer, fresh])).toEqual({ continuous: true, appended: [fresh], acceptedObserved: 1 });
  });
  test("accepted steering follows tool results in real OMP history without losing original result", () => {
    const ledger = new ContextLedger(); const initial = user("task"); const steer = user("steer");
    const response: AssistantMessage = { ...assistant, stopReason: "toolUse", content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }] };
    const result: Message = { role: "toolResult", toolCallId: "call", toolName: "read", content: [], isError: false, timestamp: 2 };
    ledger.checkpoint([initial]); ledger.acceptSteering([steer]); ledger.commitOutput(response);
    const actual = [initial, response, result, steer];
    expect(ledger.compare(actual)).toEqual({ continuous: true, appended: [result], acceptedObserved: 1 });
    ledger.checkpoint(actual);
    expect(ledger.compare([...actual, user("next")])).toEqual({ continuous: true, appended: [user("next")], acceptedObserved: 0 });
  });
  test("tool IDs, original names, structured arguments and final error remain semantic", () => {
    const toolResult: Message = { role: "toolResult", toolCallId: "id", toolName: "read", content: [], isError: true, timestamp: 1 };
    expect(messageKey(toolResult)).not.toBe(messageKey({ ...toolResult, isError: false }));
    expect(messageKey(toolResult)).not.toBe(messageKey({ ...toolResult, toolCallId: "different" }));
    expect(canonical({ second: 2, first: 1 })).toBe(canonical({ first: 1, second: 2 }));
  });
  test("trusted image-cap projection preserves source identity without hiding actual image or text edits", () => {
    const ledger = new ContextLedger(); ledger.setImageBudget(1);
    const first: Extract<Message, { role: "toolResult" }> = { role: "toolResult", toolCallId: "image-one", toolName: "read", isError: false, timestamp: 1,
      content: [{ type: "text", text: "Image result" }, { type: "image", mimeType: "image/png", data: "original-image" }] };
    ledger.captureContextImages([first]); ledger.checkpoint([first]);
    const second: typeof first = { ...first, toolCallId: "image-two", content: [{ type: "image", mimeType: "image/png", data: "new-image" }] };
    ledger.captureContextImages([first, second]);
    const projected: typeof first = { ...first, content: first.content.filter(block => block.type !== "image") };
    expect(ledger.compare([projected, second]).continuous).toBe(true);
    expect(ledger.compare([{ ...projected, content: [{ type: "text", text: "Actually changed text" }] }, second]).continuous).toBe(false);
    expect(ledger.compare([{ ...projected, toolCallId: "different-original-handler" }, second]).continuous).toBe(false);
    const edited: typeof first = { ...first, content: [{ type: "text", text: "Image result" }, { type: "image", mimeType: "image/png", data: "actually-changed-image" }] };
    ledger.captureContextImages([edited, second]);
    expect(ledger.compare([{ ...edited, content: edited.content.filter(block => block.type !== "image") }, second]).continuous).toBe(false);
    first.content = first.content.filter(block => block.type !== "image");
    ledger.captureContextImages([first, second]);
    expect(ledger.compare([first, second]).continuous).toBe(false);
    expect(ledger.compare([]).continuous).toBe(false);
  });
  test("untagged, foreign-ledger and non-cap image loss remain strict history changes", () => {
    const image: Message = { role: "toolResult", toolCallId: "image", toolName: "read", isError: false, timestamp: 1,
      content: [{ type: "text", text: "Image result" }, { type: "image", mimeType: "image/png", data: "original" }] };
    const removed = { ...image, content: image.content.filter(block => block.type !== "image") };
    const direct = new ContextLedger(); direct.checkpoint([image]);
    expect(direct.compare([removed]).continuous).toBe(false);
    const owner = new ContextLedger(); owner.setImageBudget(1); owner.captureContextImages([image]); owner.checkpoint([image]);
    expect(owner.compare([{ ...image, content: removed.content }]).continuous).toBe(false);
    const other = new ContextLedger(); other.setImageBudget(0); other.checkpoint([image]);
    expect(other.compare([{ ...image, content: removed.content }]).continuous).toBe(false);
  });
  test.each(["user", "developer"] as const)("real host conversion preserves a %s screenshot across seven later image reads", role => {
    const ledger = new ContextLedger();
    const history: Message[] = [imageMessage(role, 0)];
    const first = hostProjection(ledger, history);
    ledger.checkpoint(first);
    expect(providerImageBudget(vision)).toBe(5);
    for (let index = 1; index <= 7; index++) {
      const response: AssistantMessage = { ...assistant, content: [{ type: "toolCall", id: `read-${index}`, name: "read", arguments: { path: `image-${index}.png` } }] };
      ledger.commitOutput(response);
      const result = imageMessage("toolResult", index);
      history.push(response, result);
      const projected = hostProjection(ledger, history);
      // Core conversion memoizes old messages: fresh source counts must also
      // reach that cached copy before the clamp spreads it into a projection.
      expect(convertToLlm(history)[0]).toBe(first[0]);
      expect(ledger.compare(projected)).toEqual({ continuous: true, appended: [expect.objectContaining({ role: "toolResult", toolCallId: `read-${index}` })], acceptedObserved: 0 });
      expect(projected.flatMap(message => typeof message.content === "string" ? [] : message.content.filter(block => block.type === "image"))).toHaveLength(Math.min(index + 1, 5));
      if (index >= 5) expect(projected[0]!.content).toEqual([{ type: "text", text: "Image 0" }]);
      ledger.checkpoint(projected);
    }
    expect(history[0]!.content).toEqual([{ type: "text", text: "Image 0" }, imageBlock(0)]);
  });
  test("a compacted archive accepts only its attested oldest-first projection", () => {
    const ledger = new ContextLedger();
    const archive = { role: "compactionSummary" as const, timestamp: 1, summary: "Compacted summary", tokensBefore: 380000,
      blocks: [imageBlock(0), { type: "text" as const, text: "Archive text edge" }, imageBlock(1), imageBlock(2), imageBlock(3), imageBlock(4)] };
    const history: Parameters<typeof convertToLlm>[0] = [archive];
    ledger.setImageBudget(providerImageBudget(vision));
    ledger.captureContextImages(history);
    ledger.checkpoint(convertToLlm(history));
    history.push(imageMessage("toolResult", 5));
    ledger.captureContextImages(history);
    const projected = clampProviderContextImages({ messages: convertToLlm(history) }, vision).messages;
    expect(ledger.compare(projected).continuous).toBe(true);
    const visible = projected[0]!;
    if (visible.role !== "user" || typeof visible.content === "string") throw new Error("Expected the converted summary");
    const [summary, edge, firstImage, ...rest] = visible.content;
    expect(ledger.compare([{ ...visible, content: [summary!, firstImage!, edge!, ...rest] }, projected[1]!]).continuous).toBe(false);
    expect(ledger.compare([{ ...visible, content: [summary!, { type: "text", text: "Edited edge" }, firstImage!, ...rest] }, projected[1]!]).continuous).toBe(false);
    expect(ledger.compare([{ ...visible, content: [summary!, edge!, ...rest] }, projected[1]!]).continuous).toBe(false);
    ledger.discardCapturedSummaries();
    expect(ledger.compare(projected).continuous).toBe(false);
  });
  test.each(["user", "developer", "toolResult"] as const)("real host exact omission placeholder preserves an image-only %s message", role => {
    const ledger = new ContextLedger();
    const first = imageMessage(role, 0, true);
    const history: Message[] = role === "toolResult"
      ? [user("Read images"), { ...assistant, content: [{ type: "toolCall", id: "read-0", name: "read", arguments: { path: "image-0.png" } }] }, first]
      : [first];
    const imageIndex = history.length - 1;
    ledger.checkpoint(hostProjection(ledger, history));
    for (let index = 1; index <= 7; index++) {
      const response: AssistantMessage = { ...assistant, content: [{ type: "toolCall", id: `read-${index}`, name: "read", arguments: { path: `image-${index}.png` } }] };
      ledger.commitOutput(response);
      history.push(response, imageMessage("toolResult", index, true));
      const projected = hostProjection(ledger, history);
      expect(ledger.compare(projected).continuous).toBe(true);
      if (index >= 5) expect(projected[imageIndex]!.content).toEqual([omission]);
      ledger.checkpoint(projected);
    }
    expect(first.content).toEqual([imageBlock(0)]);
  });
  test.each(["user", "developer", "toolResult"] as const)("host projection rejects unauthorized %s image, text, role and history edits", role => {
    const ledger = new ContextLedger();
    const history: Message[] = [imageMessage(role, 0)];
    ledger.checkpoint(hostProjection(ledger, history));
    history.push(...Array.from({ length: 5 }, (_, index) => imageMessage("toolResult", index + 1)));
    const projected = hostProjection(ledger, history);
    expect(ledger.compare(projected).continuous).toBe(true);
    expect(ledger.compare([{ ...projected[0]!, content: [omission] }, ...projected.slice(1)]).continuous).toBe(false);
    expect(ledger.compare([{ ...projected[0]!, role: role === "developer" ? "user" : "developer" } as Message, ...projected.slice(1)]).continuous).toBe(false);
    const edited = { ...history[0]!, content: [{ type: "text" as const, text: "Image 0" }, { ...imageBlock(0), data: "edited" }] } as Message;
    expect(ledger.compare(hostProjection(ledger, [edited, ...history.slice(1)])).continuous).toBe(false);
    const remimed = { ...history[0]!, content: [{ type: "text" as const, text: "Image 0" }, { ...imageBlock(0), mimeType: "image/jpeg" }] } as Message;
    expect(ledger.compare(hostProjection(ledger, [remimed, ...history.slice(1)])).continuous).toBe(false);
    const removed = { ...history[0]!, content: [{ type: "text" as const, text: "Image 0" }] } as Message;
    expect(ledger.compare(hostProjection(ledger, [removed, ...history.slice(1)])).continuous).toBe(false);
    expect(ledger.compare(projected.slice(1)).continuous).toBe(false);
  });
  test.each(["user", "developer", "toolResult"] as const)("only exact, fully authorized image-only %s omission is equivalent", role => {
    const ledger = new ContextLedger();
    const history: Message[] = [imageMessage(role, 0, true)];
    ledger.checkpoint(hostProjection(ledger, history));
    history.push(...Array.from({ length: 5 }, (_, index) => imageMessage("toolResult", index + 1, true)));
    const projected = hostProjection(ledger, history);
    expect(ledger.compare(projected).continuous).toBe(true);
    for (const content of [[], [{ ...omission, text: `${omission.text} edited` }], [omission, omission], [{ ...omission, extra: "not host-authored" }]]) {
      expect(ledger.compare([{ ...projected[0]!, content } as Message, ...projected.slice(1)]).continuous).toBe(false);
    }
    const sourceText = { ...history[0]!, content: [{ type: "text" as const, text: "Original text must survive" }, imageBlock(0)] } as Message;
    expect(ledger.compare(hostProjection(ledger, [sourceText, ...history.slice(1)])).continuous).toBe(false);
  });
  test("partial image eviction preserves retained bytes and never admits an omission block", () => {
    const ledger = new ContextLedger();
    const first: UserMessage = { role: "user", timestamp: 1, content: [imageBlock(0), imageBlock(1)] };
    const history: Message[] = [first];
    ledger.checkpoint(hostProjection(ledger, history));
    history.push(...Array.from({ length: 4 }, (_, index) => imageMessage("toolResult", index + 2, true)));
    const projected = hostProjection(ledger, history);
    expect(projected[0]!.content).toEqual([imageBlock(1)]);
    expect(ledger.compare(projected).continuous).toBe(true);
    expect(ledger.compare([{ ...projected[0]!, content: [omission, imageBlock(1)] }, ...projected.slice(1)]).continuous).toBe(false);
    expect(ledger.compare([{ ...projected[0]!, content: [imageBlock(0)] }, ...projected.slice(1)]).continuous).toBe(false);
    expect(ledger.compare([{ ...projected[0]!, content: [{ ...imageBlock(1), data: "edited-retained-image" }] }, ...projected.slice(1)]).continuous).toBe(false);
    expect(ledger.compare([{ ...projected[0]!, content: [omission] }, ...projected.slice(1)]).continuous).toBe(false);
  });
  test("moving a retained image across source text is not a count projection", () => {
    const ledger = new ContextLedger();
    const text = { type: "text" as const, text: "Source text between images" };
    const original: UserMessage = { role: "user", timestamp: 1, content: [imageBlock(0), text, imageBlock(1)] };
    const history: Message[] = [original];
    const before = hostProjection(ledger, history);
    ledger.checkpoint(before);
    const keys = ledger.explicitInputKeys(before);
    history.push(...Array.from({ length: 4 }, (_, index) => imageMessage("toolResult", index + 2, true)));
    const projected = hostProjection(ledger, history);
    expect(projected[0]!.content).toEqual([text, imageBlock(1)]);
    expect(ledger.explicitInputKeys(projected)).toEqual(keys);
    const reordered = [{ ...projected[0]!, content: [imageBlock(1), text] }, ...projected.slice(1)];
    expect(ledger.compare(reordered).continuous).toBe(false);
    expect(ledger.explicitInputKeys(reordered)).not.toEqual(keys);
  });
  test.each(["user", "developer", "toolResult"] as const)("%s projections require this ledger's provenance and image-capable model", role => {
    const owner = new ContextLedger();
    const history: Message[] = [imageMessage(role, 0, true)];
    const first = hostProjection(owner, history);
    owner.checkpoint(first);
    const direct = new ContextLedger(); direct.checkpoint(first);
    const foreign = new ContextLedger(); foreign.setImageBudget(5); foreign.checkpoint(first);
    history.push(...Array.from({ length: 5 }, (_, index) => imageMessage("toolResult", index + 1, true)));
    const projected = hostProjection(owner, history);
    expect(owner.compare(projected).continuous).toBe(true);
    expect(direct.compare(projected).continuous).toBe(false);
    expect(foreign.compare(projected).continuous).toBe(false);
    const persisted: Message[] = JSON.parse(JSON.stringify(projected));
    expect(owner.compare(persisted).continuous).toBe(false);
    const textOnly: Model = { ...vision, input: ["text"] };
    const unclamped = hostProjection(owner, history, textOnly);
    expect(unclamped[0]!.content).toEqual([imageBlock(0)]);
    expect(owner.compare(unclamped).continuous).toBe(true);
    expect(owner.compare(projected).continuous).toBe(false);
    expect(() => encodeMessages(unclamped, {}, true)).toThrow("does not advertise image");
    expect(encodeMessages(projected, { image: true }, true).filter(block => block.type === "image")).toHaveLength(5);
    expect(() => encodeMessages(projected, {}, true)).toThrow("does not advertise image");
  });
  test("literal omission text is semantic, and assistant images never consume the input cap", () => {
    const ledger = new ContextLedger();
    const literal: UserMessage = { role: "user", timestamp: 1, content: [omission, imageBlock(0)] };
    const output: AssistantMessage = { ...assistant, content: [imageBlock(99)] };
    const history: Message[] = [literal, output];
    ledger.checkpoint(hostProjection(ledger, history));
    history.push(...Array.from({ length: 4 }, (_, index) => imageMessage("toolResult", index + 1, true)));
    const atCap = hostProjection(ledger, history);
    expect(atCap[0]!.content).toEqual([omission, imageBlock(0)]);
    expect(ledger.compare(atCap).continuous).toBe(true);
    history.push(imageMessage("toolResult", 5, true));
    const projected = hostProjection(ledger, history);
    expect(projected[0]!.content).toEqual([omission]);
    expect(ledger.compare(projected).continuous).toBe(true);
    expect(ledger.compare([{ ...projected[0]!, content: [] }, ...projected.slice(1)]).continuous).toBe(false);
    expect(ledger.compare([projected[0]!, { ...output, content: [] }, ...projected.slice(2)]).continuous).toBe(false);
  });
  test.each(["user", "developer", "toolResult"] as const)("memoized conversion cannot hide edits to captured %s history", role => {
    for (const mutation of ["text", "image", "missing", "header"] as const) {
      const ledger = new ContextLedger();
      const original = imageMessage(role, 0);
      const history: Message[] = [original];
      ledger.checkpoint(hostProjection(ledger, history));
      history.push(...Array.from({ length: 5 }, (_, index) => imageMessage("toolResult", index + 1)));
      expect(ledger.compare(hostProjection(ledger, history)).continuous).toBe(true);
      const cached = convertToLlm(history)[0];
      if (mutation === "text") original.content = [{ type: "text", text: "Changed original history" }, imageBlock(0)];
      else if (mutation === "image") original.content = [{ type: "text", text: "Image 0" }, { ...imageBlock(0), data: "changed-original-image" }];
      else if (mutation === "missing") original.content = [{ type: "text", text: "Image 0" }];
      else if (original.role === "toolResult") original.toolCallId = "changed-original-handler";
      else original.role = original.role === "user" ? "developer" : "user";
      const projected = hostProjection(ledger, history);
      expect(convertToLlm(history)[0]).toBe(cached);
      expect(ledger.compare(projected).continuous).toBe(false);
    }
  });
  test.each(["user", "developer"] as const)("string and empty-text-block %s content is not an image omission", role => {
    for (const content of [omission.text, [{ type: "text" as const, text: "" }, imageBlock(0)]]) {
      const ledger = new ContextLedger();
      const original: Message = { role, timestamp: 1, content };
      const history: Message[] = [original];
      ledger.checkpoint(hostProjection(ledger, history));
      history.push(...Array.from({ length: 6 }, (_, index) => imageMessage("toolResult", index + 1, true)));
      const projected = hostProjection(ledger, history);
      expect(projected[0]!.content).toEqual(typeof content === "string" ? omission.text : [{ type: "text", text: "" }]);
      expect(ledger.compare(projected).continuous).toBe(true);
      expect(ledger.compare([{ ...projected[0]!, content: [] }, ...projected.slice(1)]).continuous).toBe(false);
      if (typeof content !== "string") expect(ledger.compare([{ ...projected[0]!, content: [omission] }, ...projected.slice(1)]).continuous).toBe(false);
    }
  });
  test.each(["user", "developer"] as const)("replay keys preserve an attested image-only %s input across eviction", role => {
    const ledger = new ContextLedger();
    const reminder = new DateCwdReminderInjector();
    const history: Message[] = [imageMessage(role, 0, true)];
    const project = (source = history) => reminder.transform({ messages: hostProjection(ledger, source), systemPrompt: ["Fixture"] }, "2026-11-18", "C:/fixture").messages;
    const before = project();
    ledger.checkpoint(before);
    const keys = ledger.explicitInputKeys(before);
    history.push(...Array.from({ length: 5 }, (_, index) => imageMessage("toolResult", index + 1, true)));
    const projected = project();
    expect(projected[0]!.content).toContainEqual(omission);
    expect(ledger.compare(projected).continuous).toBe(true);
    expect(ledger.explicitInputKeys(projected)).toEqual(keys);
    expect(ledger.explicitInputKeys(structuredClone(projected))).not.toEqual(keys);

    const cached = convertToLlm(history);
    const original = history[0]!;
    const copied = project([{ ...original }, ...history.slice(1)]);
    expect(ledger.compare(copied).continuous).toBe(true);
    expect(ledger.explicitInputKeys(copied)).toEqual(keys);

    // A fresh array lets OMP see the replaced interior message; the visible
    // omission (and the submission timestamp) remains identical after the edit.
    const replacement = { ...original, content: [imageBlock(99)] };
    const editedHistory = [replacement, ...history.slice(1)];
    const edited = project(editedHistory);
    expect(convertToLlm(editedHistory)[0]!.content).toEqual(replacement.content);
    expect(edited[0]!.content).toEqual(projected[0]!.content);
    expect(ledger.compare(edited).continuous).toBe(false);
    expect(ledger.explicitInputKeys(edited)).not.toEqual(keys);

    // Deliberately violate OMP's append-only array cache contract. Same array,
    // length and tail return old conversion, not the new attested source.
    history[0] = replacement;
    const stale = project();
    expect(convertToLlm(history)).toBe(cached);
    expect(stale[0]!.content).toEqual(projected[0]!.content);
    expect(ledger.compare(stale).continuous).toBe(false);
    expect(ledger.explicitInputKeys(stale)).toEqual(keys);
  });
  test("replay keys ignore synthetic continuation but distinguish a new same-text submission", () => {
    const ledger = new ContextLedger();
    const initial = user("task");
    const keys = ledger.explicitInputKeys([initial]);
    expect(ledger.explicitInputKeys([initial, assistant, { ...user("continue"), synthetic: true }])).toEqual(keys);
    expect(ledger.explicitInputKeys([user("task", 2)])).not.toEqual(keys);
    expect(ledger.explicitInputKeys([initial, user("task", 2)])).not.toEqual(keys);
  });
  test("reminder-shaped user content is retained and histories label tool calls as records", () => {
    const messages: Message[] = [user("<system-reminder>literal</system-reminder>"), {
      ...assistant, content: [{ type: "toolCall", id: "old", name: "write", arguments: { path: "x" } }],
    }, user("new input")];
    const text = JSON.stringify(encodeMessages(messages, {}, true));
    expect(text).toContain("<system-reminder>literal</system-reminder>");
    expect(text).toContain("historicalToolCall"); expect(text).toContain("alreadyAttempted");
    expect(text).toContain("CURRENT PENDING INPUT");
  });
  test("fresh user-only input has no history reconstruction or attempted-tool declaration", () => {
    const prompt = encodeMessages([user("first task")], {}, true);
    expect(prompt).toContainEqual({ type: "text", text: "first task" });
    const text = JSON.stringify(prompt);
    expect(text).toContain("CURRENT PENDING INPUT");
    expect(text).not.toContain("Historical assistant tool calls"); expect(text).not.toContain("reconstructs");
    expect(text).not.toContain("already attempted");
  });
  test("history encoding rejects non-finite arguments rather than silently replacing them with null", () => {
    const history: Message = { ...assistant, content: [{ type: "toolCall", id: "old", name: "read", arguments: { values: [NaN] } }] };
    expect(() => encodeMessages([history, user("next")], {}, true)).toThrow("Non-finite JSON number");
  });
  test("unsupported image prompts throw without mutating or text-substituting the attachment", () => {
    const image: UserMessage = { role: "user", content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }], timestamp: 1 };
    const before = canonical(image);
    expect(() => encodeMessages([image], {}, true)).toThrow("does not advertise image");
    expect(canonical(image)).toBe(before);
    expect(encodeMessages([image], { image: true }, true).some(block => block.type === "image")).toBe(true);
    expect(() => steeringText([image])).toThrow("deferred");
  });
});
