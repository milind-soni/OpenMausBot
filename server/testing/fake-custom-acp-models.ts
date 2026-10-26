#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

if (process.argv.includes("--version")) {
  console.log("custom-acp-models-fixture 1.0.0");
  process.exit(0);
}

const directory = process.env.FAKE_CUSTOM_ACP_DIRECTORY;
if (!directory) throw new Error("FAKE_CUSTOM_ACP_DIRECTORY is required");
mkdirSync(directory, { recursive: true });
const receiptPath = join(directory, "receipts.jsonl");
type Session = { model: string; variant: string };
const models = [
  { id: "glm-5.3", label: "GLM-5.3", variants: ["low", "max"] },
  { id: "glm-5.3-flash", label: "GLM-5.3-Flash", variants: ["medium", "high"] },
];
const sessions = new Map<string, Session>();
const pathFor = (sessionId: string) => join(directory, `${sessionId}.json`);
const save = (sessionId: string, session: Session) => {
  sessions.set(sessionId, session);
  writeFileSync(pathFor(sessionId), JSON.stringify(session));
};
const get = (sessionId: string) => {
  if (!sessions.has(sessionId) && /^[\w-]+$/.test(sessionId) && existsSync(pathFor(sessionId))) {
    sessions.set(sessionId, JSON.parse(readFileSync(pathFor(sessionId), "utf8")) as Session);
  }
  const session = sessions.get(sessionId);
  if (!session) throw new Error("Unknown fixture session");
  return session;
};
const configOptions = (session: Session) => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: session.model,
    options: models.map((model) => ({ value: model.id, name: model.label })) },
  { id: "thinking", name: "Thinking level", category: "thought_level", type: "select", currentValue: session.variant,
    options: models.find((model) => model.id === session.model)!.variants.map((variant) => ({ value: variant, name: variant === "max" ? "Max" : variant })) },
];
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const receipt = (value: object) => appendFileSync(receiptPath, `${JSON.stringify({ pid: process.pid, ...value })}\n`);
const parent = process.ppid;
const orphanWatch = setInterval(() => {
  if (process.ppid !== parent) process.exit(0);
  try { process.kill(parent, 0); } catch { process.exit(0); }
}, 500);
orphanWatch.unref();

for await (const line of createInterface({ input: process.stdin })) {
  let message: { id?: number | string; method?: string; params?: Record<string, any> };
  try { message = JSON.parse(line); } catch { continue; }
  if (message.id === undefined || !message.method) continue;
  const { id, method } = message;
  const params = message.params ?? {};
  const respond = (result: unknown) => send({ jsonrpc: "2.0", id, result });
  try {
    if (method === "initialize") {
      respond({ protocolVersion: 1, agentInfo: { name: "custom-acp-models-fixture", version: "1.0.0" },
        agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } }, authMethods: [] });
    } else if (method === "session/new") {
      const sessionId = randomUUID();
      const session = { model: models[0].id, variant: "low" };
      save(sessionId, session);
      receipt({ method, sessionId, ...session });
      respond({ sessionId, configOptions: configOptions(session) });
    } else if (method === "session/load") {
      const session = get(params.sessionId);
      receipt({ method, sessionId: params.sessionId, ...session });
      respond({ configOptions: configOptions(session) });
    } else if (method === "session/set_config_option") {
      const session = get(params.sessionId);
      if (params.configId === "model") {
        const chosen = models.find((model) => model.id === params.value);
        if (!chosen) throw new Error(`Unknown fixture model ${params.value}`);
        session.model = chosen.id;
        session.variant = chosen.variants[0];
      } else if (params.configId === "thinking") {
        if (!models.find((model) => model.id === session.model)!.variants.includes(params.value)) {
          throw new Error(`Unsupported fixture thinking level ${params.value}`);
        }
        session.variant = params.value;
      } else throw new Error(`Unknown fixture config ${params.configId}`);
      save(params.sessionId, session);
      receipt({ method, sessionId: params.sessionId, configId: params.configId, value: params.value, ...session });
      respond({ configOptions: configOptions(session) });
    } else if (method === "session/prompt") {
      const session = get(params.sessionId);
      const marker = [...JSON.stringify(params.prompt).matchAll(/ACP_PICKER_[A-Z0-9_]+/g)].at(-1)?.[0] ?? "auxiliary";
      receipt({ method, sessionId: params.sessionId, marker, ...session });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `fixture:${marker}:${session.model}:${session.variant}` } } } });
      respond({ stopReason: "end_turn" });
    } else if (method === "session/close" || method === "authenticate") {
      respond({});
    } else {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unsupported fixture method ${method}` } });
    }
  } catch (error) {
    send({ jsonrpc: "2.0", id, error: { code: -32602, message: String(error) } });
  }
}
