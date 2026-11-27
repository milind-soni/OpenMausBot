// The Usage page and its traces on a disposable fake-engine home: real delegated runs through the scripted engine, one of
// them left running for the Live view, then their recorded timings stretched and filled with tool spans so the page shows
// a realistic job, plus two rows from before traces existed.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { fixtureApi, mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";

const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
let ui: MountedPreview | undefined;
const api = fixtureApi(fixture.info.url, { headers: { origin: fixture.info.url } });
const control = (args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
async function until<T>(check: () => T | Promise<T>): Promise<NonNullable<T>> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const value = await check();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`Fixture timed out; see ${fixture.info.logPath}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

try {
  const bot = async (name: string, section: string) => (await control(["new-bot", "--name", name, "--section", section])).bot;
  const clive = await bot("Clive", "Leadership");
  const researcher = await bot("Researcher", "Launch");
  const writer = await bot("Writer", "Launch");
  const coder = await bot("Coder", "Launch");
  await api("PATCH", `/api/bots/${clive.id}`, { chiefOfStaff: true, managedSections: ["Launch"], acknowledgePeerScope: true });
  const gate = join(fixture.info.dataDir, "live-gate");
  const plan = (steps: unknown[], reply: string, extra: Record<string, unknown> = {}) => ({ steps, reply, ...extra });
  const ask = (ids: string[], message: string) => ({ arguments: { bot_ids: ids, message } });
  writeFileSync(join(fixture.info.dataDir, "room-plan.json"), JSON.stringify({
    [clive.id]: { byPrompt: [
      { promptIncludes: "Draft the launch email", plan: plan([ask([writer.id], "Draft the launch email")], "Writer is on it", { resumeReply: "Email drafted" }) },
      { promptIncludes: "Launch the new pricing page", plan: plan([ask([researcher.id, writer.id, coder.id], "Your part of the pricing launch")], "Assigned the launch", { resumeReply: "The pricing page is ready to ship" }) },
      { promptIncludes: "Compare our pricing", plan: plan([ask([researcher.id], "Compare our pricing with Linear and Notion")], "Asked Researcher", { resumeReply: "Compared" }) },
    ] },
    [researcher.id]: plan([{ tool: "list_bots", arguments: {} }, { tool: "list_rooms", arguments: {} }], "Pricing compared"),
    [writer.id]: { byPrompt: [
      { promptIncludes: "Draft the launch email", plan: plan([{ tool: "list_bots", arguments: {} }], "Draft ready", { gateFile: gate }) },
      { promptIncludes: "pricing launch", plan: plan([], "Copy drafted") },
    ] },
    [coder.id]: plan([{ tool: "list_rooms", arguments: {} }], "Page built"),
  }));

  const send = async (text: string) => {
    await control(["send", "--bot", clive.id, "--task", clive.activeTaskId, "--text", text]);
    await control(["wait", "--bot", clive.id, "--task", clive.activeTaskId, "--timeout", "60"]);
  };
  const ledger = () => readdirSync(join(fixture.info.dataDir, "usage")).filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) => readFileSync(join(fixture.info.dataDir, "usage", name), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)));
  await send("Compare our pricing with Linear and Notion");
  await until(() => ledger().filter((row) => row.turnId).length >= 3);
  const before = ledger().length;
  await send("Launch the new pricing page by Friday");
  await until(() => ledger().length >= before + 5);
  await new Promise((resolve) => setTimeout(resolve, 1_500));

  // Stretch the launch run to a realistic length and give its turns the tools a real job would use.
  const launch = ledger().slice(before);
  const usageFile = join(fixture.info.dataDir, "usage", readdirSync(join(fixture.info.dataDir, "usage")).find((name) => name.endsWith(".jsonl"))!);
  const T = Date.now() - 8 * 60_000;
  const at = (seconds: number) => T + Math.round(seconds * 1000);
  const shape: Record<string, { start: number; end: number; model: string; driverKind: string; cost: number; input: number; cached: number; output: number }> = {
    [clive.id]: { start: 0, end: 7.9, model: "claude-opus-5-5", driverKind: "claude", cost: 0.14, input: 18_400, cached: 12_100, output: 640 },
    [researcher.id]: { start: 8.2, end: 38.4, model: "claude-sonnet-5-5", driverKind: "claude", cost: 0.05, input: 21_900, cached: 15_200, output: 1_480 },
    [writer.id]: { start: 9.1, end: 46.2, model: "claude-sonnet-5-5", driverKind: "claude", cost: 0.09, input: 16_300, cached: 9_800, output: 2_950 },
    [coder.id]: { start: 12.4, end: 50.1, model: "gpt-6-sol", driverKind: "codex", cost: 0.13, input: 24_600, cached: 18_000, output: 1_870 },
  };
  const rows = readFileSync(usageFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const launchKeys = new Set(launch.map((row) => `${row.threadId}:${row.turnId}`));
  const resumed = launch.filter((row) => row.botId === clive.id).at(-1);
  const turns: Record<string, { threadId: string; turnId: string }> = {};
  for (const row of rows) {
    if (!launchKeys.has(`${row.threadId}:${row.turnId}`)) continue;
    const isResume = row === rows.find((candidate) => candidate.threadId === resumed.threadId && candidate.turnId === resumed.turnId);
    const s = isResume ? { ...shape[clive.id]!, start: 50.3, end: 51.4, cost: 0.01, input: 19_100, cached: 18_200, output: 120 } : shape[row.botId]!;
    Object.assign(row, { startedAt: new Date(at(s.start)).toISOString(), endedAt: new Date(at(s.end)).toISOString(), at: new Date(at(s.end)).toISOString(),
      model: s.model, driverKind: s.driverKind, costUsd: s.cost, costSource: "reported", input: s.input, cachedInput: s.cached, output: s.output, usageStatus: "complete" });
    if (!isResume) turns[row.botId] = { threadId: row.threadId, turnId: row.turnId };
  }
  const old = (day: number, botId: string, name: string, cost: number) => ({ at: new Date(Date.now() - day * 86_400_000).toISOString(), botId, botName: name,
    threadId: botId, instanceId: "claude", driverKind: "claude", model: "claude-sonnet-5-5", input: 9_000, output: 700, cachedInput: 6_000, costUsd: cost,
    costSource: "reported", trigger: { kind: "owner" } });

  const spans: object[] = [];
  let serial = 0;
  const step = (owner: string, start: number, end: number, output: number, input = 4_000) => {
    const turn = turns[owner]!;
    spans.push({ kind: "step", id: `${turn.threadId}:${turn.turnId}:seed-step-${++serial}`, ...turn, startedAt: at(start), endedAt: at(end),
      tokens: { input, cachedInput: Math.round(input * 0.7), output } });
  };
  const tool = (owner: string, name: string, start: number, end: number, detail?: string, status = "ok", error?: string) => {
    const turn = turns[owner]!;
    spans.push({ kind: "tool", id: `${turn.threadId}:${turn.turnId}:seed-tool-${++serial}`, ...turn, name, startedAt: at(start), endedAt: at(end),
      status, timedBy: name.startsWith("mcp__") ? "omb" : "engine", ...(detail ? { detail } : {}), ...(error ? { error } : {}) });
  };
  step(clive.id, 0, 6.9, 520, 14_000);
  tool(clive.id, "mcp__agents__coordinate_bots", 7.0, 7.6, "Researcher, Writer, Coder");
  step(clive.id, 7.6, 7.9, 120, 4_400);
  step(researcher.id, 8.2, 9.2, 90);
  tool(researcher.id, "WebSearch", 9.2, 14.6, "Linear pricing");
  tool(researcher.id, "WebSearch", 9.4, 16.6, "Notion pricing");
  tool(researcher.id, "mcp__data__query", 9.6, 13.1, "plan_usage by tier");
  step(researcher.id, 16.6, 17.3, 110);
  const browser = ["open g2.com/products/linear/reviews", "snapshot", "click", "scroll", "scroll", "click", "snapshot", "open g2.com/products/notion/reviews",
    "snapshot", "click", "scroll", "snapshot", "get_text", "screenshot"];
  let clock = 17.4;
  browser.forEach((action, index) => {
    const [verb, page] = action.split(" ");
    const span = verb === "open" ? 1.6 : verb === "snapshot" ? 0.5 : 0.7;
    tool(researcher.id, `mcp__browser__agent_browser_${verb}`, clock, clock + span, page ?? (verb === "click" ? "Reviews tab" : undefined));
    clock += span;
    if (index < browser.length - 1) { step(researcher.id, clock, clock + 0.25, 30, 2_200); clock += 0.25; }
  });
  step(researcher.id, clock + 0.1, 38.4, 980, 9_000);
  step(writer.id, 9.1, 10.9, 140);
  tool(writer.id, "mcp__composio__NOTION_FETCH_DATA", 10.9, 14.5, "Brand voice");
  tool(writer.id, "mcp__composio__FIGMA_GET_FILE_JSON", 11.2, 16.3, "Pricing frames");
  step(writer.id, 16.4, 39.6, 2_450, 7_200);
  tool(writer.id, "mcp__composio__NOTION_CREATE_NOTION_PAGE", 39.7, 43.3, "Launch draft");
  step(writer.id, 43.3, 46.2, 200);
  step(coder.id, 12.4, 13.6, 160);
  tool(coder.id, "mcp__composio__GITHUB_CREATE_A_REFERENCE", 13.6, 15.7, "pricing-page-v2");
  const computer = ["launch_app", "screenshot", "click", "type_text", "press_key", "screenshot", "scroll", "click", "type_text", "screenshot",
    "click", "click", "type_text", "press_key", "screenshot", "scroll", "click", "screenshot", "drag", "click", "type_text", "press_key", "screenshot"];
  clock = 15.9;
  computer.forEach((action, index) => {
    const span = action === "screenshot" ? 0.4 : action === "type_text" ? 1.1 : 0.6;
    tool(coder.id, `mcp__computer__${action}`, clock, clock + span, action === "launch_app" ? "VS Code" : action === "type_text" ? "editor" : undefined);
    clock += span;
    if (index < computer.length - 1) { step(coder.id, clock, clock + 0.35, 40, 2_600); clock += 0.35; }
  });
  tool(coder.id, "Bash", 44.2, 47.9, "pnpm test pricing", "error", "3 tests failed: plan toggle keeps the old price");
  step(coder.id, 47.9, 50.1, 310);
  for (const [owner, turn] of Object.entries(turns)) {
    const own = spans.filter((span) => (span as { threadId: string }).threadId === turn.threadId) as Array<{ kind: string; status?: string }>;
    const row = rows.find((candidate) => candidate.threadId === turn.threadId && candidate.turnId === turn.turnId)!;
    Object.assign(row, { steps: own.filter((span) => span.kind === "step").length, tools: own.filter((span) => span.kind === "tool").length,
      toolErrors: own.filter((span) => span.status === "error").length, ...(owner === coder.id ? { outcome: { status: "ok" } } : {}) });
  }
  writeFileSync(usageFile, [old(2, researcher.id, "Researcher", 0.03), old(1, writer.id, "Writer", 0.02), ...rows].map((row) => JSON.stringify(row)).join("\n") + "\n");
  const spansDir = join(fixture.info.dataDir, "usage", "spans");
  const day = new Date(at(0)).toISOString().slice(0, 10);
  const dayFile = join(spansDir, `${day}.jsonl`);
  const kept = readFileSync(dayFile, "utf8").split("\n").filter(Boolean).filter((line) => {
    const span = JSON.parse(line) as { threadId: string; turnId: string };
    return !launchKeys.has(`${span.threadId}:${span.turnId}`) || (span.threadId === resumed.threadId && span.turnId === resumed.turnId);
  });
  const resumeShift = (line: string) => {
    const span = JSON.parse(line);
    if (span.threadId !== resumed.threadId || span.turnId !== resumed.turnId) return line;
    return JSON.stringify({ ...span, startedAt: at(50.3), endedAt: at(51.4) });
  };
  writeFileSync(dayFile, [...kept.map(resumeShift), ...spans.map((span) => JSON.stringify(span))].join("\n") + "\n");

  await control(["send", "--bot", clive.id, "--task", clive.activeTaskId, "--text", "Draft the launch email for Friday"]);
  ui = await mountPreview(fixture, { entry: "/scripts/testing/usage-traces-preview.tsx", route: "/__usage-traces.html", title: "Isolated OMB Usage", logLevel: "silent" });
  console.log(JSON.stringify({ ...fixture.info, previewUrl: ui.previewUrl, gate }));
  await parkUntilSignal();
} finally {
  await ui?.close();
  await fixture.close();
}
