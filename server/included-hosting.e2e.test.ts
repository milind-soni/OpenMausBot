// End-to-end coverage for the plan's included app hosting on a real server and a real agents proxy: which bots are shown
// publish_app, a bot publishing a folder of its own through the server, the Published apps list and its count, and
// where the relay token goes (only to the relay). A loopback stand-in is the Admin's relay and serves the published
// apps; nothing here reaches the real Admin or Netlify.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";
import { SITE_FILE } from "./host/netlify-sites.ts";
import { startFakeAppHosting, type FakeAppHosting } from "./testing/fake-app-hosting.ts";

const TOKEN = "omb_host_e2e_fixture_token_0123456789abcdef";
const HOSTING_TOOLS = ["publish_app", "check_app_hosting"];

interface Fixture {
  fake: FakeAppHosting;
  dataDir: string;
  logPath: string;
  api(path: string, body?: unknown, method?: string): Promise<any>;
  engineLaunch(): string;
  newBot(name: string): Promise<any>;
  workspace(bot: { id: string }): string;
  /** Runs one turn of `bot` with these tool steps. `refusals`: some step is refused, which the scripted engine ends its turn as failed for. */
  turn(bot: any, steps: Array<{ tool: string; arguments: unknown }>, options?: { refusals?: boolean; task?: string }): Promise<{ evidence: string; tools: string[]; results: Array<{ error: boolean; text: string }> }>;
}

async function withFixture(test: (f: Fixture) => Promise<void>, options: { hosting: boolean; apps?: number }) {
  const fake = await startFakeAppHosting(TOKEN, { apps: options.apps ?? 10 });
  const env = options.hosting ? { OMB_CLOUD_HOSTING_URL: fake.url, OMB_CLOUD_HOSTING_TOKEN: TOKEN } : {};
  const session = await launchVerificationServer({ ...process.env, ...env }, undefined, undefined, undefined, undefined, { scripted: true });
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: session.info.url } }) as Promise<any>;
  const planPath = join(session.info.dataDir, "room-plan.json");
  const turnFor = (botId: string) => {
    const lines = existsSync(planPath + ".evidence.jsonl") ? readFileSync(planPath + ".evidence.jsonl", "utf8").trim().split("\n").filter(Boolean) : [];
    return lines.map((line) => JSON.parse(line)).filter((entry: any) => entry.botId === botId).at(-1);
  };
  try {
    await test({
      fake, dataDir: session.info.dataDir, logPath: session.info.logPath,
      api: (path, body, method = "POST") => request(path, body === undefined ? { method } : { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>,
      engineLaunch: () => readFileSync(session.fixtureDumpPath, "utf8"),
      newBot: async (name) => (await cli("new-bot", "--name", name)).bot,
      workspace: (bot) => join(session.info.dataDir, "workspaces", bot.id),
      turn: async (bot, steps, { refusals = false, task = bot.activeTaskId } = {}) => {
        writeFileSync(planPath, JSON.stringify({ [bot.id]: { steps, reply: "Done." } }));
        await cli("send", "--bot", bot.id, "--task", task, "--text", "Publish it.");
        expect((await cli("wait", "--bot", bot.id, "--task", task, "--timeout", "60")).status).toBe(refusals ? "failed" : "settled");
        const evidence = turnFor(bot.id).evidence;
        return {
          evidence: JSON.stringify(evidence),
          tools: evidence[0].result.tools.map((tool: any) => tool.name) as string[],
          results: evidence.filter((entry: any) => entry.step).map((entry: any) => ({ error: entry.response.result.isError === true, text: String(entry.response.result.content[0].text) })),
        };
      },
    });
  } finally {
    await session.close();
    await fake.stop();
  }
}

function site(folder: string, title: string) {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "index.html"), `<!doctype html><title>${title}</title><h1>${title}</h1>`);
  writeFileSync(join(folder, ".env"), "API_KEY=never-published");
}

