// Scripted provider fixture that exercises the REAL injected agents MCP proxy.
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { waitForExit } from "./cleanup.ts";

type AgentsIntegration = { command: string; args: string[]; env: Record<string, string> };

/** A `script` entry runs on the turn whose own text holds every `match` string, once or, with `repeat`, every time. */
type ScriptEntry = { key: string; match: string[]; repeat?: boolean; [field: string]: unknown };

// Claude reads its MCP config and system prompt once at launch; the harness deletes both after the first turn.
const launchFiles = new Map<string, string>();
const readAtLaunch = (path: string) => {
  if (!launchFiles.has(path)) launchFiles.set(path, readFileSync(path, "utf8"));
  return launchFiles.get(path)!;
};

const REPLAYED_HISTORY_END = "[Now reply to the user's latest message:]";

/** A turn's own text: replayed history and recalled passages can quote other conversations. */
export function ownTurnText(prompt: unknown): string {
  const content = (prompt as any)?.message?.content;
  const text = typeof content === "string" ? content
    : Array.isArray(content) ? content.map((block: any) => typeof block === "string" ? block : block?.text ?? "").join("\n") : "";
  const replayed = text.lastIndexOf(REPLAYED_HISTORY_END);
  return (replayed < 0 ? text : text.slice(replayed + REPLAYED_HISTORY_END.length))
    .replace(/Recalled for this message[\s\S]*?\[end of recalled passages[^\]]*\]/g, "");
}

async function askPermission(server: AgentsIntegration, ask: { tool_name: string; input: Record<string, unknown> }): Promise<{ behavior: string; message?: string }> {
  const child = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume();
  try {
    return await new Promise((resolve, reject) => {
      createInterface({ input: child.stdout }).on("line", line => {
        try {
          const data = JSON.parse(line);
          if (data.id !== 2) return;
          const text = String(data.result?.content?.[0]?.text ?? "");
          try { resolve(JSON.parse(text)); } catch { resolve({ behavior: "unparsed", message: text }); }
        } catch { reject(new Error("Fixture permission MCP returned malformed JSON")); }
      });
      child.on("error", reject);
      child.on("exit", (code, signal) => reject(new Error(`Fixture permission MCP exited before answering: ${signal ?? code}`)));
      const send = (id: number, method: string, params: unknown) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      send(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "claude-code", version: "fixture" } });
      send(2, "tools/call", { name: "approve", arguments: { ...ask, tool_use_id: `toolu_fixture_${process.pid}_${Date.now()}` } });
    });
  } finally {
    child.stdin.destroy();
    await waitForExit(child, { signal: "SIGTERM", graceMs: 500 });
  }
}

async function browserToolCall(server: AgentsIntegration, name: string, args: unknown): Promise<any> {
  const child = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume();
  try {
    return await new Promise((resolve, reject) => {
      createInterface({ input: child.stdout }).on("line", line => {
        try {
          const data = JSON.parse(line);
          if (data.id === 2) resolve(data);
        } catch { reject(new Error("Fixture browser MCP returned malformed JSON")); }
      });
      child.on("error", reject);
      child.on("exit", (code, signal) => reject(new Error(`Fixture browser MCP exited before answering: ${signal ?? code}`)));
      const send = (id: number, method: string, params: unknown) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      send(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "claude-code", version: "fixture" } });
      send(2, "tools/call", { name, arguments: args });
    });
  } finally {
    child.stdin.destroy();
    await waitForExit(child, { signal: "SIGTERM", graceMs: 500 });
  }
}

async function screenCalls(server: AgentsIntegration, count: number): Promise<Array<{ ms: number; state: unknown }>> {
  const calls: Array<{ ms: number; state: unknown }> = [];
  for (let call = 0; call < count; call += 1) {
    const at = Date.now();
    const response = await fetch(server.env.OMB_CONTROL_URL!, { headers: { authorization: `Bearer ${server.env.OMB_CONTROL_TOKEN}` } });
    calls.push({ ms: Date.now() - at, state: response.ok ? await response.json() : { status: response.status } });
  }
  return calls;
}

/** Plan fields: `launch` replaces Claude's argv files; `progress`/`progressAfterGate` stream around the
 * gate; `approve` asks through Claude's permission-prompt tool (`replyIfDenied` otherwise);
 * `screenCalls` calls the mounted computer that many times. */
