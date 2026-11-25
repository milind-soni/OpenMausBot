// The agents tool bridge on Google's native Antigravity CLI, end to end through an isolated server and the repository's
// stand-in for that CLI (server/testing/fake-antigravity-cli.ts), which drops the largest MCP tools past the measured
// budget and asks permission as 1.5.x does. A prompt line `fake-agy: call <server>/<tool> <JSON>` stands for the model's
// tool call. Uses no model and no account.
//   node --experimental-strip-types scripts/verify-antigravity-bridge.ts [OUTPUT_DIR]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { fixtureApi } from "./testing/preview-fixture.ts";

const output = resolve(process.argv[2] ?? join(process.cwd(), "antigravity-bridge-evidence"));
mkdirSync(output, { recursive: true });
let fixture: Awaited<ReturnType<typeof launchVerificationServer>>;
let url = "";
let api: ReturnType<typeof fixtureApi>;
let fakeLog = "";
async function launch(env: NodeJS.ProcessEnv) {
  fixture = await launchVerificationServer({ ...process.env, ...env }, undefined, undefined, undefined, undefined, undefined, ["antigravity"]);
  url = fixture.info.url;
  api = fixtureApi(url);
  fakeLog = join(fixture.info.dataDir, "fake-antigravity.log");
  (report.fixtures as unknown[]).push(fixture.info);
  console.log(JSON.stringify({ fixture: fixture.info, output }));
}
const report: Record<string, unknown> = { fixtures: [], steps: [] };
const steps = report.steps as Array<Record<string, unknown>>;
const save = () => writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
await launch({});

const control = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
const fakeEntries = () => readFileSync(fakeLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>);
const lastTools = () => fakeEntries().filter((entry) => entry.event === "tools" && entry.visible.length > 0).at(-1);

async function say(botId: string, text: string, label: string) {
  const before = fakeEntries().length;
  await control("send", "--bot", botId, "--text", text);
  const waited = await control("wait", "--bot", botId, "--timeout", "60");
  const messages = await control("messages", "--bot", botId, "--limit", "6");
  const step = { label, text, waited, messages, fake: fakeEntries().slice(before) };
  steps.push(step);
  save();
  return step;
}

const check = (name: string, ok: boolean, detail?: unknown) => {
  (report.checks as Array<unknown>).push({ name, ok, ...(detail === undefined ? {} : { detail }) });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  save();
};
report.checks = [];
const botText = (step: { messages: any }) => (step.messages.messages as Array<any>).filter((m) => m.role === "bot" && m.kind === "text").map((m) => m.text).join("\n");
const pidsOf = (entries: Array<Record<string, any>>) => [...new Set(entries.filter((e) => e.event === "tools" && e.visible.length > 0).map((e) => e.pid))];