/** Every regular file under `dir`, as text: where a leaked token would have to be. */
function everyFile(dir: string): string {
  let text = "";
  for (const name of readdirSync(dir)) {
    const full = join(dir, name), info = statSync(full, { throwIfNoEntry: false });
    if (info?.isDirectory()) text += everyFile(full);
    else if (info?.isFile() && info.size < 5_000_000) text += readFileSync(full, "latin1");
  }
  return text;
}

it("shows no hosting tools and no count on a server the Admin gave no included hosting", async () => withFixture(async (f) => {
  const bot = await f.newBot("Own Netlify");
  const { tools } = await f.turn(bot, []);
  for (const tool of HOSTING_TOOLS) expect(tools).not.toContain(tool);
  expect(await f.api("/api/published-apps", undefined, "GET")).toEqual({ apps: [] });
  expect(f.fake.requests).toEqual([]);
}, { hosting: false }), 120_000);

it("lets a bot publish a folder of its own through the server, lists it with the plan's count, and keeps the token on the server", async () => withFixture(async (f) => {
  const bot = await f.newBot("Publisher"), other = await f.newBot("Neighbour");
  site(join(f.workspace(bot), "bakery"), "Bakery order page");
  site(join(f.workspace(other), "private-site"), "Neighbour's draft");

  const { tools, results, evidence } = await f.turn(bot, [
    { tool: "check_app_hosting", arguments: {} },
    { tool: "publish_app", arguments: { path: "bakery", title: "Bakery order page" } },
    { tool: "check_app_hosting", arguments: { path: "bakery" } },
  ]);
  expect(tools).toEqual(expect.arrayContaining(HOSTING_TOOLS));
  expect(results.map((result) => result.error)).toEqual([false, false, false]);
  expect(JSON.parse(results[0]!.text)).toEqual({ ok: true, apps: "0 of 10", publishesThisMonth: "0 of 200", limits: "25 MB and 500 files an app, 8 MB a file", projects: [] });
  const published = JSON.parse(results[1]!.text);
  expect(published).toMatchObject({ ok: true, state: "ready", live: true, created: true, files: 1, uploaded: 1, skipped: [".env"], apps: "1 of 10", publishesThisMonth: "1 of 200" });
  expect(await (await fetch(published.url)).text()).toContain("<h1>Bakery order page</h1>");
  expect(JSON.parse(results[2]!.text)).toMatchObject({ ok: true, state: "ready", live: true, title: "Bakery order page", apps: "1 of 10" });

  // A hostile bot asks for its neighbour's folder, by its full path and by climbing out of its own.
  for (const path of [join(f.workspace(other), "private-site"), `../${other.id}/private-site`]) {
    const refused = await f.turn(bot, [{ tool: "publish_app", arguments: { path, title: "Mine now" } }], { refusals: true });
    expect(refused.results).toEqual([{ error: true, text: "Only a folder inside your own working folder can be published. Build the app there first." }]);
  }
  expect(f.fake.apps.size).toBe(1);
  expect(existsSync(join(f.workspace(other), "private-site", SITE_FILE))).toBe(false);

  const record = JSON.parse(readFileSync(join(f.workspace(bot), "bakery", SITE_FILE), "utf8"));
  expect(record).toMatchObject({ version: 1, hosting: "included", url: published.url, title: "Bakery order page", botId: bot.id, deployState: "ready", access: "public" });
  expect(record.siteId).toBe(record.appKey);

  const listed = await f.api("/api/published-apps", undefined, "GET");
  expect(listed).toEqual({
    apps: [{ id: `included-${record.appKey}`, source: "included", title: "Bakery order page", url: published.url, bot: { id: bot.id, name: "Publisher" },
      publishedAt: expect.any(Number), access: "public", canDelete: true }],
    included: { used: 1, max: 10 },
  });

  // The token went to the relay and nowhere a bot, a client or a reader of the disk could find it.
  expect(f.fake.refused).toEqual([]);
  const config = await f.api("/api/config", undefined, "GET");
  for (const [where, text] of Object.entries({ engine: f.engineLaunch(), evidence, list: JSON.stringify(listed), config: JSON.stringify(config), log: readFileSync(f.logPath, "utf8"), disk: everyFile(f.dataDir) })) {
    expect(text.includes(TOKEN), where).toBe(false);
  }
  expect(f.engineLaunch()).not.toContain("OMB_CLOUD_HOSTING");

  expect(await f.api("/api/published-apps/delete", { id: `included-${record.appKey}` })).toEqual({ ok: true });
  expect(f.fake.apps.size).toBe(0);
  expect(existsSync(join(f.workspace(bot), "bakery", SITE_FILE))).toBe(false);
  expect(await f.api("/api/published-apps", undefined, "GET")).toEqual({ apps: [], included: { used: 0, max: 10 } });
}, { hosting: true }), 180_000);

