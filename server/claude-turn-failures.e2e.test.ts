// Two ways a Claude turn failed and the harness told nobody the truth,
// replayed against the real server with the fake CLI playing the frames
// Claude Code 2.1.295 really sent (Oct 8-10):
//   - an account past its weekly limit was reported as "update required",
//     then "stop_sequence", and its Chief told the person to finish setup;
//   - a session the CLI no longer had after a long idle ended the turn empty.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { rebuiltSessionNotice } from "./resume-recovery.ts";

/** Pesto's account, as the CLI's rate_limit_event reported it on Oct 9. */
const weekly = (resetsAt: number) => ({
  FAKE_CLAUDE_RATE_LIMIT: JSON.stringify({ status: "rejected", resetsAt, rateLimitType: "seven_day", overageStatus: "rejected", isUsingOverage: false }),
});
const LIMIT_WITH_RESET = /This Claude account has reached its weekly limit, which resets /;

/** A verification server whose Claude runs each turn in the fake mode
 * `modes` (a JSON file of "<thread>:<bot>", thread or bot id → {mode, env})
 * names for it, most specific first; any other turn is a happy one. Every
 * turn dumps to <thread>-<bot>.json. */
async function launch() {
  const fixture = await launchVerificationServer();
  const { url, dataDir } = fixture.info;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, {
      method,
      headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.ok, `${method} ${path} ${response.status}: ${JSON.stringify(value)}`).toBe(true);
    return value;
  };
  const control = (args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
  const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[];
  const modes = join(dataDir, "fake-modes.json");
  writeFileSync(modes, "{}");
  const wrapper = join(dataDir, "fake-claude.mjs");
  writeFileSync(wrapper, [
    "#!/usr/bin/env node",
    'import { readFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'const at = process.argv.indexOf("--mcp-config");',
    'const agents = at < 0 ? {} : JSON.parse(readFileSync(process.argv[at + 1], "utf8")).mcpServers?.agents?.env ?? {};',
    'const thread = agents.OMB_THREAD_ID ?? "probe";',
    'const bot = agents.OMB_BOT_ID ?? "probe";',
    `const modes = JSON.parse(readFileSync(${JSON.stringify(modes)}, "utf8"));`,
    "const plan = modes[`${thread}:${bot}`] ?? modes[thread] ?? modes[bot] ?? {};",
    'process.env.FAKE_CLAUDE_MODE = plan.mode ?? "happy";',
    "Object.assign(process.env, plan.env ?? {});",
    `process.env.FAKE_CLAUDE_DUMP = join(${JSON.stringify(dataDir)}, \`\${thread}-\${bot}.json\`);`,
    `await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-claude-cli.ts")).href)});`,
  ].join("\n"), { mode: 0o700 });
  await api("PATCH", "/api/instances/claude", { cli: wrapper });
  const play = (key: string, mode: string, env: Record<string, string> = {}) => {
    const plan = JSON.parse(readFileSync(modes, "utf8"));
    writeFileSync(modes, JSON.stringify({ ...plan, [key]: { mode, env } }));
  };
  const dumpOf = (threadId: string, botId: string) => join(dataDir, `${threadId}-${botId}.json`);
  /** What the latest turn of `botId` in `threadId` was handed. */
  const told = (threadId: string, botId: string) => {
    try { return JSON.stringify(JSON.parse(readFileSync(dumpOf(threadId, botId), "utf8")).prompt); } catch { return ""; }
  };
  const proxies: ReturnType<typeof spawn>[] = [];
  /** The agents tools of `botId`'s running turn in `threadId`, called the way
   * its engine calls them: through the MCP server its launch was handed. */
  const agentTools = async (threadId: string, botId: string) => {
    const dump = dumpOf(threadId, botId);
    await expect.poll(() => existsSync(dump), { timeout: 20_000 }).toBe(true);
    const agents = JSON.parse(readFileSync(dump, "utf8")).mcpConfig.mcpServers.agents;
    const proxy = spawn(agents.command, agents.args, { env: { PATH: process.env.PATH, HOME: dataDir, ...agents.env }, stdio: ["pipe", "pipe", "pipe"] });
    proxies.push(proxy);
    const replies = new Map<number, (value: any) => void>();
    createInterface({ input: proxy.stdout! }).on("line", (line) => {
      const message = JSON.parse(line);
      replies.get(message.id)?.(message.result ?? message);
      replies.delete(message.id);
    });
    let next = 0;
    const request = (method: string, params: unknown): Promise<any> => new Promise((resolve) => {
      const id = ++next;
      replies.set(id, resolve);
      proxy.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
    await request("initialize", { protocolVersion: "2024-11-05" });
    return (name: string, args: unknown) => request("tools/call", { name, arguments: args });
  };
  /** `chief`'s turn in `threadId` hands Pesto work with coordinate_bots and
   * ends; Pesto runs into its weekly limit; the Chief is resumed with what
   * came back, and that is returned. */
  const handOff = async (threadId: string, chief: { id: string }, pesto: { id: string }, send: () => Promise<unknown>) => {
    const release = join(dataDir, `release-${chief.id}`);
    play(`${threadId}:${chief.id}`, "hang", { FAKE_CLAUDE_RELEASE: release });
    // every turn of Pesto's, in whichever thread the hand-off opens
    play(pesto.id, "usage-limit", weekly(Math.floor(Date.now() / 1000) + 3 * 86_400));
    await send();
    const call = await agentTools(threadId, chief.id);
    const handed = await call("coordinate_bots", { bot_ids: [pesto.id], message: "Draft the launch note.", request_key: "launch-note" });
    expect(JSON.stringify(handed)).not.toContain('"isError":true');
    const before = told(threadId, chief.id);
    play(`${threadId}:${chief.id}`, "happy");
    writeFileSync(release, "");
    await expect.poll(() => told(threadId, chief.id) !== before && told(threadId, chief.id).includes("Pesto"), { timeout: 30_000 }).toBe(true);
    return told(threadId, chief.id);
  };
  const close = async () => {
    for (const proxy of proxies) proxy.kill();
    await fixture.close();
  };
  return { api, control, messages, play, told, handOff, close };
}

it("reports an account's weekly limit with its reset to the person and the Chief, never as setup or an update", async () => {
  const { api, control, messages, play, told, close } = await launch();
  try {
    const chief = (await control(["new-bot", "--name", "Tango", "--section", "Ops"])).bot;
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true });
    const pesto = (await control(["new-bot", "--name", "Pesto", "--section", "Ops"])).bot;
    play(pesto.id, "usage-limit", weekly(Math.floor(Date.now() / 1000) + 3 * 86_400));

    await control(["send", "--bot", pesto.id, "--text", "Hey talk to @Tango"]);
    await expect.poll(async () => (await messages(pesto.activeTaskId)).some((m) => m.kind === "activity" && m.tool?.ok === false), { timeout: 20_000 }).toBe(true);
    const thread = await messages(pesto.activeTaskId);
    const failed = thread.filter((m) => m.kind === "activity" && m.tool?.ok === false);
    // one plain line: which limit and when it resets; no sign-in or update card
    expect(failed).toHaveLength(1);
    expect(failed[0].tool.name).toMatch(/^error: This Claude account has reached its weekly limit, which resets .+\. Until then, switch this bot to another engine or Claude account\.$/);
    expect(failed[0].tool).not.toHaveProperty("setup");
    expect(failed[0].tool).not.toHaveProperty("claudeUpdate");
    // the CLI's words are not passed off as Pesto's reply
    expect(thread.some((m) => m.role === "bot" && m.kind === "text" && /hit your weekly limit/.test(m.text ?? ""))).toBe(false);

    // The Chief hears the same cause, not a stop token, and not "setup".
    await expect.poll(async () => (await api("GET", "/api/bots")).bots.find((b: any) => b.id === chief.id)?.tasks?.some((t: any) => t.title === "Team incidents"), { timeout: 20_000 }).toBe(true);
    const incidents = (await api("GET", "/api/bots")).bots.find((b: any) => b.id === chief.id).tasks.find((t: any) => t.title === "Team incidents");
    await expect.poll(async () => (await messages(incidents.threadId)).find((m) => m.kind === "activity" && (m.tool?.name ?? "").startsWith("Incident: "))?.tool.name, { timeout: 20_000 })
      .toMatch(/^Incident: Pesto's run .+ failed: "This Claude account has reached its weekly limit, which resets /);
    await expect.poll(() => told(incidents.threadId, chief.id), { timeout: 20_000 }).toMatch(LIMIT_WITH_RESET);
    expect(told(incidents.threadId, chief.id)).not.toMatch(/stop_sequence|update_required|"quota"/);
  } finally {
    await close();
  }
}, 120_000);

// What the Chief hears when it hands that teammate work itself. The CLI's
// words used to come back as the teammate's reply; with them gone from the
// reply, the bare stop token ("quota") must not take their place.
it("tells a Chief whose teammate is past its weekly limit which limit it is and when it resets", async () => {
  const { control, handOff, close } = await launch();
  try {
    const chief = (await control(["new-bot", "--name", "Tango", "--section", "Ops"])).bot;
    const pesto = (await control(["new-bot", "--name", "Pesto", "--section", "Ops"])).bot;
    const resumed = await handOff(chief.activeTaskId, chief, pesto, () => control(["send", "--bot", chief.id, "--text", "Have Pesto draft the launch note."]));
    expect(resumed).toMatch(LIMIT_WITH_RESET);
    expect(resumed).not.toMatch(/\bquota\b|stop_sequence|update_required/);
  } finally {
    await close();
  }
}, 120_000);

// …and in a room, where the coordinator waits on the teammate's member turn
// and reads its end after the transcript has taken it in.
it("tells a room's coordinator that a teammate is past its weekly limit, with the reset", async () => {
  const { api, control, handOff, close } = await launch();
  try {
    const chief = (await control(["new-bot", "--name", "Tango", "--section", "Ops"])).bot;
    const pesto = (await control(["new-bot", "--name", "Pesto", "--section", "Ops"])).bot;
    const room = (await api("POST", "/api/groups", {
      name: "Launch", memberIds: [chief.id, pesto.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: chief.id } },
    })).group;
    const resumed = await handOff(room.threadId, chief, pesto, () => api("POST", `/api/groups/${room.id}/messages`, { text: "Tango, have Pesto draft the launch note." }));
    expect(resumed).toMatch(LIMIT_WITH_RESET);
    expect(resumed).not.toMatch(/\bquota\b|stop_sequence|update_required/);
  } finally {
    await close();
  }
}, 120_000);