try {
  const { bot: chief } = await api("POST", "/api/bots", { name: "Chief", description: "Runs the team.", modelSelection: { instanceId: "antigravity", model: "fixture-base-model" } });
  const { bot: helper } = await api("POST", "/api/bots", { name: "Helper", description: "Takes work.", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } });
  await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true });
  report.bots = { chief: chief.id, helper: helper.id };
  // The person's own MCP server, about the size of the browser tools this fixture cannot mount: the CLI's budget counts
  // every server's tools together.
  const ownTools = join(fixture.info.dataDir, "own-tools.json");
  writeFileSync(ownTools, JSON.stringify(Array.from({ length: 12 }, (_, i) => ({
    name: `note_${i}`, description: `Reads saved note ${i}. `.repeat(30), inputSchema: { type: "object", properties: { id: { type: "string", description: "Which note.".repeat(20) } } },
  }))));
  report.ownServer = await api("POST", "/api/mcp/servers", { name: "notes", command: process.execPath, args: [fileURLToPath(new URL("../server/testing/fake-mcp-server.ts", import.meta.url))], env: { FAKE_MCP_TOOLS_FILE: ownTools }, enabled: true });

  await api("PATCH", "/api/mcp/servers/notes", { enabled: true });
  report.servers = await api("GET", "/api/mcp/servers");

  const on0 = await say(chief.id, "fake-agy: tools", "default: tools the model sees");
  const on0Tools = lastTools();
  check("default: bridged with no switch, nothing dropped", on0Tools?.hidden.length === 0 && on0Tools?.visible.includes("mcp_agents_find_tool"), { bytes: on0Tools?.bytes, hidden: on0Tools?.hidden });
  check("default: the person's own server is mounted", on0Tools?.visible.some((name: string) => name.startsWith("mcp_notes_")) === true);
  check("default: the native CLI reaches the agents and data servers by URL", on0Tools?.transports?.agents === "http" && on0Tools?.transports?.data === "http", on0Tools?.transports);
  check("default: the data server's tools are listed", on0Tools?.visible.some((name: string) => name.startsWith("mcp_data_")) === true);

  await api("PUT", "/api/config", { features: { agentsToolBridge: false } });
  const off1 = await say(chief.id, "fake-agy: tools\nfake-agy: call agents/coordinate_bots {\"bot_ids\":[\"Helper\"],\"message\":\"x\"}", "bridge off: tools the model sees");
  const offTools = lastTools();
  check("bridge off: the CLI drops tools past its budget, coordinate_bots among them", offTools?.hidden.includes("mcp_agents_coordinate_bots") === true, { bytes: offTools?.bytes, hidden: offTools?.hidden });
  check("bridge off: the model cannot call coordinate_bots", /NOTOOL agents\/coordinate_bots/u.test(botText(off1)), botText(off1));
  check("bridge off: no find_tool or use_tool", offTools?.visible.some((name: string) => /find_tool|use_tool/u.test(name)) === false);
  check("bridge off: the switch gave the session a new process", pidsOf(off1.fake).length === 1 && !pidsOf(on0.fake).includes(pidsOf(off1.fake)[0]));

  await api("PUT", "/api/config", { features: { agentsToolBridge: true } });
  const on1 = await say(chief.id, "fake-agy: tools", "bridge on again: tools the model sees");
  const onTools = lastTools();
  check("bridge on: nothing dropped", onTools?.hidden.length === 0, { bytes: onTools?.bytes });
  check("bridge on: find_tool, use_tool and coordinate_bots under their own names", ["mcp_agents_find_tool", "mcp_agents_use_tool", "mcp_agents_coordinate_bots"].every((name) => onTools?.visible.includes(name)), onTools?.visible);
  check("bridge on: the switch gave the session a new process", pidsOf(on1.fake).length === 1 && !pidsOf(off1.fake).includes(pidsOf(on1.fake)[0]));
  check("the conversation kept one native session throughout", new Set([...on0.fake, ...off1.fake, ...on1.fake].filter((e) => e.event === "tools" && e.visible.length > 0).map((e) => e.sessionId)).size === 1);

  const marker = `handoff-${Date.now()}`;
  const handed = await say(chief.id, `fake-agy: call agents/coordinate_bots {"bot_ids":["Helper"],"message":"${marker}: reply with one word."}`, "hand-off");
  check("hand-off: coordinate_bots ran", /RESULT agents\/coordinate_bots(?! \(error\))/u.test(botText(handed)), botText(handed));
  const receipt = /"threadId":"([\w-]+)"/u.exec(botText(handed))?.[1] ?? "";
  const helperMessages = await control("messages", "--bot", helper.id, "--task", receipt, "--limit", "10");
  check("hand-off: the helper received the work", JSON.stringify(helperMessages).includes(marker));
  steps.push({ label: "helper messages", messages: helperMessages });

  const hidden = await say(chief.id, 'fake-agy: call agents/find_tool {"query":"threads"}\nfake-agy: call agents/use_tool {"name":"list_threads","arguments":{}}', "hidden tool on Full");
  const text = botText(hidden);
  check("find_tool answered", /RESULT agents\/find_tool(?! \(error\))/u.test(text), text);
  check("use_tool ran list_threads and returned this conversation", /RESULT agents\/use_tool(?! \(error\)):[\s\S]*fake-agy: tools/u.test(text), text);

  await api("PATCH", `/api/bots/${chief.id}`, { approvalMode: "ask" });
  const { providerToolAllowKey, providerToolConfig } = await import("../server/provider-tool-allow.ts");
  const grant = providerToolAllowKey("antigravity", "mcp__agents__list_threads", providerToolConfig("agents", {}))!;
  await api("PATCH", `/api/bots/${chief.id}`, { alwaysAllow: [grant] });
  await control("send", "--bot", chief.id, "--text", 'fake-agy: call agents/use_tool {"name":"list_threads","arguments":{}}');
  const askWait = await control("wait", "--bot", chief.id, "--timeout", "30");
  const askThread = askWait.threadId ?? askWait.job?.threadId;
  const askMessages = await api("GET", `/api/threads/${askThread}/messages?limit=6`);
  const card = ((askMessages.messages ?? askMessages) as Array<any>).map((m) => m.card).filter((c) => c?.requestId).at(-1);
  steps.push({ label: "use_tool at Ask", waited: askWait, messages: askMessages });
  check("Ask: use_tool waits for a person even with a saved grant for the tool it names", askWait.state === "needs-user" || askWait.job?.state === "needs-user" || card !== undefined, askWait.state ?? askWait.job?.state);
  check("Ask: the card names list_threads", JSON.stringify(card ?? {}).includes("list_threads"), card);
  check("Ask: the card offers no allow for the session and carries no saved-grant key", card !== undefined && !card.allowSession && !card.allowKey, card);
  if (card?.requestId) await api("POST", `/api/bots/${chief.id}/respond`, { requestId: card.requestId, behavior: "allow" });
  const afterAllow = await control("wait", "--bot", chief.id, "--timeout", "30");
  const afterAllowMessages = await control("messages", "--bot", chief.id, "--limit", "4");
  steps.push({ label: "after allowing use_tool once", waited: afterAllow, messages: afterAllowMessages });
  const sinceCard = (afterAllowMessages.messages as Array<any>).slice((afterAllowMessages.messages as Array<any>).findLastIndex((m) => m.role === "user") + 1);
  check("Ask: allowed once, use_tool ran", sinceCard.some((m) => m.role === "bot" && m.kind === "text" && /RESULT agents\/use_tool(?! \(error\))/u.test(m.text)), sinceCard);

  const findAsk = await say(chief.id, 'fake-agy: call agents/find_tool {"query":"memory"}', "find_tool at Ask");
  check("Ask: find_tool ran with no card", /RESULT agents\/find_tool(?! \(error\))/u.test(botText(findAsk)), findAsk.waited?.state);

  const answerCard = async (label: string, text: string, always: boolean) => {
    await control("send", "--bot", chief.id, "--text", text);
    const waited = await control("wait", "--bot", chief.id, "--timeout", "30");
    const listed = await api("GET", `/api/threads/${waited.threadId ?? waited.job?.threadId}/messages?limit=6`);
    const found = ((listed.messages ?? listed) as Array<any>).map((m) => m.card).filter((c) => c?.requestId).at(-1);
    steps.push({ label, waited, card: found });
    if (found?.requestId) await api("POST", `/api/bots/${chief.id}/respond`, { requestId: found.requestId, behavior: "allow", always });
    await control("wait", "--bot", chief.id, "--timeout", "30");
    return found;
  };
  const direct = await answerCard("direct list_bots at Ask, allowed for the session", "fake-agy: call agents/list_bots {}", true);
  check("Ask: a direct call's card offers allow for the session", direct?.allowSession === true, direct);
  // The same tool, title and input as the direct call, toolSummary included, so a session allow would match it if use_tool could take one.
  const again = await answerCard("use_tool after a session allow", 'fake-agy: call agents/use_tool {"name":"list_bots","arguments":{"toolSummary":"Run list_bots"}}', false);
  check("Ask: use_tool still asks after the session allow, for the same tool", again?.requestId !== undefined && !again.allowSession && !again.allowKey, again);

  await api("PATCH", `/api/bots/${chief.id}`, { approvalMode: "full" });
  await api("PUT", "/api/config", { safetyFloor: { enabled: true } });
  const floored = await say(chief.id, 'fake-agy: call agents/use_tool {"name":"vm_exec","arguments":{"command":"rm -rf ~"}}', "never-list command through use_tool at Full");
  check("floor: the wrapped never-list command was denied", /DENIED agents\/use_tool/u.test(botText(floored)), botText(floored));
  check("floor: the agents server got no call", !floored.fake.some((e) => e.event === "tools/call"));
  await api("PUT", "/api/config", { safetyFloor: { enabled: false } });

  await api("PUT", "/api/config", { features: { agentsToolBridge: false } });
  const off2 = await say(chief.id, 'fake-agy: tools\nfake-agy: call agents/list_bots {}', "bridge off again");
  const off2Tools = lastTools();
  check("off again: a new process, and no find_tool or use_tool", pidsOf(off2.fake).length === 1 && !pidsOf(on1.fake).includes(pidsOf(off2.fake)[0]) && !off2Tools?.visible.some((name: string) => /find_tool|use_tool/u.test(name)));
  check("off again: list_bots reaches the unbridged agents server", /RESULT agents\/list_bots(?! \(error\))/u.test(botText(off2)), botText(off2));
  check("every tool name stayed mcp_agents_<tool>", fakeEntries().filter((e) => e.event === "tools").every((e) => e.visible.every((name: string) => !/^mcp_agents_[0-9a-f]{8}_/u.test(name))));
} finally {
  save();
  await fixture.close();
}

