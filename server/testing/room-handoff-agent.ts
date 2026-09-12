// Scripted provider fixture that exercises the REAL injected agents MCP proxy.
// The plan and evidence are confined to the isolated launcher's temporary home.
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";

export async function runRoomHandoffAgent(argv: string[], planPath: string, prompt?: unknown): Promise<string> {
  const arg = (flag: string) => argv[argv.indexOf(flag) + 1];
  const config = JSON.parse(readFileSync(arg("--mcp-config"), "utf8"));
  const integration = Object.values(config.mcpServers as Record<string, { command: string; args: string[]; env: Record<string, string> }>)
    .find(s => s.env?.OMB_BOT_ID);
  if (!integration) throw new Error("The room agent did not receive its agents integration");
  const botId = integration.env.OMB_BOT_ID;
  const system = readFileSync(arg("--append-system-prompt-file"), "utf8");
  const resumed = system.includes("Your downstream room requests have settled.");
  const basePlan = JSON.parse(readFileSync(planPath, "utf8"))[botId] ?? {};
  const previous = existsSync(`${planPath}.evidence.jsonl`) ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const turnIndex = previous.filter(p => p.botId === botId).length;
  const plan = basePlan.turns ? basePlan.turns[turnIndex] : basePlan;
  if (!plan) throw new Error(`Unexpected extra fixture turn ${turnIndex} for ${botId}`);
  for (const expected of plan.expectSystemIncludes ?? []) if (!system.includes(expected)) throw new Error(`Missing discussion context: ${expected}`);
  for (const expected of plan.expectContextIncludes ?? []) if (!`${system}\n${JSON.stringify(prompt)}`.includes(expected)) throw new Error(`Missing conversation context: ${expected}`);
  const steps = basePlan.turns ? plan.steps ?? [] : resumed ? plan.resumeSteps ?? [] : plan.steps ?? [];
  const child = spawn(integration.command, integration.args, { env: { ...process.env, ...integration.env }, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let serial = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    const data = JSON.parse(line);
    const waiter = pending.get(data.id);
    if (waiter) { pending.delete(data.id); waiter.resolve(data); }
  });
  child.on("error", error => { for (const p of pending.values()) p.reject(error); pending.clear(); });
  const call = (method: string, params: unknown = {}) => new Promise<any>((resolve, reject) => {
    const id = ++serial; pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const timer = setTimeout(() => {
    for (const p of pending.values()) p.reject(new Error("Fixture MCP call timed out"));
    child.kill();
  }, 20_000);
  const evidence: unknown[] = [];
  try {
    await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "room-fixture", version: "1" } });
    evidence.push(await call("tools/list"));
    evidence.push(await call("tools/call", { name: "list_room_targets", arguments: {} }));
    for (const step of steps) {
      const response = await call("tools/call", { name: step.tool ?? "send_room_message", arguments: step.arguments });
      evidence.push({ step, response });
      if (Boolean(response.error || response.result?.isError) !== Boolean(step.expectError)) throw new Error(`Unexpected tool outcome: ${JSON.stringify(response)}`);
    }
    if (plan.delayMs) await new Promise(resolve => setTimeout(resolve, plan.delayMs));
    if (plan.fail && !resumed) throw new Error("Scripted addressed agent failure");
    return basePlan.turns ? plan.reply : resumed ? plan.resumeReply ?? `Summary from ${botId}` : plan.reply ?? `Result from ${botId}`;
  } finally {
    appendFileSync(`${planPath}.evidence.jsonl`, JSON.stringify({ botId, turnIndex, threadId: integration.env.OMB_THREAD_ID, resumed, system, prompt, evidence }) + "\n");
    clearTimeout(timer); lines.close(); child.stdin.end();
    await new Promise<void>(resolve => { if (child.exitCode !== null) resolve(); else { child.once("exit", () => resolve()); child.kill(); } });
  }
}
