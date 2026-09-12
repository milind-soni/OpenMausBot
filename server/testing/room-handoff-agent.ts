// Scripted provider fixture that exercises the REAL injected agents MCP proxy.
// The plan and evidence are confined to the isolated launcher's temporary home.
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { waitForExit } from "./cleanup.ts";

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
  let closing = false;
  let failure: Error | undefined;
  let rejectRun!: (error: Error) => void;
  const failed = new Promise<never>((_resolve, reject) => { rejectRun = reject; });
  const fail = (error: Error) => {
    if (closing || failure) return;
    failure = error;
    for (const p of pending.values()) p.reject(error);
    pending.clear();
    rejectRun(error);
  };
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    try {
      const data = JSON.parse(line);
      const waiter = pending.get(data.id);
      if (waiter) { pending.delete(data.id); waiter.resolve(data); }
    } catch { fail(new Error("Fixture MCP returned malformed JSON")); }
  });
  child.on("error", fail);
  child.on("exit", (code, signal) => fail(new Error(`Fixture MCP exited unexpectedly: ${signal ?? code}`)));
  child.stdin.on("error", fail);
  child.stderr.resume();
  const call = (method: string, params: unknown = {}) => new Promise<any>((resolve, reject) => {
    if (failure) { reject(failure); return; }
    const id = ++serial; pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const timer = setTimeout(() => fail(new Error("Fixture MCP run timed out")), 20_000);
  let delayTimer: ReturnType<typeof setTimeout> | undefined;
  const evidence: unknown[] = [];
  try {
    return await Promise.race([failed, (async () => {
      await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "room-fixture", version: "1" } });
      evidence.push(await call("tools/list"));
      evidence.push(await call("tools/call", { name: "list_room_targets", arguments: {} }));
      for (const step of steps) {
        const response = await call("tools/call", { name: step.tool ?? "coordinate_bots", arguments: step.arguments });
        evidence.push({ step, response });
        if (Boolean(response.error || response.result?.isError) !== Boolean(step.expectError)) throw new Error(`Unexpected tool outcome: ${JSON.stringify(response)}`);
      }
      if (plan.delayMs) await new Promise(resolve => { delayTimer = setTimeout(resolve, plan.delayMs); });
      if (plan.fail && !resumed) throw new Error("Scripted addressed agent failure");
      return basePlan.turns ? plan.reply : resumed ? plan.resumeReply ?? `Summary from ${botId}` : plan.reply ?? `Result from ${botId}`;
    })()]);
  } finally {
    closing = true;
    clearTimeout(timer); clearTimeout(delayTimer); lines.close(); child.stdin.destroy();
    await waitForExit(child, { signal: "SIGTERM", graceMs: 500 });
    appendFileSync(`${planPath}.evidence.jsonl`, JSON.stringify({ botId, turnIndex, threadId: integration.env.OMB_THREAD_ID, resumed, system, prompt, evidence }) + "\n");
  }
}