export async function runRoomHandoffAgent(argv: string[], planPath: string, prompt?: unknown,
  launch?: { integration: AgentsIntegration; system: string; evidence?: Record<string, unknown> },
  progress?: (text: string) => void): Promise<string> {
  const arg = (flag: string) => argv[argv.indexOf(flag) + 1];
  const mounted = launch ? [] : Object.values(JSON.parse(readAtLaunch(arg("--mcp-config"))).mcpServers as Record<string, AgentsIntegration>);
  // With a tool selection every server sits behind the gate, which names its upstream in OMB_GATE_UPSTREAM.
  const agentEnv = (server: AgentsIntegration): Record<string, string> => {
    if (server.env?.OMB_COMMS_TOKEN || server.env?.OMB_BOT_ID) return server.env;
    try { return (JSON.parse(server.env?.OMB_GATE_UPSTREAM ?? "") as AgentsIntegration).env ?? {}; } catch { return {}; }
  };
  const integration = launch?.integration ?? mounted.find(s => agentEnv(s).OMB_COMMS_TOKEN) ?? mounted.find(s => agentEnv(s).OMB_BOT_ID);
  if (!integration) {
    // `${planPath}.gates.json` [{ promptIncludes, gateFile }] holds a delegated reply until its gate exists.
    const gatesPath = `${planPath}.gates.json`;
    const taskText = String((prompt as any)?.message?.content ?? "");
    for (const rule of existsSync(gatesPath) ? JSON.parse(readFileSync(gatesPath, "utf8")) as Array<{ promptIncludes: string; gateFile: string }> : []) {
      if (!taskText.includes(rule.promptIncludes) || existsSync(rule.gateFile)) continue;
      await new Promise<void>(resolve => {
        const timer = setInterval(() => {
          if (!existsSync(rule.gateFile)) return;
          clearInterval(timer);
          resolve();
        }, 10);
      });
    }
    return `Handled without teammate tools: ${taskText}`;
  }
  const agent = agentEnv(integration);
  const botId = agent.OMB_BOT_ID;
  const system = launch?.system ?? readAtLaunch(arg("--append-system-prompt-file"));
  // Claude snapshots the launch-time system prompt; later instructions arrive in the user message.
  const turnContext = `${system}\n${JSON.stringify(prompt)}`;
  const resumed = turnContext.includes("Your downstream room requests have settled.");
  // `byPrompt` [{ promptIncludes, plan }] picks a plan by what the turn was sent; first match wins.
  const botPlan = JSON.parse(readFileSync(planPath, "utf8"))[botId] ?? {};
  const basePlan = (botPlan.byPrompt as Array<{ promptIncludes: string; plan: any }> | undefined)
    ?.find(rule => turnContext.includes(rule.promptIncludes))?.plan ?? botPlan;
  const previous = existsSync(`${planPath}.evidence.jsonl`) ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const turnIndex = previous.filter(p => p.botId === botId).length;
  // `script`: an unscripted turn fails loudly, and one-shot entries win over `repeat` ones.
  const script = botPlan.script as ScriptEntry[] | undefined;
  const own = script ? ownTurnText(prompt) : "";
  const used = new Set(previous.filter(p => p.botId === botId && p.planKey).map(p => p.planKey as string));
  const matches = (entry: ScriptEntry) => entry.match.every(text => own.includes(text));
  const entry = script && (script.find(e => !e.repeat && !used.has(e.key) && matches(e)) ?? script.find(e => e.repeat && matches(e)));
  if (script && !entry) {
    appendFileSync(`${planPath}.evidence.jsonl`, JSON.stringify({ botId, turnIndex, threadId: agent.OMB_THREAD_ID, unplanned: true, resumed, system, prompt }) + "\n");
    throw new Error(`Unplanned fixture turn for ${botId}: ${own.slice(0, 300)}`);
  }
  const plan: any = entry ?? (basePlan.turns ? basePlan.turns[turnIndex] : basePlan);
  if (!plan) throw new Error(`Unexpected extra fixture turn ${turnIndex} for ${botId}`);
  for (const expected of plan.expectSystemIncludes ?? []) if (!system.includes(expected)) throw new Error(`Missing discussion context: ${expected}`);
  for (const expected of plan.expectContextIncludes ?? []) if (!turnContext.includes(expected)) throw new Error(`Missing conversation context: ${expected}`);
  const indexed = Boolean(entry || basePlan.turns);
  const steps = indexed ? plan.steps ?? [] : resumed ? plan.resumeSteps ?? [] : plan.steps ?? [];
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
  const timer = setTimeout(() => fail(new Error("Fixture MCP run timed out")), typeof plan.timeoutMs === "number" ? plan.timeoutMs : 20_000);
  let delayTimer: ReturnType<typeof setTimeout> | undefined;
  let gateTimer: ReturnType<typeof setInterval> | undefined;
  const evidence: unknown[] = [];
  let approval: { behavior: string; message?: string } | undefined;
  let screen: Array<{ ms: number; state: unknown }> | undefined;
  try {
    return await Promise.race([failed, (async () => {
      await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "room-fixture", version: "1" } });
      evidence.push(await call("tools/list"));
      evidence.push(await call("tools/call", { name: "list_room_targets", arguments: {} }));
      for (const step of steps) {
        const browser = step.server === "browser" ? (launch ? undefined : JSON.parse(readAtLaunch(arg("--mcp-config"))).mcpServers?.browser as AgentsIntegration | undefined) : undefined;
        if (step.server === "browser" && !browser) throw new Error("A scripted browser step needs the turn's browser tools");
        const response = browser ? await browserToolCall(browser, step.tool, step.arguments) : await call("tools/call", { name: step.tool ?? "coordinate_bots", arguments: step.arguments });
        evidence.push({ step, response });
        if (Boolean(response.error || response.result?.isError) !== Boolean(step.expectError)) throw new Error(`Unexpected tool outcome: ${JSON.stringify(response)}`);
      }
      // A person's answer, like a test gate, is owned by the parent test's timeout.
      if (plan.gateFile || plan.approve || plan.screenCalls) clearTimeout(timer);
      const mounted = launch ? {} : JSON.parse(readAtLaunch(arg("--mcp-config"))).mcpServers as Record<string, AgentsIntegration>;
      if (plan.approve) {
        if (!mounted.ogb || !argv.includes("--permission-prompt-tool")) throw new Error("A scripted approval needs Claude's permission-prompt tool");
        approval = await askPermission(mounted.ogb, plan.approve);
      }
      if (plan.screenCalls) {
        if (!mounted.computer?.env?.OMB_CONTROL_URL) throw new Error("Scripted screen calls need a mounted computer");
        screen = await screenCalls(mounted.computer, plan.screenCalls);
      }
      if (typeof plan.progress === "string") progress?.(plan.progress);
      // `writeFiles` { name: content }: files the turn writes in its working folder.
      for (const [name, content] of Object.entries((plan.writeFiles ?? {}) as Record<string, string>)) writeFileSync(join(process.cwd(), name), content);
      if (plan.readyFile) writeFileSync(plan.readyFile, "ready");
      if (plan.gateFile && !existsSync(plan.gateFile)) await new Promise<void>(resolve => {
        gateTimer = setInterval(() => {
          if (!existsSync(plan.gateFile)) return;
          clearInterval(gateTimer);
          resolve();
        }, 10);
      });
      if (typeof plan.progressAfterGate === "string") progress?.(plan.progressAfterGate);
      if (plan.delayMs) await new Promise(resolve => { delayTimer = setTimeout(resolve, plan.delayMs); });
      if (plan.fail && !resumed) throw new Error("Scripted addressed agent failure");
      // `failWith`: the turn fails with this engine error, e.g. a signed-out reason.
      if (typeof plan.failWith === "string") throw new Error(plan.failWith);
      if (plan.failResumed && resumed) throw new Error("Scripted failure of a resumed turn");
      if (approval && approval.behavior !== "allow") return plan.replyIfDenied ?? `${plan.reply} (approval ${approval.behavior})`;
      if (entry) return plan.reply ?? `Result from ${botId}`;
      return basePlan.turns ? plan.reply : resumed ? plan.resumeReply ?? `Summary from ${botId}` : plan.reply ?? `Result from ${botId}`;
    })()]);
  } finally {
    closing = true;
    clearTimeout(timer); clearTimeout(delayTimer); clearInterval(gateTimer); lines.close(); child.stdin.destroy();
    await waitForExit(child, { signal: "SIGTERM", graceMs: 500 });
    appendFileSync(`${planPath}.evidence.jsonl`, JSON.stringify({ botId, turnIndex, threadId: agent.OMB_THREAD_ID, pid: process.pid,
      model: argv.includes("--model") ? arg("--model") : undefined,
      permissionMode: argv.includes("--permission-mode") ? arg("--permission-mode") : undefined,
      restricted: argv.includes("--restricted"), permissionPromptTool: argv.includes("--permission-prompt-tool"),
      snapshotMode: argv.includes("--system-prompt-snapshot") ? arg("--system-prompt-snapshot") : undefined,
      resumed, system, prompt, evidence, ...(entry ? { planKey: entry.key } : {}), ...(approval ? { approval } : {}), ...(screen ? { screen } : {}), ...launch?.evidence }) + "\n");
  }
}