it("goes on in a new session started from the chat when Claude cannot reopen the old one, and says so", async () => {
  const { control, messages, play, close } = await launch();
  try {
    const marketer = (await control(["new-bot", "--name", "Marketer"])).bot;
    // the CLI ends between turns, so the next one resumes the session
    play(marketer.activeTaskId, "happy", { FAKE_CLAUDE_EXIT_AFTER_TURN: "1" });
    await control(["send", "--bot", marketer.id, "--text", "Remember the launch is on Friday."]);
    expect((await control(["wait", "--bot", marketer.id, "--timeout", "30"])).status).toBe("settled");

    // weeks later: the CLI answers that resume with an error result, no exit
    play(marketer.activeTaskId, "stale-session");
    await control(["send", "--bot", marketer.id, "--text", "what this"]);
    expect((await control(["wait", "--bot", marketer.id, "--timeout", "30"])).status).toBe("settled");
    const thread = await messages(marketer.activeTaskId);
    const after = thread.slice(thread.findIndex((m) => m.role === "user" && m.text?.includes("what this")));
    expect(after.filter((m) => m.kind === "activity" && (m.tool?.name ?? "").startsWith("notice: ")).map((m) => m.tool.name)).toEqual([
      `notice: ${rebuiltSessionNotice("Claude Code")}`,
    ]);
    expect(after.some((m) => m.kind === "activity" && m.tool?.ok === false)).toBe(false);
    expect(after.some((m) => m.role === "bot" && m.kind === "text" && m.text)).toBe(true);
  } finally {
    await close();
  }
}, 120_000);
