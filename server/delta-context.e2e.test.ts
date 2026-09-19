// Resumed sessions and teammate results, end to end through the isolated
// launcher and the repository's fake engines: what each provider turn
// actually received, counted by unique sentinels.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";
import { waitForExit } from "./testing/cleanup.ts";

const count = (text: string, needle: string) => text.split(needle).length - 1;
const jsonl = (path: string) => existsSync(path)
  ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

async function fixture(test: (f: any) => Promise<void>, options: { env?: NodeJS.ProcessEnv; codex?: Record<string, string> } = {}) {
  // The fixture's Claude is a CLI new enough to refresh a resumed session's
  // recorded system prompt; a test that wants an older one overrides it.
  const parentEnv = { ...process.env, FAKE_CLAUDE_VERSION: "2.1.270", ...options.env };
  const session = await launchVerificationServer(parentEnv, undefined, undefined, undefined, undefined,
    { scripted: true }, options.codex ? ["codex"] : []);
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
    // Wrap a fake engine to record each launch's resume argument and owner.
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
        `if (after("--resume") || after("--session-id")) appendFileSync(${JSON.stringify(launchesPath)}, JSON.stringify({ botId, resume: after("--resume"), sessionId: after("--session-id"), mode: process.env.FAKE_CLAUDE_MODE ?? "happy" }) + "\\n");`,
        `else if (argv[0] === "app-server") appendFileSync(${JSON.stringify(codexLaunchesPath)}, JSON.stringify({ botId: process.env.OMB_BOT_ID ?? null }) + "\\n");`,
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
    const nodes = () => jsonl(join(dataDir, "room-handoffs.json")).flat();
    const task = (threadId = thread) => JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8"))
      .find((b: any) => b.id === chief.id).tasks.find((stored: any) => stored.threadId === threadId);
    const handed = (threadId = thread) => task(threadId).handedMessages;
    // A person-stopped or failed turn does not settle as "settled" for `wait`.
    // (Only for a conversation with no teammate work outstanding: that keeps it busy.)
    const idle = (threadId = thread) => expect.poll(async () => (await api("/api/bots")).bots.find((b: any) => b.id === chief.id)
      .tasks.find((stored: any) => stored.threadId === threadId).busy, { timeout: 30_000 }).toBe(false);
    const launches = (botId = chief.id) => jsonl(launchesPath).filter((launch: any) => launch.botId === botId);
    const codexLaunches = (botId = chief.id) => jsonl(codexLaunchesPath).filter((launch: any) => launch.botId === botId);
    // The app-server calls of the last Codex launch: thread/resume keeps the
    // native thread's model and effort, thread/start is where they are set.
    const codexCalls = () => JSON.parse(readFileSync(codexDumpPath, "utf8")).calls as Array<{ method: string; params: any }>;
    const codexModels = async () => (await cli("models")).instances.find((item: any) => item.instanceId === "codex").models.options.map((m: any) => m.id);
    const selectModel = (model: string, extra: Record<string, unknown> = {}) =>
      api(`/api/bots/${chief.id}/tasks/${thread}`, { modelSelection: { instanceId: "codex", model, ...extra }, requireAvailableModel: true }, "PATCH");
    const setMode = (mode?: string, engine = "claude") => mode ? writeFileSync(modePath(engine), mode) : rmSync(modePath(engine), { force: true });
    const delegate = (key: string, to: any[], message: string, extra: Record<string, unknown> = {}) =>
      ({ steps: [{ arguments: { bot_ids: to.map((b) => b.id), request_key: key, message } }], reply: "Assigned", resumeReply: "Done", ...extra });
    const gate = (name: string) => join(dataDir, `${name}.gate`);
    const useModel = async (instanceId: string) => {
      const model = (await cli("models")).instances.find((item: any) => item.instanceId === instanceId).models.options[0].id;
      await cli("set-model", "--bot", chief.id, "--instance", instanceId, "--model", model, "--task", thread);
    };
    const open = (path: string) => writeFileSync(path, "open");
    // Stop this fixture's own server, let the test edit its stored records,
    // and start it again on the same data.
    const restart = async (edit: (bots: any[]) => void, signal: NodeJS.Signals = "SIGTERM", extraEnv: NodeJS.ProcessEnv = {}) => {
      await waitForExit(restarted ?? session.child, { signal });
      const bots = JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8"));
      edit(bots);
      writeFileSync(join(dataDir, "bots.json"), JSON.stringify(bots, null, 2));
      const env = { ...verificationServerEnvironment(parentEnv, dataDir, Number(new URL(session.info.url).port)), ...extraEnv };
      const log = openSync(session.info.logPath, "a", 0o600);
      restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))],
        { cwd: fileURLToPath(new URL("..", import.meta.url)), env, stdio: ["ignore", log, log] });
      closeSync(log);
      await expect.poll(async () => {
        try { return (await fetch(`${session.info.url}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
      }, { timeout: 20_000 }).toBe(true);
    };
    await test({ session, dataDir, cli, api, chief, lead, qa, ops, plan, save, send, wait, idle, turns, prompt, messages, nodes, task, handed,
      launches, codexLaunches, codexCalls, codexModels, selectModel, setMode, delegate, gate, open, thread, useModel, restart });
  } finally {
    if (restarted) await waitForExit(restarted, { signal: "SIGTERM" });
    await session.close();
  }
}

const warmUp = async (f: any, text = "Remember: the final answer must use the codename ORCHID_7Q.") => {
  f.plan[f.chief.id] = { reply: "Noted." };
  await f.send(text);
  await f.wait();
};

it("resumes the source session and gives it each of three results exactly once, with a long brief", () => fixture(async (f) => {
  await warmUp(f);
  for (const [bot, tag] of [[f.lead, "LEAD"], [f.qa, "QA"], [f.ops, "OPS"]] as const) {
    f.plan[bot.id] = { reply: `RESULT_${tag}_START ${"r".repeat(1_200)} RESULT_${tag}_END` };
  }
  f.plan[f.chief.id] = f.delegate("fanout", [f.lead, f.qa, f.ops], `BRIEF_START ${"b".repeat(1_500)} BRIEF_END`);
  await f.send("Have Engineering, QA and Ops each check the release.");
  await f.wait();

  const returned = f.turns().at(-1);
  const text = f.prompt(returned);
  expect(returned.resumed).toBe(true);
  const launches = f.launches();
  expect(launches.at(-1).resume).toBe(launches[0].sessionId);
  for (const tag of ["LEAD", "QA", "OPS"]) {
    expect(count(text, `RESULT_${tag}_START`)).toBe(1);
    expect(count(text, `RESULT_${tag}_END`)).toBe(1);
  }
  // The session already holds the earlier chat.
  expect(text).not.toContain("ORCHID_7Q");
  expect(text).not.toMatch(/^Assistant: @/m);
}), 60_000);

it("gives the return turn a result that landed while a newer message was running, exactly once", () => fixture(async (f) => {
  await warmUp(f);
  f.plan[f.lead.id] = { reply: "LEAD_RESULT_TOKEN", gateFile: f.gate("lead") };
  f.plan[f.chief.id] = { turns: [{}, f.delegate("build", [f.lead], "Build the export"), { reply: "4", gateFile: f.gate("steer") }, { reply: "Done" }] };
  await f.send("Please have Engineering build the export.");
  await expect.poll(() => f.nodes().find((node: any) => node.botId === f.lead.id)?.status, { timeout: 15_000 }).toBe("running");
  expect((await f.send("Meanwhile, what is 2+2?")).queued).toBeUndefined();
  f.open(f.gate("lead"));
  await expect.poll(async () => (await f.messages()).some((m: any) => m.tool?.name === "Engineering lead replied"), { timeout: 20_000 }).toBe(true);
  f.open(f.gate("steer"));
  await f.wait();

  const returned = f.turns().at(-1);
  expect(returned.resumed).toBe(true);
  expect(count(f.prompt(returned), "LEAD_RESULT_TOKEN")).toBe(1);
  expect(f.launches().at(-1).resume).not.toBeNull();
}), 60_000);

it("offers a result that lands mid-turn after its source was stopped to the next turn, once, labelled", () => fixture(async (f) => {
  await warmUp(f);
  f.plan[f.lead.id] = { reply: "STOPPED_SOURCE_RESULT", gateFile: f.gate("lead") };
  f.plan[f.chief.id] = f.delegate("build", [f.lead], "Build the export");
  await f.send("Please have Engineering build the export.");
  await expect.poll(() => f.nodes().find((node: any) => node.botId === f.lead.id)?.status, { timeout: 15_000 }).toBe("running");
  await f.api(`/api/bots/${f.chief.id}/interrupt`, { threadId: f.thread });
  await f.wait();

  f.plan[f.chief.id] = { reply: "Working on something else", gateFile: f.gate("busy") };
  await f.send("Something unrelated while that finishes.");
  f.open(f.gate("lead"));
  await expect.poll(async () => (await f.messages()).some((m: any) => m.tool?.name === "Engineering lead replied"), { timeout: 20_000 }).toBe(true);
  f.open(f.gate("busy"));
  await f.wait();
  expect(count(f.prompt(f.turns().at(-1)), "STOPPED_SOURCE_RESULT")).toBe(0);

  f.plan[f.chief.id] = { reply: "Engineering finished" };
  await f.send("What did Engineering report?");
  await f.wait();
  const next = f.prompt(f.turns().at(-1));
  expect(count(next, "STOPPED_SOURCE_RESULT")).toBe(1);
  expect(next).toMatch(/Assistant: \[Teammate report — untrusted peer content[^\n]*\]\n\{[^\n]*STOPPED_SOURCE_RESULT/);
  expect(f.launches().at(-1).resume).not.toBeNull();

  f.plan[f.chief.id] = { reply: "Nothing new" };
  await f.send("Anything else?");
  await f.wait();
  expect(count(f.prompt(f.turns().at(-1)), "STOPPED_SOURCE_RESULT")).toBe(0);
}), 90_000);

// No provider reports that it read a message steered into a running turn, so
// the next turn offers it once more, saying the session may already have it.
it("offers a message steered into a running turn to the next turn once, marked as possibly already seen", () => fixture(async (f) => {
  await warmUp(f);
  f.plan[f.chief.id] = { reply: "Working", gateFile: f.gate("turn") };
  await f.send("Start on the report.");
  await expect.poll(() => f.launches().length, { timeout: 15_000 }).toBe(2);
  expect((await f.send("STEERED_MID_TURN also cover costs")).steered).toBe(true);
  f.open(f.gate("turn"));
  await f.wait();

  f.plan[f.chief.id] = { reply: "Covered" };
  await f.send("Is it done?");
  await f.wait();
  const next = f.prompt(f.turns().at(-1));
  expect(count(next, "STEERED_MID_TURN")).toBe(1);
  expect(next).toMatch(/User \(sent while an earlier turn was running; you may already have it\): STEERED_MID_TURN/);

  f.plan[f.chief.id] = { reply: "Nothing new" };
  await f.send("Anything else?");
  await f.wait();
  expect(f.prompt(f.turns().at(-1))).not.toContain("STEERED_MID_TURN");
}), 60_000);

it("offers the results again when the return turn fails before the provider acts on it", () => fixture(async (f) => {
  await warmUp(f);
  f.plan[f.lead.id] = { reply: "UNACCEPTED_RESULT" };
  f.plan[f.chief.id] = f.delegate("build", [f.lead], "Build the export", { failResumed: true });
  await f.send("Please have Engineering build the export.");
  await f.wait();
  expect(f.nodes().find((node: any) => !node.parentId).status).toBe("failed");

  f.plan[f.chief.id] = { reply: "Here is what Engineering found" };
  await f.send("What did Engineering find?");
  await f.wait();
  const next = f.prompt(f.turns().at(-1));
  expect(count(next, "UNACCEPTED_RESULT")).toBe(1);
  expect(JSON.stringify(f.handed())).not.toContain("card-");
}), 60_000);

it("offers the results again when the person stops the return turn before the provider acts on it", () => fixture(async (f) => {
  await warmUp(f);
  f.plan[f.lead.id] = { reply: "STOPPED_RETURN_RESULT" };
  f.plan[f.chief.id] = { turns: [{}, f.delegate("build", [f.lead], "Build the export"), { reply: "never sent", gateFile: f.gate("return") }, { reply: "Recovered" }] };
  await f.send("Please have Engineering build the export.");
  await expect.poll(() => f.nodes().find((node: any) => node.botId === f.lead.id)?.status, { timeout: 20_000 }).toBe("completed");
  await expect.poll(() => f.nodes().find((node: any) => !node.parentId)?.status, { timeout: 20_000 }).toBe("running");
  await f.api(`/api/bots/${f.chief.id}/interrupt`, { threadId: f.thread });
  await f.wait();
  f.open(f.gate("return"));

  await f.send("What did Engineering find?");
  await f.wait();
  expect(count(f.prompt(f.turns().at(-1)), "STOPPED_RETURN_RESULT")).toBe(1);
}), 60_000);

it("rebuilds a rejected resume with each result exactly once", () => fixture(async (f) => {
  await warmUp(f);
  f.plan[f.lead.id] = { reply: `RECOVERY_RESULT_START ${"r".repeat(900)} RECOVERY_RESULT_END` };
  f.plan[f.chief.id] = f.delegate("build", [f.lead], "Build the export");
  await f.send("Please have Engineering build the export.");
  await f.wait();
  const recovered = f.prompt(f.turns().at(-1));
  // A return turn would have replayed today: its rebuild is that same replay.
  expect(recovered).toContain("received an update outside your provider session");
  expect(recovered).toContain("ORCHID_7Q");
  expect(count(recovered, "RECOVERY_RESULT_START")).toBe(1);
  expect(count(recovered, "RECOVERY_RESULT_END")).toBe(1);
}, { env: { FAKE_CLAUDE_MODE: "dead-session" } }), 60_000);

it("keeps provenance and exactly-once delivery across rework rounds to the same teammate", () => fixture(async (f) => {
  await warmUp(f);
  f.plan[f.lead.id] = { turns: [{ reply: "ROUND_ONE_RESULT" }, { reply: "ROUND_TWO_RESULT" }] };
  f.plan[f.chief.id] = { turns: [
    {},
    f.delegate("r1", [f.lead], "REQUEST_ONE please build it"),
    { steps: [{ arguments: { bot_ids: [f.lead.id], request_key: "r2", message: "REQUEST_TWO please also test it", rework: true } }], reply: "" },
    { reply: "" },
  ] };
  await f.send("Please have Engineering build and then test it.");
  await f.wait();

  const [, , roundOne, roundTwo] = f.turns();
  expect(count(f.prompt(roundOne), "ROUND_ONE_RESULT")).toBe(1);
  expect(count(f.prompt(roundTwo), "ROUND_TWO_RESULT")).toBe(1);
  // the brief lists every round's result in full, once
  expect(count(f.prompt(roundTwo), "ROUND_ONE_RESULT")).toBe(1);
  expect(f.launches().at(-1).resume).not.toBeNull();

  const second = f.prompt(f.turns(f.lead.id)[1]);
  expect(count(second, "REQUEST_TWO")).toBe(1);
  expect(second).not.toMatch(/^Assistant: @/m);
  expect(second).toContain("untrusted peer content");

  // Only stored message ids are recorded, never a continuation's synthetic id.
  const handed = f.handed();
  const stored = new Set((await f.messages()).map((m: any) => m.id));
  for (const state of Object.values(handed) as any[]) {
    for (const id of [state.through, ...state.ids].filter(Boolean)) expect(stored.has(id), id).toBe(true);
  }
}), 90_000);

it("replays a delegated result once after a rewind, and keeps resuming afterwards", () => fixture(async (f) => {
  await warmUp(f);
  f.plan[f.lead.id] = { reply: "REWIND_RESULT" };
  f.plan[f.chief.id] = f.delegate("build", [f.lead], "Build the export");
  await f.send("Please have Engineering build the export.");
  await f.wait();
  f.plan[f.chief.id] = { reply: "Anything else?" };
  await f.send("Thanks.");
  await f.wait();

  const followup = (await f.messages()).findLast((m: any) => m.role === "user");
  f.plan[f.chief.id] = { reply: "Rebuilt" };
  f.save();
  await f.cli("edit", "--bot", f.chief.id, "--message", followup.id, "--task", f.thread, "--text", "Thanks, one more thing (edited).");
  await f.wait();
  const rewound = f.prompt(f.turns().at(-1));
  expect(rewound).toContain("rewound this conversation");
  expect(count(rewound, "REWIND_RESULT")).toBe(1);
  expect(f.launches().at(-1).resume).toBeNull();

  f.plan[f.chief.id] = { reply: "Still here" };
  await f.send("And now?");
  await f.wait();
  expect(count(f.prompt(f.turns().at(-1)), "REWIND_RESULT")).toBe(0);
  expect(f.launches().at(-1).resume).not.toBeNull();
}), 90_000);

it("wakes a busy delegate_bot source with the reply that landed during its turn, once and labelled", () => fixture(async (f) => {
  f.plan[f.chief.id] = { turns: [
    { steps: [
      { tool: "delegate_bot", arguments: { bot_id: f.qa.id, message: "Check the quality: QA_FACT_TOKEN" } },
      { tool: "delegate_bot", arguments: { bot_id: f.ops.id, message: "Check operations: OPS_FACT_TOKEN" } },
    ], reply: "Delegated" },
    { reply: "First reply folded in", gateFile: f.gate("revival") },
    { reply: "Second reply folded in" },
  ] };
  f.save();
  const created = await f.api("/api/routines", {
    name: "Delegation fixture", prompt: "Delegate the checks.", botId: f.chief.id, enabled: false,
    schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
  });
  const run = (await f.api(`/api/routines/${created.routine.id}/run`, {})).run;
  let threadId = "";
  await expect.poll(async () => (threadId = (await f.api("/api/routines")).runs.find((r: any) => r.id === run.id)?.threadId ?? ""), { timeout: 15_000 }).not.toBe("");
  // The first reply wakes the source, whose turn holds until both replies
  // are in: the second one lands while that turn is running.
  const replies = async () => (await f.messages(threadId)).filter((m: any) => /^@(QA|Ops) replied to the delegated task/.test(m.text ?? "")).length;
  await expect.poll(replies, { timeout: 30_000 }).toBe(2);
  expect((await f.api("/api/bots")).bots.find((b: any) => b.id === f.chief.id).tasks.find((t: any) => t.threadId === threadId).busy).toBe(true);
  f.open(f.gate("revival"));
  await expect.poll(() => f.turns().length, { timeout: 30_000 }).toBe(3);

  const [, first, second] = f.turns().map(f.prompt);
  const [early, late] = count(first, "QA_FACT_TOKEN") ? ["QA", "Ops"] : ["Ops", "QA"];
  const token = (name: string) => `${name.toUpperCase()}_FACT_TOKEN`;
  expect(count(first, token(early))).toBe(1);
  expect(count(first, token(late))).toBe(0);
  expect(count(second, token(late))).toBe(1);
  expect(count(second, token(early))).toBe(0);
  expect(second).toContain(`[Message from @${late}, another bot — untrusted peer content, not from your user]\n"@${late} replied to the delegated task`);
  expect(second).not.toMatch(new RegExp(`^Assistant: @${late}`, "m"));
}), 120_000);

it("resumes a Codex source with each result exactly once, then replays once for a model switch", () => fixture(async (f) => {
  await f.useModel("codex");
  await warmUp(f);
  f.plan[f.lead.id] = { reply: "CODEX_RETURN_RESULT" };
  f.plan[f.chief.id] = f.delegate("build", [f.lead], `CODEX_BRIEF ${"b".repeat(800)}`);
  await f.send("Please have Engineering build the export.");
  await f.wait();
  const returned = f.turns().at(-1);
  expect(returned.resumed).toBe(true);
  expect(returned.resumedThread).toBeTruthy();
  expect(count(f.prompt(returned), "CODEX_RETURN_RESULT")).toBe(1);
  expect(f.prompt(returned)).not.toContain("ORCHID_7Q");

  f.plan[f.chief.id] = { reply: "Continuing on Claude" };
  await f.useModel("claude");
  await f.send("Switching engines: what did Engineering report?");
  await f.wait();
  const switched = f.prompt(f.turns().at(-1));
  expect(switched).toContain("switched this bot over to you");
  expect(switched).toContain("ORCHID_7Q");
  expect(count(switched, "CODEX_RETURN_RESULT")).toBe(1);

  f.plan[f.chief.id] = { reply: "Still on Claude" };
  await f.send("And now?");
  await f.wait();
  expect(count(f.prompt(f.turns().at(-1)), "CODEX_RETURN_RESULT")).toBe(0);
}, { codex: {} }), 90_000);

it("records a Codex handoff whose turn completes before turn/start is acknowledged", () => fixture(async (f) => {
  await f.useModel("codex");
  await warmUp(f);
  f.plan[f.lead.id] = { reply: "EARLY_ACK_RESULT" };
  f.plan[f.chief.id] = f.delegate("build", [f.lead], "Build the export");
  await f.send("Please have Engineering build the export.");
  await f.wait();
  expect(count(f.prompt(f.turns().at(-1)), "EARLY_ACK_RESULT")).toBe(1);

  f.plan[f.chief.id] = { reply: "Nothing new" };
  await f.send("Anything else?");
  await f.wait();
  const next = f.turns().at(-1);
  expect(next.resumedThread).toBeTruthy();
  expect(count(f.prompt(next), "EARLY_ACK_RESULT")).toBe(0);
  expect(f.prompt(next)).not.toContain("Messages this conversation received");
}, { codex: { FAKE_CODEX_COMPLETE_BEFORE_ACK: "1" } }), 90_000);

// A result that arrives after a restart, for a stored conversation with or
// without a record of what its session received.
const resultAcrossRestart = async (f: any, stripRecord: boolean) => {
  await warmUp(f);
  f.plan[f.lead.id] = { reply: "never finishes", gateFile: f.gate("never") };
  f.plan[f.chief.id] = f.delegate("build", [f.lead], "Build the export");
  await f.send("Please have Engineering build the export.");
  await expect.poll(() => f.nodes().find((node: any) => node.botId === f.lead.id)?.status, { timeout: 15_000 }).toBe("running");
  await f.api(`/api/bots/${f.chief.id}/interrupt`, { threadId: f.thread });
  await f.wait();
  await f.restart((bots: any[]) => {
    if (!stripRecord) return;
    for (const task of bots.find((b: any) => b.id === f.chief.id).tasks) { delete task.handedMessages; delete task.handedWatermarks; }
  });
  await expect.poll(async () => (await f.messages()).some((m: any) => m.roomRequest?.phase === "result"), { timeout: 20_000 }).toBe(true);
  f.plan[f.chief.id] = { reply: "Engineering was interrupted" };
  await f.send("What happened to the Engineering work?");
  await f.wait();
  return f.turns().at(-1);
};

it("replays once for a stored conversation without a handoff record when a result arrives after restart", () => fixture(async (f) => {
  const turn = await resultAcrossRestart(f, true);
  expect(count(f.prompt(turn), "Interrupted by server restart")).toBe(1);
  expect(f.prompt(turn)).toContain("ORCHID_7Q");
  expect(f.launches().at(-1).resume).toBeNull();
  f.plan[f.chief.id] = { reply: "ok" };
  await f.send("Thanks.");
  await f.wait();
  expect(count(f.prompt(f.turns().at(-1)), "Interrupted by server restart")).toBe(0);
  expect(f.launches().at(-1).resume).not.toBeNull();
}), 90_000);

it("keeps resuming a stored conversation with a handoff record when a result arrives after restart", () => fixture(async (f) => {
  const turn = await resultAcrossRestart(f, false);
  expect(count(f.prompt(turn), "Interrupted by server restart")).toBe(1);
  expect(f.prompt(turn)).not.toContain("ORCHID_7Q");
  expect(f.launches().at(-1).resume).not.toBeNull();
}), 90_000);

// ── Session replacement: the record describes one native session ──

// Running, and its engine launched: a per-launch mode set afterwards cannot reach the teammate.
const leadRunning = async (f: any, launches = 1) => {
  await expect.poll(() => f.nodes().find((node: any) => node.botId === f.lead.id)?.status, { timeout: 15_000 }).toBe("running");
  await expect.poll(() => f.launches(f.lead.id).length, { timeout: 15_000 }).toBe(launches);
};
const cursor = (f: any) => Object.values(f.task().resumeCursors)[0];

it("gives a replacement session the full assignment when a result returns after its resume was rejected", () => fixture(async (f) => {
  await warmUp(f);
  f.plan[f.lead.id] = { reply: "REPLACED_RESULT", gateFile: f.gate("lead") };
  f.plan[f.chief.id] = { turns: [{}, f.delegate("build", [f.lead], `BRIEF_START ${"b".repeat(800)} BRIEF_END`), { reply: "4" }, { reply: "Reviewed" }] };
  await f.send("Please have Engineering build the export.");
  await leadRunning(f);
  const original = cursor(f);
  f.setMode("resume=dead-session");
  await f.send("Meanwhile, what is 2+2?");
  await expect.poll(() => f.turns().length, { timeout: 20_000 }).toBe(3);
  await expect.poll(async () => (await f.messages()).some((m: any) => m.role === "bot" && m.text === "4"), { timeout: 10_000 }).toBe(true);
  f.setMode();
  const replacement = cursor(f);
  f.open(f.gate("lead"));
  await f.wait();

  const recovery = f.prompt(f.turns()[2]);
  const returned = f.prompt(f.turns().at(-1));
  expect(recovery).toContain("could not be resumed");
  expect(replacement).not.toBe(original);
  expect(f.launches().at(-1).resume).toBe(replacement);
  expect(count(recovery + returned, "REPLACED_RESULT")).toBe(1);
  expect(count(returned, "BRIEF_END")).toBeGreaterThanOrEqual(1);
}), 90_000);

it("gives a replacement session an earlier round's result that its rebuild could not replay, and credits it only with that rebuild", () => fixture(async (f) => {
  await warmUp(f, "Warm up.");
  const chat = 21;
  f.plan[f.lead.id] = { turns: [{ reply: "ROUND_ONE_RESULT_TOKEN" }, { reply: "ROUND_TWO_RESULT", gateFile: f.gate("r2") }] };
  f.plan[f.chief.id] = { turns: [
    {},
    f.delegate("r1", [f.lead], "REQUEST_ONE build it"),
    { steps: [{ arguments: { bot_ids: [f.lead.id], request_key: "r2", message: "REQUEST_TWO also test it", rework: true } }], reply: "Round two sent" },
    ...Array.from({ length: chat }, (_, i) => ({ reply: `chat reply ${i}` })),
    { reply: "recovered reply" },
    { reply: "Final" },
  ] };
  await f.send("Please have Engineering build and then test it.");
  await expect.poll(() => f.nodes().filter((node: any) => node.botId === f.lead.id).map((node: any) => node.status).join(","), { timeout: 30_000 }).toBe("completed,running");
  await expect.poll(() => f.turns().length, { timeout: 10_000 }).toBe(3);
  expect(count(f.prompt(f.turns()[2]), "ROUND_ONE_RESULT_TOKEN")).toBe(1);
  await expect.poll(() => f.launches(f.lead.id).length, { timeout: 15_000 }).toBe(2);
  for (let i = 0; i < chat; i++) {
    // Teammate work stays outstanding, so wait for this turn's own reply.
    expect((await f.send(`chat ${i}`)).steered).toBeUndefined();
    await expect.poll(() => f.turns().length, { timeout: 20_000 }).toBe(4 + i);
    await expect.poll(async () => (await f.messages()).some((m: any) => m.text === `chat reply ${i}`), { timeout: 10_000 }).toBe(true);
  }
  const history = async () => (await f.api(`/api/threads/${f.thread}/messages?limit=200`)).messages.map((m: any) => m.id);
  // round one's result: the first result on the branch
  const resultMessage = (await f.api(`/api/threads/${f.thread}/messages?limit=200`)).messages.find((m: any) => m.roomRequest?.phase === "result");
  const original = cursor(f);
  f.setMode("resume=dead-session");
  expect((await f.send("One more question.")).steered).toBeUndefined();
  await expect.poll(() => f.turns().length, { timeout: 20_000 }).toBe(4 + chat);
  await expect.poll(async () => (await f.messages()).some((m: any) => m.text === "recovered reply"), { timeout: 10_000 }).toBe(true);
  f.setMode();
  const recovery = f.prompt(f.turns().at(-1));
  expect(recovery).toContain("could not be resumed");
  expect(count(recovery, "ROUND_ONE_RESULT_TOKEN")).toBe(0);

  // The replacement's record holds its own session and none of the old one's history.
  const replacement = cursor(f);
  expect(replacement).not.toBe(original);
  const records = Object.values(f.handed()) as any[];
  expect(records).toHaveLength(1);
  expect(records[0].session).toBe(replacement);
  const order = await history();
  expect(records[0].ids).not.toContain(resultMessage.id);
  // older than the rebuild's replay window: left out, not received
  expect(order.indexOf(records[0].omitted)).toBeGreaterThanOrEqual(order.indexOf(resultMessage.id));

  f.open(f.gate("r2"));
  await f.wait();
  const returned = f.prompt(f.turns().at(-1));
  expect(count(returned, "ROUND_TWO_RESULT")).toBe(1);
  expect(count(returned, "ROUND_ONE_RESULT_TOKEN")).toBe(1);
  expect(returned).not.toContain("already delivered");
}), 240_000);

it("does not send a message again that a recovery replay carried, including one the unseen limit had deferred", () => fixture(async (f) => {
  await warmUp(f);
  f.setMode("exit-early");
  const marks = Array.from({ length: 13 }, (_, i) => `DEFERRED_${String(i).padStart(2, "0")}_MARK`);
  for (const [i, mark] of marks.entries()) {
    expect((await f.send(`${mark} please note this`)).steered).toBeUndefined();
    await expect.poll(() => f.launches().length, { timeout: 15_000 }).toBe(3 + 2 * i);
    await f.idle();
  }
  f.setMode("resume=dead-session");
  f.plan[f.chief.id] = { reply: "Rebuilt" };
  await f.send("Recover now.");
  await f.wait();
  f.setMode();
  const recovery = f.prompt(f.turns().at(-1));
  expect(recovery).toContain("could not be resumed");
  for (const mark of marks) expect(count(recovery, mark), mark).toBe(1);

  f.plan[f.chief.id] = { reply: "Nothing to repeat" };
  await f.send("Anything left?");
  await f.wait();
  const next = f.prompt(f.turns().at(-1));
  expect(f.launches().at(-1).resume).toBe(cursor(f));
  for (const mark of marks) expect(count(next, mark), mark).toBe(0);
  expect(next).not.toContain("not seen yet");
}), 120_000);

it("replays again when a replacement session fails before the provider acts on it", () => fixture(async (f) => {
  await warmUp(f);
  f.setMode("resume=dead-session,fresh=api-error");
  await f.send("REPLACEMENT_FAILS please answer this");
  await expect.poll(() => f.launches().length, { timeout: 15_000 }).toBe(3);
  await f.idle();
  f.setMode();
  f.plan[f.chief.id] = { reply: "Answered" };
  await f.send("Try again.");
  await f.wait();
  const next = f.prompt(f.turns().at(-1));
  expect(f.launches().at(-1).resume).toBeNull();
  expect(next).toContain("ORCHID_7Q");
  expect(count(next, "REPLACEMENT_FAILS")).toBe(1);
}), 60_000);

it("gives an engine switched in while a teammate works the full assignment when the result returns", () => fixture(async (f) => {
  await warmUp(f);
  f.plan[f.lead.id] = { reply: "SWITCH_RESULT", gateFile: f.gate("lead") };
  f.plan[f.chief.id] = { turns: [{}, f.delegate("build", [f.lead], `ASSIGNMENT_START ${"a".repeat(400)} MUST_KEEP_CONSTRAINT`), { reply: "On Codex now" }, { reply: "Reviewed on Codex" }] };
  await f.send("Please have Engineering build the export.");
  await leadRunning(f);
  await expect.poll(async () => (await f.messages()).some((m: any) => m.role === "bot" && m.text === "Assigned"), { timeout: 15_000 }).toBe(true);
  const model = (await f.cli("models")).instances.find((item: any) => item.instanceId === "codex").models.options[0].id;
  await f.api(`/api/bots/${f.chief.id}/tasks/${f.thread}`, { modelSelection: { instanceId: "codex", model }, requireAvailableModel: true }, "PATCH");
  await f.send("Switching engines while Engineering works.");
  await expect.poll(() => f.turns().length, { timeout: 20_000 }).toBe(3);
  await expect.poll(async () => (await f.messages()).some((m: any) => m.role === "bot" && m.text === "On Codex now"), { timeout: 10_000 }).toBe(true);
  f.open(f.gate("lead"));
  await f.wait();
  const returned = f.turns().at(-1);
  expect(returned.resumedThread).toBeTruthy();
  expect(count(f.prompt(returned), "SWITCH_RESULT")).toBe(1);
  expect(f.prompt(returned)).toContain("MUST_KEEP_CONSTRAINT");
}, { codex: {} }), 90_000);

// ── Acceptance: what counts as the provider having the message ──

it("does not offer a message or steer the person stopped before any reply again", () => fixture(async (f) => {
  f.plan[f.chief.id] = { turns: [{ reply: "Noted." }, { reply: "never shown", gateFile: f.gate("slow") }, { reply: "Listed" }] };
  await f.send("Warm up.");
  await f.wait();
  await f.send("STOPPED_ASK please drop the staging database");
  await expect.poll(() => f.launches().length, { timeout: 15_000 }).toBe(2);
  expect((await f.send("STOPPED_STEER and the backups")).steered).toBe(true);
  await f.api(`/api/bots/${f.chief.id}/interrupt`, { threadId: f.thread });
  await f.idle();
  f.open(f.gate("slow"));
  await f.send("Actually, just list the tables.");
  await f.wait();
  const next = f.prompt(f.turns().at(-1));
  expect(f.launches().at(-1).resume).not.toBeNull();
  expect(next).not.toContain("STOPPED_ASK");
  expect(next).not.toContain("STOPPED_STEER");
}), 60_000);

it("does not offer a message the person stopped before any reply again on Codex", () => fixture(async (f) => {
  await f.useModel("codex");
  f.plan[f.chief.id] = { turns: [{ reply: "Noted." }, { reply: "never shown", gateFile: f.gate("slow") }, { reply: "Listed" }] };
  await f.send("Warm up.");
  await f.wait();
  await f.send("CODEX_STOPPED_ASK please drop the staging database");
  await expect.poll(() => f.codexLaunches().length, { timeout: 15_000 }).toBe(2);
  await f.api(`/api/bots/${f.chief.id}/interrupt`, { threadId: f.thread });
  await f.idle();
  f.open(f.gate("slow"));
  await f.send("Actually, just list the tables.");
  await f.wait();
  const next = f.turns().at(-1);
  expect(next.resumedThread).toBeTruthy();
  expect(f.prompt(next)).not.toContain("CODEX_STOPPED_ASK");
}, { codex: {} }), 90_000);

it("offers a steered message again when the turn fails before the provider used it", () => fixture(async (f) => {
  f.plan[f.chief.id] = { turns: [{ reply: "Noted." }, { progress: "Looking into it", gateFile: f.gate("turn"), fail: true }, { reply: "Covered" }] };
  await f.send("Warm up.");
  await f.wait();
  await f.send("Start on the report.");
  await expect.poll(async () => (await f.messages()).some((m: any) => m.role === "bot" && m.text === "Looking into it"), { timeout: 15_000 }).toBe(true);
  expect((await f.send("UNUSED_STEER also cover costs")).steered).toBe(true);
  f.open(f.gate("turn"));
  await f.idle();
  await f.send("Is it done?");
  await f.wait();
  const next = f.prompt(f.turns().at(-1));
  expect(count(next, "UNUSED_STEER")).toBe(1);
  expect(next).not.toContain("Start on the report.");
}), 60_000);

it("does not offer a steered message again after the person stops the turn it went into", () => fixture(async (f) => {
  f.plan[f.chief.id] = { turns: [{ reply: "Noted." }, { progress: "Looking into it", reply: "never shown", gateFile: f.gate("turn") }, { reply: "Covered" }] };
  await f.send("Warm up.");
  await f.wait();
  await f.send("Start on the report.");
  await expect.poll(async () => (await f.messages()).some((m: any) => m.role === "bot" && m.text === "Looking into it"), { timeout: 15_000 }).toBe(true);
  expect((await f.send("STOPPED_TURN_STEER also cover costs")).steered).toBe(true);
  await f.api(`/api/bots/${f.chief.id}/interrupt`, { threadId: f.thread });
  await f.idle();
  f.open(f.gate("turn"));
  await f.send("Is it done?");
  await f.wait();
  expect(f.prompt(f.turns().at(-1))).not.toContain("STOPPED_TURN_STEER");
}), 60_000);

// The same withdrawal, for a message the person steered out of the server-side
// queue instead of straight into the turn: a different route, one running turn.
it("does not offer a message again that the person steered out of the queue into a turn they then stopped", () => {
  const refuseLiveSteers = join(tmpdir(), `omb-queue-steer-${process.pid}-${Date.now()}.gate`);
  writeFileSync(refuseLiveSteers, "refuse live steers until the queue is lifted");
  return fixture(async (f) => {
    await f.useModel("codex");
    f.plan[f.chief.id] = { turns: [{ reply: "Noted." }, { reply: "never shown", gateFile: f.gate("slow") }, { reply: "Listed" }] };
    await f.send("Warm up.");
    await f.wait();
    await f.send("Start on the report.");
    await expect.poll(() => f.codexLaunches().length, { timeout: 15_000 }).toBe(2);
    // The engine refuses the live steer, so the words wait in the queue.
    const queued = await f.send("QUEUED_STEER also cover costs");
    expect(queued.queued).toBe(true);
    rmSync(refuseLiveSteers, { force: true });
    // A refused steer restores the queue untouched, so the endpoint can be
    // asked again until the engine is far enough into the turn to take it.
    await expect.poll(async () =>
      (await f.api(`/api/bots/${f.chief.id}/queue/${queued.queueId}/steer`, { threadId: f.thread })).steered,
    { timeout: 20_000 }).toBe(true);
    await f.api(`/api/bots/${f.chief.id}/interrupt`, { threadId: f.thread });
    await f.idle();
    f.open(f.gate("slow"));
    await f.send("Is it done?");
    await f.wait();
    expect(f.prompt(f.turns().at(-1))).not.toContain("QUEUED_STEER");
  }, { codex: { FAKE_CODEX_STEER_ERROR_FILE: refuseLiveSteers } });
}, 90_000);

it("offers the results again when the provider reports an API error instead of answering", () => fixture(async (f) => {
  await warmUp(f);
  f.plan[f.lead.id] = { reply: "API_ERROR_RESULT", gateFile: f.gate("lead") };
  f.plan[f.chief.id] = { turns: [{}, f.delegate("build", [f.lead], "Build the export"), { reply: "Here is what Engineering found" }] };
  await f.send("Please have Engineering build the export.");
  await leadRunning(f);
  await expect.poll(async () => (await f.messages()).some((m: any) => m.role === "bot" && m.text === "Assigned"), { timeout: 15_000 }).toBe(true);
  f.setMode("api-error");
  f.open(f.gate("lead"));
  await expect.poll(() => f.nodes().find((node: any) => !node.parentId)?.status, { timeout: 20_000 }).toBe("failed");
  await f.idle();
  f.setMode();
  await f.send("What did Engineering find?");
  await f.wait();
  expect(count(f.prompt(f.turns().at(-1)), "API_ERROR_RESULT")).toBe(1);
}), 60_000);

it("does not hand the model a queued follow-up that a restart recovered with an unknown outcome", () => fixture(async (f) => {
  await f.api("/api/config", { threads: { maxConcurrentPerBot: 1 } }, "PATCH");
  const other = (await f.api(`/api/bots/${f.chief.id}/tasks`, { title: "Second conversation" })).task.threadId;
  const answered = { reply: "Answered" };
  f.plan[f.chief.id] = { turns: [{ reply: "Noted." }, { reply: "Held", gateFile: f.gate("hold") }, { reply: "never", gateFile: f.gate("never") }, answered, answered] };
  await f.send("Warm up.", other);
  await f.wait(other);
  await f.send("Hold the only slot.");
  await expect.poll(() => f.launches().length, { timeout: 15_000 }).toBe(2);
  expect((await f.send("RECOVERED_FOLLOWUP deploy it", other)).queued).toBe(true);
  f.open(f.gate("hold"));
  await expect.poll(() => f.launches().length, { timeout: 15_000 }).toBe(3);
  await f.restart(() => {}, "SIGKILL");
  await expect.poll(async () => (await f.messages(other)).some((m: any) => m.kind === "activity" && m.tool?.name?.includes("Review the result")), { timeout: 20_000 }).toBe(true);
  expect((await f.messages(other)).filter((m: any) => m.role === "user" && m.text?.includes("RECOVERED_FOLLOWUP"))).toHaveLength(1);

  await f.send("Anything new?", other);
  await f.wait(other);
  const next = f.turns().filter((turn: any) => f.prompt(turn).includes("Anything new?")).at(-1);
  expect(f.launches().at(-1).resume).not.toBeNull();
  expect(f.prompt(next)).not.toContain("RECOVERED_FOLLOWUP");
}), 90_000);

// ── Session configuration: what a resume cannot change ──

it("gives a delegated return the fresh session and replay it always had when the bot's soul changed while teammates worked", () => fixture(async (f) => {
  await warmUp(f);
  f.plan[f.lead.id] = { reply: "SOUL_CHANGE_RESULT", gateFile: f.gate("lead") };
  f.plan[f.chief.id] = { turns: [{}, f.delegate("build", [f.lead], "Build the export"), { reply: "Reviewed in German" }, { reply: "Still German" }] };
  await f.send("Please have Engineering build the export.");
  await leadRunning(f);
  await expect.poll(async () => (await f.messages()).some((m: any) => m.role === "bot" && m.text === "Assigned"), { timeout: 15_000 }).toBe(true);
  await f.api(`/api/bots/${f.chief.id}`, { soul: "NEW_SOUL_MARK Always answer in German." }, "PATCH");
  f.open(f.gate("lead"));
  await f.wait();

  const returned = f.turns().at(-1);
  expect(f.launches().at(-1).resume).toBeNull();
  expect(returned.system).toContain("NEW_SOUL_MARK");
  expect(f.prompt(returned)).toContain("received an update outside your provider session");
  expect(f.prompt(returned)).toContain("ORCHID_7Q");
  expect(count(f.prompt(returned), "SOUL_CHANGE_RESULT")).toBe(1);

  await f.send("And now?");
  await f.wait();
  expect(f.launches().at(-1).resume).not.toBeNull();
  expect(count(f.prompt(f.turns().at(-1)), "SOUL_CHANGE_RESULT")).toBe(0);
}), 90_000);

it("keeps resuming an ordinary turn after a soul change, as before", () => fixture(async (f) => {
  await warmUp(f);
  await f.api(`/api/bots/${f.chief.id}`, { soul: "NEW_SOUL_MARK Always answer in German." }, "PATCH");
  f.plan[f.chief.id] = { reply: "Noted again." };
  await f.send("Second message.");
  await f.wait();
  expect(f.launches().at(-1).resume).not.toBeNull();
  expect(f.prompt(f.turns().at(-1))).toBe("Second message.");
}), 60_000);

// ── Steers: never counted as received on output alone ──

it("offers a steer written into a resume the provider then rejected on the next turn", () => fixture(async (f) => {
  await warmUp(f);
  f.setMode("resume=dead-session,holdresume=1");
  f.plan[f.chief.id] = { reply: "Four." };
  await f.send("QUESTION_ONE what is 2+2?");
  await expect.poll(() => f.launches().length, { timeout: 15_000 }).toBe(2);
  expect((await f.send("LOST_STEER_MARK and also mention the backups")).steered).toBe(true);
  f.open(f.gate("resume-hold"));
  await f.wait();
  f.setMode();
  // the rebuild was built before the steer existed
  expect(count(f.prompt(f.turns().at(-1)), "LOST_STEER_MARK")).toBe(0);

  f.plan[f.chief.id] = { reply: "Nothing else." };
  await f.send("NEXT_Q anything else?");
  await f.wait();
  expect(f.launches().at(-1).resume).not.toBeNull();
  expect(count(f.prompt(f.turns().at(-1)), "LOST_STEER_MARK")).toBe(1);
}), 90_000);

it("offers a steered message again when only output of the model call already running follows it before the turn fails", () => fixture(async (f) => {
  f.plan[f.chief.id] = { turns: [
    { reply: "Noted." },
    { progress: "Looking into it", gateFile: f.gate("turn"), progressAfterGate: "Still answering the first question", fail: true },
    { reply: "Covered" },
  ] };
  await f.send("Warm up.");
  await f.wait();
  await f.send("Start on the report.");
  await expect.poll(async () => (await f.messages()).some((m: any) => m.role === "bot" && m.text === "Looking into it"), { timeout: 15_000 }).toBe(true);
  expect((await f.send("BUFFERED_STEER also cover costs")).steered).toBe(true);
  f.open(f.gate("turn"));
  await expect.poll(async () => (await f.messages()).some((m: any) => m.role === "bot" && m.text === "Still answering the first question"), { timeout: 15_000 }).toBe(true);
  await f.idle();
  await f.send("Is it done?");
  await f.wait();
  expect(count(f.prompt(f.turns().at(-1)), "BUFFERED_STEER")).toBe(1);
}), 60_000);

// ── Fallbacks that must send what today's build sends ──

it("rebuilds a delegated return whose Codex thread is gone into a new thread with today's replay", () => fixture(async (f) => {
  await f.useModel("codex");
  await warmUp(f);
  f.plan[f.lead.id] = { reply: "MISSING_THREAD_RESULT", gateFile: f.gate("lead") };
  f.plan[f.chief.id] = { turns: [{}, f.delegate("build", [f.lead], "Build the export"), { reply: "Rebuilt on Codex" }, { reply: "Still on Codex" }] };
  await f.send("Please have Engineering build the export.");
  await leadRunning(f);
  await expect.poll(async () => (await f.messages()).some((m: any) => m.role === "bot" && m.text === "Assigned"), { timeout: 15_000 }).toBe(true);
  // The personal (unmanaged) Codex app-server no longer has the thread.
  f.setMode("happy", "codex");
  f.open(f.gate("lead"));
  await f.wait();
  f.setMode(undefined, "codex");

  expect(f.nodes().find((node: any) => !node.parentId).status).toBe("completed");
  const returned = f.prompt(f.turns().at(-1));
  expect(returned).toContain("received an update outside your provider session");
  expect(returned).toContain("ORCHID_7Q");
  expect(count(returned, "MISSING_THREAD_RESULT")).toBe(1);

  await f.send("And now?");
  await f.wait();
  const next = f.turns().at(-1);
  expect(next.resumedThread).toBeTruthy();
  expect(count(f.prompt(next), "MISSING_THREAD_RESULT")).toBe(0);
}, { codex: {} }), 90_000);

it("replays a result that reaches an engine switched in before it arrived with today's update preamble", () => fixture(async (f) => {
  await warmUp(f);
  f.plan[f.lead.id] = { reply: "EARLY_SWITCH_RESULT", gateFile: f.gate("lead") };
  f.plan[f.chief.id] = { turns: [{}, f.delegate("build", [f.lead], "Build the export"), { reply: "Reviewed on Codex" }] };
  await f.send("Please have Engineering build the export.");
  await leadRunning(f);
  await expect.poll(async () => (await f.messages()).some((m: any) => m.role === "bot" && m.text === "Assigned"), { timeout: 15_000 }).toBe(true);
  const model = (await f.cli("models")).instances.find((item: any) => item.instanceId === "codex").models.options[0].id;
  await f.api(`/api/bots/${f.chief.id}/tasks/${f.thread}`, { modelSelection: { instanceId: "codex", model }, requireAvailableModel: true }, "PATCH");
  f.open(f.gate("lead"));
  await f.wait();
  const returned = f.prompt(f.turns().at(-1));
  expect(returned).toContain("received an update outside your provider session");
  expect(returned).not.toContain("switched this bot over to you");
  expect(returned).toContain("ORCHID_7Q");
  expect(count(returned, "EARLY_SWITCH_RESULT")).toBe(1);
}, { codex: {} }), 90_000);

// A `git` on the server's PATH that holds its first command while `hold` exists,
// then runs the real git: a turn's checkpoint then waits inside turn setup.
const holdingGit = (dataDir: string, hold: string, held: string) => {
  const real = (process.env.PATH ?? "").split(delimiter).map((dir) => join(dir, "git")).find((path) => existsSync(path));
  if (!real) throw new Error("this test needs git on PATH");
  const bin = join(dataDir, "fake-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "git"), [
    "#!/usr/bin/env node",
    'import { existsSync, writeFileSync } from "node:fs";',
    'import { spawnSync } from "node:child_process";',
    "const args = process.argv.slice(2);",
    `if (args[0] !== "--version" && existsSync(${JSON.stringify(hold)})) {`,
    `  writeFileSync(${JSON.stringify(held)}, "held");`,
    `  while (existsSync(${JSON.stringify(hold)})) await new Promise((r) => setTimeout(r, 20));`,
    "}",
    `process.exit(spawnSync(${JSON.stringify(real)}, args, { stdio: "inherit" }).status ?? 1);`,
  ].join("\n"), { mode: 0o700 });
  return bin;
};

// POSIX only, like every process fixture here: the holding `git` is a node
// shebang script, and the lookup above wants a file named exactly `git` —
// on Windows the real one is git.exe and a shebang file is not executable.
// Without the guard this test is the one red case in a 2,600-test shard.
it.skipIf(process.platform === "win32")("gives a delegated return today's fresh session and replay when the soul changes while that turn is being set up", () => fixture(async (f) => {
  const project = join(f.dataDir, "project");
  mkdirSync(project);
  await f.api(`/api/bots/${f.chief.id}`, { cwd: project }, "PATCH");
  const hold = join(f.dataDir, "git.hold");
  const held = join(f.dataDir, "git.held");
  await f.restart(() => {}, "SIGTERM", { PATH: [holdingGit(f.dataDir, hold, held), dirname(process.execPath)].join(delimiter) });
  await warmUp(f);
  f.plan[f.lead.id] = { reply: "SETUP_SOUL_RESULT", gateFile: f.gate("lead") };
  f.plan[f.chief.id] = { turns: [{}, f.delegate("build", [f.lead], "Build the export"), { reply: "Reviewed" }] };
  await f.send("Please have Engineering build the export.");
  await leadRunning(f);
  await expect.poll(async () => (await f.messages()).some((m: any) => m.role === "bot" && m.text === "Assigned"), { timeout: 15_000 }).toBe(true);
  writeFileSync(hold, "hold");
  f.open(f.gate("lead"));
  await expect.poll(() => existsSync(held), { timeout: 20_000 }).toBe(true);
  await f.api(`/api/bots/${f.chief.id}`, { soul: "SETUP_SOUL_MARK Always answer in German." }, "PATCH");
  rmSync(hold);
  await f.wait();

  const returned = f.turns().at(-1);
  expect(returned.system).toContain("SETUP_SOUL_MARK");
  expect(f.launches().at(-1).resume).toBeNull();
  expect(f.prompt(returned)).toContain("received an update outside your provider session");
  expect(count(f.prompt(returned), "SETUP_SOUL_RESULT")).toBe(1);
  // and the record is the replay's, not the resume this turn set out to make
  const record = Object.values(f.handed())[0] as any;
  expect(record.session).toBe(Object.values(f.task().resumeCursors)[0]);
  expect(record.omitted).toBeUndefined();
  expect(record.through).toBeTruthy();

  f.plan[f.chief.id] = { reply: "Nothing new" };
  await f.send("And now?");
  await f.wait();
  expect(f.launches().at(-1).resume).toBe(Object.values(f.task().resumeCursors)[0]);
  expect(count(f.prompt(f.turns().at(-1)), "SETUP_SOUL_RESULT")).toBe(0);
}), 90_000);

it("gives a delegate_bot source today's fresh session and replay when its soul changed since the session started", () => fixture(async (f) => {
  f.plan[f.chief.id] = { turns: [
    { steps: [
      { tool: "delegate_bot", arguments: { bot_id: f.qa.id, message: "Check the quality: QA_SOUL_TOKEN" } },
      { tool: "delegate_bot", arguments: { bot_id: f.ops.id, message: "Check operations: OPS_SOUL_TOKEN" } },
    ], reply: "Delegated" },
    { reply: "First reply folded in", gateFile: f.gate("revival") },
    { reply: "Second reply folded in" },
  ] };
  f.save();
  const created = await f.api("/api/routines", {
    name: "Delegation fixture", prompt: "Delegate the checks.", botId: f.chief.id, enabled: false,
    schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
  });
  const run = (await f.api(`/api/routines/${created.routine.id}/run`, {})).run;
  let threadId = "";
  await expect.poll(async () => (threadId = (await f.api("/api/routines")).runs.find((r: any) => r.id === run.id)?.threadId ?? ""), { timeout: 15_000 }).not.toBe("");
  // The first reply wakes the source; the second lands while that turn holds.
  const replies = async () => (await f.messages(threadId)).filter((m: any) => /^@(QA|Ops) replied to the delegated task/.test(m.text ?? "")).length;
  await expect.poll(replies, { timeout: 30_000 }).toBe(2);
  // Replies can both be recorded before the first resume process starts.
  // Change the soul only once that gated launch has received the old prompt;
  // otherwise a later resume legitimately reuses the already refreshed session.
  await expect.poll(() => f.launches().length, { timeout: 15_000 }).toBe(2);
  await f.api(`/api/bots/${f.chief.id}`, { soul: "PEER_SOUL_MARK Always answer in German." }, "PATCH");
  f.open(f.gate("revival"));
  await expect.poll(() => f.turns().length, { timeout: 30_000 }).toBe(3);

  const [, first, third] = f.turns();
  const late = count(f.prompt(first), "QA_SOUL_TOKEN") ? "OPS_SOUL_TOKEN" : "QA_SOUL_TOKEN";
  expect(third.system).toContain("PEER_SOUL_MARK");
  expect(f.launches().at(-1).resume).toBeNull();
  expect(f.prompt(third)).toContain("received an update outside your provider session");
  expect(count(f.prompt(third), late)).toBe(1);
}), 120_000);

// ── Settings a resumed session cannot take on ──

it("gives a Codex return the model chosen while its teammate worked", () => fixture(async (f) => {
  await f.useModel("codex");
  await warmUp(f);
  f.plan[f.lead.id] = { reply: "CODEX_MODEL_RESULT", gateFile: f.gate("lead") };
  f.plan[f.chief.id] = { turns: [{}, f.delegate("build", [f.lead], "Build the export"), { reply: "Reviewed on the new model" }] };
  await f.send("Please have Engineering build the export.");
  await leadRunning(f);
  await expect.poll(async () => (await f.messages()).some((m: any) => m.role === "bot" && m.text === "Assigned"), { timeout: 15_000 }).toBe(true);
  // Codex applies a model only when a thread starts: thread/resume would keep the old one.
  const [, other] = await f.codexModels();
  await f.selectModel(other);
  f.open(f.gate("lead"));
  await f.wait();

  const started = f.codexCalls().filter((call: any) => call.method === "thread/start");
  expect(started).toHaveLength(1);
  expect(started[0].params.model).toBe(other);
  const returned = f.prompt(f.turns().at(-1));
  expect(returned).toContain("received an update outside your provider session");
  expect(count(returned, "CODEX_MODEL_RESULT")).toBe(1);
}, { codex: {} }), 90_000);

it("gives a Codex return today's fresh thread when explicit effort is cleared while its teammate worked", () => fixture(async (f) => {
  await f.useModel("codex");
  const [model] = await f.codexModels();
  await f.selectModel(model, { effort: "high" });
  await warmUp(f);
  f.plan[f.lead.id] = { reply: "CODEX_EFFORT_RESULT", gateFile: f.gate("lead") };
  f.plan[f.chief.id] = { turns: [{}, f.delegate("build", [f.lead], "Build the export"), { reply: "Reviewed on default effort" }] };
  await f.send("Please have Engineering build the export.");
  await leadRunning(f);
  await expect.poll(async () => (await f.messages()).some((m: any) => m.role === "bot" && m.text === "Assigned"), { timeout: 15_000 }).toBe(true);
  // An effort the driver does not send leaves the native thread's last value.
  await f.selectModel(model);
  f.open(f.gate("lead"));
  await f.wait();

  expect(f.codexCalls().filter((call: any) => call.method === "thread/start")).toHaveLength(1);
  expect(f.codexCalls().find((call: any) => call.method === "turn/start")?.params.effort).toBeUndefined();
  expect(count(f.prompt(f.turns().at(-1)), "CODEX_EFFORT_RESULT")).toBe(1);
}, { codex: {} }), 90_000);

it("keeps today's fresh return on a Claude CLI that cannot refresh a resumed system prompt", () => fixture(async (f) => {
  await warmUp(f);
  f.plan[f.lead.id] = { reply: "OLD_CLI_RESULT", gateFile: f.gate("lead") };
  f.plan[f.chief.id] = { turns: [{}, f.delegate("build", [f.lead], "Build the export"), { reply: "Reviewed" }] };
  await f.send("Please have Engineering build the export.");
  await leadRunning(f);
  f.open(f.gate("lead"));
  await f.wait();

  expect(f.launches().at(-1).resume).toBeNull();
  const returned = f.prompt(f.turns().at(-1));
  expect(returned).toContain("received an update outside your provider session");
  expect(returned).toContain("ORCHID_7Q");
  expect(count(returned, "OLD_CLI_RESULT")).toBe(1);
  // nothing recorded: this engine cannot be given only what it has not seen
  expect(f.handed()).toBeUndefined();
}, { env: { FAKE_CLAUDE_VERSION: "2.1.200" } }), 90_000);
