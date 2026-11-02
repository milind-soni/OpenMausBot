#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const dump = (row) => appendFileSync(process.env.FAKE_PI_LIFECYCLE_DUMP, JSON.stringify(row) + "\n");
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
const reply = (command, data) => send({ type: "response", command, success: true, data });
const model = { provider: "fixture", id: "default" };

// Like Pi, ends its own tool processes on TERM, which takes a moment, then exits.
process.on("SIGTERM", () => setTimeout(() => { dump({ terminated: true }); process.exit(143); }, 100));
setInterval(() => {}, 1_000);
createInterface({ input: process.stdin }).on("line", (line) => {
  const cmd = JSON.parse(line);
  if (cmd.type === "get_available_models") {
    process.stdout.write(JSON.stringify({ type: "response", command: cmd.type, success: true, data: { models: [model] } }) + "\n", () => process.exit(0));
  }
  if (cmd.type === "get_state") {
    reply(cmd.type, { sessionFile: "fixture-session.jsonl", model });
  }
  if (["new_session", "switch_session"].includes(cmd.type)) reply(cmd.type, { cancelled: false });
  if (cmd.type === "set_model") {
    dump({ setModel: cmd.modelId });
    if (cmd.modelId === "refused") send({ type: "response", command: cmd.type, success: false, error: "Model unavailable" });
    else reply(cmd.type, { provider: "fixture", id: "confirmed" });
  }
  if (cmd.type === "prompt") {
    dump({ prompt: cmd.message, pid: process.pid });
    reply(cmd.type);
    send({ type: "tool_execution_start", toolCallId: "ready", toolName: "fixture" });
    if (cmd.message.startsWith("usage:")) {
      const stopReason = cmd.message === "usage:hold" ? "toolUse" : cmd.message.slice("usage:".length);
      send({ type: "turn_end", message: { stopReason, usage: { input: 5, output: 1 } }, usage: { input: 5, output: 1 } });
      if (cmd.message === "usage:hold") {
        send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "usage-ready" } });
        return;
      }
      send({ type: "turn_start" });
      send({ type: "turn_end", message: { stopReason: "end_turn", usage: { input: 12, output: 2 } } });
      send({ type: "agent_end", isTerminal: true });
      send({ type: "agent_settled" });
      return;
    }
    if (cmd.message.startsWith("maintenance:")) {
      const kind = cmd.message.slice("maintenance:".length);
      send({ type: "turn_end", message: { stopReason: kind === "turn_start" ? "stop" : "end_turn" } });
      if (kind === "retry") send({ type: "agent_end", willRetry: true });
      else if (kind === "nonterminal") send({ type: "agent_end", isTerminal: false });
      else send({ type: kind });
      send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "maintenance-ready" } });
      return;
    }
    if (cmd.message !== "wait") {
      send({ type: "turn_end", message: { stopReason: "end_turn" } });
      send({ type: "agent_end", isTerminal: true });
      send({ type: "agent_settled" });
    }
  }
  if (cmd.type === "steer") {
    send({ type: "response", command: cmd.type, id: cmd.id, success: true });
    send({ type: "turn_end", message: { stopReason: "end_turn" } });
    send({ type: "agent_end", isTerminal: true });
    send({ type: "agent_settled" });
  }
});