it("tells the bot in plain words when the plan's apps are used up, and publishes nothing", async () => withFixture(async (f) => {
  const bot = await f.newBot("Publisher");
  site(join(f.workspace(bot), "first"), "First");
  site(join(f.workspace(bot), "second"), "Second");
  expect((await f.turn(bot, [{ tool: "publish_app", arguments: { path: "first", title: "First" } }])).results[0]!.error).toBe(false);
  const full = await f.turn(bot, [{ tool: "publish_app", arguments: { path: "second", title: "Second" } }], { refusals: true });
  expect(full.results).toEqual([{ error: true, text: "The plan's included hosting is full: 1 of 1 apps are in use. The person can delete one on the Published apps page to make room. "
    + "Tell the person, and offer to publish on their own Netlify account instead (deploy.mjs in the publish-to-netlify skill)." }]);
  const removed = await f.turn(bot, [{ tool: "publish_app", arguments: { action: "delete", path: "first" } }]);
  expect(JSON.parse(removed.results[0]!.text)).toMatchObject({ ok: true, deleted: true, title: "First", apps: "0 of 1" });
  expect(f.fake.apps.size).toBe(0);
  expect(existsSync(join(f.workspace(bot), "second", SITE_FILE))).toBe(false);
}, { hosting: true, apps: 1 }), 180_000);

it("lets a second conversation with the same bot find the app in the bot's shared folder and publish it again to the same link", async () => withFixture(async (f) => {
  const bot = await f.newBot("Publisher");
  const project = join(f.workspace(bot), "sites", "bakery");
  site(project, "Bakery order page");
  const first = JSON.parse((await f.turn(bot, [{ tool: "publish_app", arguments: { path: "sites/bakery", title: "Bakery order page" } }])).results[0]!.text);
  expect(first).toMatchObject({ ok: true, live: true, created: true });
  expect(first).not.toHaveProperty("note");

  const { task } = await f.api(`/api/bots/${bot.id}/tasks`, { title: "A week later", select: false });
  expect(task.threadId).not.toBe(bot.activeTaskId);
  writeFileSync(join(project, "index.html"), "<!doctype html><title>Bakery</title><h1>Bakery, now with cakes</h1>");
  const later = await f.turn(bot, [
    { tool: "check_app_hosting", arguments: {} },
    { tool: "publish_app", arguments: { path: "sites/bakery", title: "Bakery order page" } },
  ], { task: task.threadId });
  expect(JSON.parse(later.results[0]!.text).projects).toEqual([{ title: "Bakery order page", folder: project, on: "included hosting" }]);
  expect(JSON.parse(later.results[1]!.text)).toMatchObject({ ok: true, live: true, created: false, url: first.url, apps: "1 of 10" });
  expect(f.fake.apps.size).toBe(1);
  expect(await (await fetch(first.url)).text()).toContain("now with cakes");
  expect((await f.api("/api/published-apps", undefined, "GET")).apps).toHaveLength(1);
}, { hosting: true }), 180_000);