// A later release that spells a bridged call another way: refused once, then that release lists the agents tools directly.
await launch({ FAKE_AGY_SPELLING: "dotted", FAKE_AGY_VERSION: "1.5.17" });
try {
  const { bot: chief } = await api("POST", "/api/bots", { name: "Chief", description: "Runs the team.", modelSelection: { instanceId: "antigravity", model: "fixture-base-model" } });
  const first = await say(chief.id, 'fake-agy: call agents/find_tool {"query":"threads"}', "respelled release: a bridged call");
  check("respelled release: bridged at first", lastTools()?.visible.includes("mcp.agents.find_tool") === true, lastTools()?.visible);
  check("respelled release: the call in an unknown spelling is refused and never reaches the agents server",
    !first.fake.some((e) => e.event === "tools/call") && first.fake.some((e) => e.event === "permission" && e.outcome?.optionId === "deny"), first.fake.filter((e) => e.event === "permission"));
  const memory = JSON.parse(readFileSync(join(fixture.info.dataDir, "antigravity-bridge.json"), "utf8"));
  check("respelled release: 1.5.17 is recorded as unbridgeable", JSON.stringify(memory.unbridgeable) === '["1.5.17"]', memory);
  const next = await say(chief.id, "fake-agy: tools\nfake-agy: call agents/list_bots {}", "respelled release: the next message");
  check("respelled release: the next message lists the agents tools directly", lastTools()?.visible.some((name: string) => /find_tool|use_tool/u.test(name)) === false, lastTools()?.visible);
  check("respelled release: a direct call works again", /RESULT agents\/list_bots(?! \(error\))/u.test(botText(next)), botText(next));
} finally {
  save();
  await fixture.close();
}
const failed = (report.checks as Array<{ ok: boolean }>).filter((c) => !c.ok).length;
console.log(JSON.stringify({ report: join(output, "report.json"), failed }));
process.exitCode = failed ? 1 : 0;
