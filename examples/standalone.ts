// Bun, with an already authenticated local Antigravity CLI. No OMP packages or session required.
// Fixed Windows WSL2 runner: bun run examples/standalone.ts "Use greet with the name Ada."
// Native POSIX runner: set AGY_CLI and AGY_ACCOUNT_DIRECTORY to explicit absolute paths first.
// Installed integrations can import the same API from "omp-agy/core".
import { Agent, type RunnerConfig } from "../core.ts";

const cli = process.env.AGY_CLI;
const accountDirectory = process.env.AGY_ACCOUNT_DIRECTORY;
if (!!cli !== !!accountDirectory) throw new Error("Set both AGY_CLI and AGY_ACCOUNT_DIRECTORY to opt in to native mode");
const runner: RunnerConfig | undefined = cli && accountDirectory ? { mode: "native", cli, accountDirectory } : undefined;
const cancel = new AbortController();
const onInterrupt = () => cancel.abort(new Error("Interrupted"));
process.on("SIGINT", onInterrupt);
try {
  const agent = await Agent.open({
    config: { runner }, signal: cancel.signal,
    tools: [{ name: "greet", description: "Generate a greeting for the supplied name",
      parameters: { type: "object", properties: { name: { type: "string", maxLength: 80 } }, required: ["name"], additionalProperties: false } }],
    executeTool(call, signal) {
      signal.throwIfAborted();
      if (call.name !== "greet" || typeof call.arguments.name !== "string") throw new Error("Unexpected tool call");
      // This caller deliberately authorizes only a side-effect-free greeting.
      return { source: "content", isError: false, content: [{ type: "text", text: `Hello, ${call.arguments.name}!` }] };
    },
  });
  try {
    const model = process.env.AGY_MODEL;
    if (model) await agent.selectModel(model);
    agent.send(process.argv.slice(2).join(" ") || "Call greet with the name Ada, then tell me what it returned.", { signal: cancel.signal });
    for await (const update of agent.receive()) {
      switch (update.type) {
        case "text": process.stdout.write(update.text); break;
        case "tool_call": console.error(`[tool: ${update.call.name}]`); break;
        case "image": console.error(`[image: ${update.mimeType}]`); break;
        case "done": console.error(`\n[${update.stopReason}]`); break;
        case "thinking": break; // A UI may render update.text separately from the answer.
      }
    }
  } finally { await agent.close(); }
} finally { process.removeListener("SIGINT", onInterrupt); }
