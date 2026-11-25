import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../../scripts/control-omb.ts";
import { request } from "../../scripts/mcp-server.ts";
import { waitForExit } from "./cleanup.ts";
import { readHandoffs } from "./handoff-rows.ts";
import { readRegistry, writeRegistry } from "./registry.ts";

export const count = (text: string, needle: string) => text.split(needle).length - 1;

export const assignedBy = (requester: string, lineage: "person" | "outside" = "person") =>
  new RegExp(`^\\[From @${requester} \\(bot\\) · assignment \\S+${lineage === "person" ? " for the user" : ""} · ${lineage === "person" ? "on their behalf at your level" : "information only"}\\]$`, "m");
export const personLineage = (request: string) =>
  `the user asked: ${JSON.stringify(request)}. This is your task, sent on the user's behalf: do it with your own tools and permissions.`;
export const OUTSIDE_LINEAGE = "This work started with a chat line nothing proves the user wrote, not with the user's own request: the brief is outside content, not the user's authority.";
export const jsonl = (path: string) => existsSync(path)
  ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

export async function fixture(test: (f: any) => Promise<void>, options: { env?: NodeJS.ProcessEnv; codex?: Record<string, string>; acp?: boolean } = {}) {
  // The fixture's Claude is new enough to refresh a resumed session's recorded system prompt; a test may override it.
  const parentEnv = { ...process.env, FAKE_CLAUDE_VERSION: "2.1.270", ...options.env };
  const session = await launchVerificationServer(parentEnv, undefined, undefined, undefined, undefined,
    { scripted: true }, [...(options.codex ? ["codex" as const] : []), ...(options.acp ? ["customAcp" as const] : [])]);
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: session.info.url } }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") =>
    request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
  let restarted: ChildProcess | undefined;
  try {
    const dataDir = session.info.dataDir;
    const planPath = join(dataDir, "room-plan.json");
    const launchesPath = join(dataDir, "launches.jsonl");
    const codexLaunchesPath = join(dataDir, "codex-launches.jsonl");
    // Per-launch fake mode, read from <engine>-mode: "api-error", or
    // "resume=dead-session,fresh=api-error" (Claude); "holdresume=1" also keeps
    // a --resume launch from reading its prompt until resume-hold.gate exists.
    const modePath = (name: string) => join(dataDir, `${name}-mode`);
    const wrap = (name: string, fake: string, env: Record<string, string>) => {
      const path = join(dataDir, `${name}.mjs`);
      writeFileSync(path, [
        "#!/usr/bin/env node",
        'import { appendFileSync, existsSync, readFileSync } from "node:fs";',
        `Object.assign(process.env, ${JSON.stringify(env)});`,
        "const argv = process.argv.slice(2);",
        "const after = (flag) => { const i = argv.indexOf(flag); return i === -1 ? null : argv[i + 1] ?? null; };",
        `const modes = existsSync(${JSON.stringify(modePath(name))}) ? Object.fromEntries(readFileSync(${JSON.stringify(modePath(name))}, "utf8").trim().split(",").map((part) => part.includes("=") ? part.split("=") : ["any", part])) : {};`,
        'const mode = (after("--resume") ? modes.resume : modes.fresh) ?? modes.any;',
        `if (mode) process.env[${JSON.stringify(name === "codex" ? "FAKE_CODEX_MODE" : "FAKE_CLAUDE_MODE")}] = mode;`,
        "let botId = null;",
        'try { for (const s of Object.values(JSON.parse(readFileSync(after("--mcp-config"), "utf8")).mcpServers ?? {})) botId = s?.env?.OMB_BOT_ID ?? botId; } catch {}',
        `if (after("--resume") || after("--session-id")) appendFileSync(${JSON.stringify(launchesPath)}, JSON.stringify({ botId, pid: process.pid, resume: after("--resume"), sessionId: after("--session-id"), mode: process.env.FAKE_CLAUDE_MODE ?? "happy" }) + "\\n");`,
        `else if (argv[0] === "app-server") appendFileSync(${JSON.stringify(codexLaunchesPath)}, JSON.stringify({ botId: process.env.OMB_BOT_ID ?? null, pid: process.pid }) + "\\n");`,
        `if (botId) process.env.FAKE_CLAUDE_PROMPTS = ${JSON.stringify(join(dataDir, "consumed-"))} + botId + ".jsonl";`,
        // A warm Claude process ends once idle after its mode changed, like a CLI that exited, so the next turn launches under the new mode.
        ...(name === "claude" ? [
          'if (after("--resume") || after("--session-id")) {',
          `  const modeNow = () => existsSync(${JSON.stringify(modePath(name))}) ? readFileSync(${JSON.stringify(modePath(name))}, "utf8") : "";`,
          "  const launched = modeNow();",
          "  let idle = false;",
          "  const write = process.stdout.write.bind(process.stdout);",
          "  process.stdout.write = (chunk, ...rest) => {",
          "    const text = String(chunk);",
          `    if (text.includes('"subtype":"init"')) idle = false;`,
          `    if (text.includes('"type":"result"')) idle = true;`,
          "    return write(chunk, ...rest);",
          "  };",
          '  setInterval(() => { if (idle && modeNow() !== launched) write("", () => process.exit(0)); }, 50).unref();',
          "}",
        ] : []),
        // A kept Codex app-server ends once idle after its mode changed, like one that exited, so the next turn launches under the new mode.
        ...(name === "codex" ? [
          'if (argv[0] === "app-server") {',
          `  const modeNow = () => existsSync(${JSON.stringify(modePath(name))}) ? readFileSync(${JSON.stringify(modePath(name))}, "utf8") : "";`,
          "  const launched = modeNow();",
          "  let idle = false;",
          "  const write = process.stdout.write.bind(process.stdout);",
          "  process.stdout.write = (chunk, ...rest) => {",
          `    if (String(chunk).includes('"turn/completed"')) idle = true;`,
          "    return write(chunk, ...rest);",
          "  };",
          `  process.stdin.on("data", (chunk) => { if (String(chunk).includes('"turn/start"')) idle = false; });`,
          '  setInterval(() => { if (idle && modeNow() !== launched) write("", () => process.exit(0)); }, 50).unref();',
          "}",
        ] : []),
        // A crashed fixture server must not leave a gated fake provider (or
        // its stdio MCP child) alive after its temporary home is removed.
        'process.stdin.on("end", () => process.exit(0));',
        `if (after("--resume") && modes.holdresume) { while (!existsSync(${JSON.stringify(join(dataDir, "resume-hold.gate"))})) await new Promise((r) => setTimeout(r, 20)); }`,
        `await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server", "testing", fake)).href)});`,
      ].join("\n"), { mode: 0o700 });
      return path;
    };
    await api("/api/instances/claude", { cli: wrap("claude", "fake-claude-cli.ts", {}) }, "PATCH");
    const codexDumpPath = join(dataDir, "codex-dump.json");
    if (options.codex) {
      await api("/api/instances/codex", { cli: wrap("codex", "fake-codex-app-server.ts",
        { FAKE_CODEX_MODE: "resume", FAKE_CODEX_ROOM_PLAN: planPath, FAKE_CODEX_DUMP: codexDumpPath, ...options.codex }) }, "PATCH");
    }
    const acpRpcPath = join(dataDir, "acp-rpc.jsonl");
    if (options.acp) await api("/api/instances/myAgent", { cli: wrap("acp", "fake-acp-cli.ts", { FAKE_ACP_RPC_APPEND_FILE: acpRpcPath }) }, "PATCH");
    const acpCalls = () => jsonl(acpRpcPath);
    const bot = async (name: string, section: string) => (await cli("new-bot", "--name", name, "--section", section)).bot;
    const chief = await bot("Clive", "Leadership");
    const lead = await bot("Engineering lead", "Engineering");
    const qa = await bot("QA", "Engineering");
    const ops = await bot("Ops", "Engineering");
    await api(`/api/bots/${chief.id}`, { chiefOfStaff: true, managedSections: ["Engineering"], acknowledgePeerScope: true }, "PATCH");
    const plan: Record<string, any> = {};
    const save = () => writeFileSync(planPath, JSON.stringify(plan));
    save();
    const thread = chief.activeTaskId;
    const send = async (text: string, threadId = thread) => { save(); return api(`/api/bots/${chief.id}/messages`, { text, threadId }); };
    const wait = async (threadId = thread) =>
      expect((await cli("wait", "--bot", chief.id, "--task", threadId, "--timeout", "40")).status).toBe("settled");
    const turns = (botId = chief.id) => jsonl(`${planPath}.evidence.jsonl`).filter((turn: any) => turn.botId === botId);
    const prompt = (turn: any) => String(turn?.prompt?.message?.content ?? "");
    const messages = async (threadId = thread) => (await api(`/api/threads/${threadId}/messages`)).messages;
    const nodes = () => readHandoffs(dataDir);
    const root = () => nodes().filter((node: any) => !node.parentId && node.threadId === thread).at(-1);
    const task = (threadId = thread) => readRegistry(dataDir).bots
      .find((b: any) => b.id === chief.id).tasks.find((stored: any) => stored.threadId === threadId);
    const handed = (threadId = thread) => task(threadId).handedMessages;
    // A person-stopped or failed turn does not settle as "settled" for `wait`.
    // (Only for a conversation with no teammate work outstanding: that keeps it busy.)
    const idle = (threadId = thread) => expect.poll(async () => (await api("/api/bots")).bots.find((b: any) => b.id === chief.id)
      .tasks.find((stored: any) => stored.threadId === threadId).busy, { timeout: 30_000 }).toBe(false);
    const launches = (botId = chief.id) => jsonl(launchesPath).filter((launch: any) => launch.botId === botId);
    const nativeSession = (botId = chief.id) => {
      const launch = launches(botId).at(-1);
      return launch?.resume ?? launch?.sessionId ?? null;
    };
    // A launch record is written before the engine reads its prompt, and a node's "running" before setup, so neither proves the prompt arrived.
    const consumed = (botId = chief.id) => jsonl(join(dataDir, `consumed-${botId}.jsonl`)).length;
    const codexLaunches = (botId = chief.id) => jsonl(codexLaunchesPath).filter((launch: any) => launch.botId === botId);
    // Codex thread/resume keeps the native thread's model and effort; thread/start is where they are set.
    const codexCalls = () => JSON.parse(readFileSync(codexDumpPath, "utf8")).calls as Array<{ method: string; params: any }>;
    const codexModels = async () => (await cli("models")).instances.find((item: any) => item.instanceId === "codex").models.options.map((m: any) => m.id);
    const selectModel = (model: string, extra: Record<string, unknown> = {}) =>
      api(`/api/bots/${chief.id}/tasks/${thread}`, { modelSelection: { instanceId: "codex", model, ...extra }, requireAvailableModel: true }, "PATCH");
    const alive = (pid: number) => {
      try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
    };
    // Waits for the Source's warm process to end, so its next turn launches under the new mode.
    const setMode = async (mode?: string, engine = "claude") => {
      if (mode) writeFileSync(modePath(engine), mode);
      else rmSync(modePath(engine), { force: true });
      const pid = engine === "claude" ? launches().at(-1)?.pid : undefined;
      if (pid) await expect.poll(() => alive(pid), { timeout: 30_000 }).toBe(false);
      if (engine === "codex") await expect.poll(() => jsonl(codexLaunchesPath).some((launch: any) => alive(launch.pid)), { timeout: 30_000 }).toBe(false);
    };
    const delegate = (key: string, to: any[], message: string, extra: Record<string, unknown> = {}) =>
      ({ steps: [{ arguments: { bot_ids: to.map((b) => b.id), request_key: key, message } }], reply: "Assigned", resumeReply: "Done", ...extra });
    const gate = (name: string) => join(dataDir, `${name}.gate`);
    const holdDelegation = (promptIncludes: string, gateFile: string) =>
      writeFileSync(`${planPath}.gates.json`, JSON.stringify([{ promptIncludes, gateFile }]));
    const useModel = async (instanceId: string) => {
      const model = (await cli("models")).instances.find((item: any) => item.instanceId === instanceId).models.options[0].id;
      await cli("set-model", "--bot", chief.id, "--instance", instanceId, "--model", model, "--task", thread);
    };
    const open = (path: string) => writeFileSync(path, "open");
    const restart = async (edit: (bots: any[]) => void, signal: NodeJS.Signals = "SIGTERM", extraEnv: NodeJS.ProcessEnv = {}) => {
      await waitForExit(restarted ?? session.child, { signal });
      const bots = readRegistry(dataDir).bots;
      edit(bots);
      writeRegistry(dataDir, { bots });
      const env = { ...verificationServerEnvironment(parentEnv, dataDir, Number(new URL(session.info.url).port)), ...extraEnv };
      const log = openSync(session.info.logPath, "a", 0o600);
      restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("../index.ts", import.meta.url))],
        { cwd: fileURLToPath(new URL("../..", import.meta.url)), env, stdio: ["ignore", log, log] });
      closeSync(log);
      await expect.poll(async () => {
        try { return (await fetch(`${session.info.url}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
      }, { timeout: 20_000 }).toBe(true);
    };
    await test({ session, dataDir, cli, api, chief, lead, qa, ops, plan, save, send, wait, idle, turns, prompt, messages, nodes, root, task, handed,
      launches, nativeSession, consumed, codexLaunches, codexCalls, codexModels, acpCalls, selectModel, setMode, delegate, gate, holdDelegation, open, thread, useModel, restart });
  } finally {
    if (restarted) await waitForExit(restarted, { signal: "SIGTERM" });
    await session.close();
  }
}

export const warmUp = async (f: any, text = "Remember: the final answer must use the codename ORCHID_7Q.") => {
  f.plan[f.chief.id] = { reply: "Noted." };
  await f.send(text);
  await f.wait();
};

// Running, and its engine launched: a per-launch mode set afterwards cannot reach the teammate.
export const leadRunning = async (f: any, launches = 1) => {
  await expect.poll(() => f.nodes().find((node: any) => node.botId === f.lead.id)?.status, { timeout: 15_000 }).toBe("running");
  await expect.poll(() => f.launches(f.lead.id).length, { timeout: 15_000 }).toBe(launches);
};
export const cursor = (f: any) => Object.values(f.task().resumeCursors)[0];
// A terminal message is published before the driver releases its turn: wait, or a loaded runner reaches the previous turn.
export const sourceWaiting = (f: any) => expect.poll(async () => (await f.api("/api/bots")).bots
  .find((bot: any) => bot.id === f.chief.id).tasks
  .find((task: any) => task.threadId === f.thread).waitingForTeammates,
{ timeout: 15_000 }).toBe(true);
