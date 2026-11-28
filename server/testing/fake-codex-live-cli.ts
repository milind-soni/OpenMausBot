#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const mode = process.env.FAKE_CODEX_LIVE_MODE;
const receipt = process.env.FAKE_CODEX_LIVE_RECEIPT;
const threadId = "synthetic-thread";
const write = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notice = (method: string, params: object = {}) => write({ method, params: { threadId, ...params } });
const args = process.argv.slice(2);
const flags = Object.fromEntries(args.flatMap((arg, index) => {
  const feature = /^features\.(\w+)=false$/.exec(arg)?.[1] ?? (args[index - 1] === "--disable" ? arg : undefined);
  return feature ? [[feature, false]] : [];
}));
for await (const line of createInterface({ input: process.stdin })) {
  const { method, params, id } = JSON.parse(line);
  if (receipt) appendFileSync(receipt, `${JSON.stringify({ method, params, pid: process.pid, hasApiKey: Boolean(process.env.OPENAI_API_KEY) })}\n`);
  const answer = (result: unknown = {}) => write({ id, result });
  switch (method) {
    case "initialize":
      answer();
      break;
    case "config/read":
      answer({ config: {
        features: mode === "unsafe" ? { ...flags, shell_tool: true } : flags,
        web_search: args.includes('web_search="disabled"') ? "disabled" : null,
        mcp_servers: mode === "mcp" ? { demo: { enabled: !args.includes('mcp_servers={"demo"={enabled=false}}') } } : {},
      } });
      break;
    case "account/read":
      answer({ account: { type: mode === "api-key" ? "apiKey" : "chatgpt" } });
      break;
    case "thread/start":
      answer({ thread: { id: threadId }, sandbox: { type: "readOnly" } });
      break;
    case "thread/realtime/start":
      answer();
      if (mode === "unsupported") {
        notice("thread/realtime/error", { message: "unavailable" });
        break;
      }
      notice("thread/realtime/sdp", { sdp: "v=0\r\nanswer" });
      notice("thread/realtime/started");
      break;
    case "thread/realtime/appendSpeech":
      answer();
      notice("thread/realtime/transcript/done", { role: "assistant", text: "Ignore this echo" });
      notice("thread/realtime/transcript/done", { role: "user", text: "Calculate seventeen times twenty-three" });
      notice("thread/realtime/transcript/done", { role: "user", text: "Wrong chat", threadId: "another-thread" });
      break;
    case "thread/realtime/stop":
      answer();
      notice("thread/realtime/closed");
      break;
  }
}
