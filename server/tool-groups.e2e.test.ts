// End to end on a disposable server and the real agents proxy: a bot's person turns Meetings and Pages off, and that
// bot's next turn is listed neither while its teammate keeps both; turning Data off takes its server out of the turn.
// One loopback stub stands in for Boat (so this server has meetings) and for the image provider. No network.
import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";

const MEETINGS = ["join_meeting", "meeting_status", "post_in_meeting_chat", "leave_meeting", "post_meeting_notes"];
const PAGES = ["show_html", "publish_page", "unpublish_page", "share"];

it("lists a bot none of the groups its person turned off, from its next turn, and leaves other bots alone", async () => {
  const stub = createServer((_req, res) => { res.writeHead(404, { "content-type": "application/json" }); res.end("{}"); });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const stubUrl = `http://127.0.0.1:${(stub.address() as { port: number }).port}`;
  const session = await launchVerificationServer({ ...process.env, OMB_FAKE_IMAGE_API_URL: `${stubUrl}/v1` }, undefined, undefined, undefined, undefined, { scripted: true }, [], stubUrl);
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: session.info.url } }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") =>
    request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
  const planPath = join(session.info.dataDir, "room-plan.json");
  const evidenceFor = (botId: string) => {
    const lines = existsSync(`${planPath}.evidence.jsonl`) ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean) : [];
    return lines.map((line) => JSON.parse(line)).filter((entry: any) => entry.botId === botId).at(-1);
  };
  /** One turn with no tool steps: the tools its agents server listed, and what its engine was started with. */
  const turn = async (bot: any) => {
    writeFileSync(planPath, JSON.stringify({ [bot.id]: { steps: [], reply: "Done." } }));
    await cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Hello.");
    expect((await cli("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30")).status).toBe("settled");
    const launch = JSON.parse(readFileSync(session.fixtureDumpPath, "utf8"));
    return { tools: evidenceFor(bot.id).evidence[0].result.tools.map((tool: any) => tool.name) as string[], launch };
  };
  try {
    const groups = (await api("/api/config", undefined, "GET")).toolGroups as string[];
    expect(groups).toEqual(expect.arrayContaining(["meetings", "pages", "images"]));
    expect(groups).not.toContain("email");
    const quiet = (await cli("new-bot", "--name", "Quiet")).bot, busy = (await cli("new-bot", "--name", "Busy")).bot;
    for (const bot of [quiet, busy]) await api(`/api/bots/${bot.id}`, { computer: "off" }, "PATCH");

    const before = await turn(quiet);
    expect(before.tools).toEqual(expect.arrayContaining([...MEETINGS, ...PAGES, "generate_image"]));
    expect(before.launch.systemPrompt).not.toContain("turned off some of your tools");

    const saved = await api(`/api/bots/${quiet.id}`, { toolsOff: ["pages", "meetings"] }, "PATCH");
    expect(saved.bot.toolsOff).toEqual(["meetings", "pages"]);
    const after = await turn(quiet);
    for (const tool of [...MEETINGS, ...PAGES]) expect(after.tools).not.toContain(tool);
    expect(after.tools).toEqual(before.tools.filter((tool) => !MEETINGS.includes(tool) && !PAGES.includes(tool)));
    expect(after.launch.systemPrompt).toContain("turned off some of your tools to keep requests small: Meetings, Pages and apps.");

    const other = await turn(busy);
    expect(other.tools).toEqual(before.tools);
    expect(other.launch.systemPrompt).not.toContain("turned off some of your tools");

    if (groups.includes("data")) {
      expect(Object.keys(after.launch.mcpConfig.mcpServers)).toContain("data");
      await api(`/api/bots/${quiet.id}`, { toolsOff: ["data"] }, "PATCH");
      const dataOff = await turn(quiet);
      expect(Object.keys(dataOff.launch.mcpConfig.mcpServers)).not.toContain("data");
      expect(dataOff.tools).toEqual(expect.arrayContaining([...MEETINGS, ...PAGES]));
    }

    await api(`/api/bots/${quiet.id}`, { toolsOff: [] }, "PATCH");
    expect((await turn(quiet)).tools).toEqual(before.tools);
  } finally {
    stub.close();
    await session.close();
  }
}, 180_000);
