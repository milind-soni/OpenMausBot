// An upgrade, end to end: bots with skills of their own start a server that has one skills library, and every bot keeps
// exactly the skills it had, switched as they were.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const SKILL = (name: string, body: string) => `---\nname: ${name}\ndescription: Works with ${name}.\n---\n\n${body}\n`;

describe("the first start with one skills library", () => {
  let home = "";
  let data = "";
  let child: ChildProcess | null = null;
  let base = "";
  let output = "";

  async function start() {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    output = "";
    const proc = spawn(process.execPath, ["--experimental-strip-types", join(SERVER_DIR, "index.ts")], {
      cwd: ROOT,
      env: {
        PATH: dirname(process.execPath), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: home, USERPROFILE: home, OMB_DATA_DIR: data, APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata"),
        OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1), OMB_TEST_SEALED_PATH: "1", FAKE_CLAUDE_MODE: "happy",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = proc;
    proc.stdout!.on("data", (chunk) => { output += chunk; });
    proc.stderr!.on("data", (chunk) => { output += chunk; });
    const end = Date.now() + 30_000;
    for (;;) {
      if (proc.exitCode !== null) throw new Error(`server exited during boot:\n${output}`);
      try {
        if ((await fetch(`${base}/api/health`)).ok) return;
      } catch {}
      if (Date.now() > end) throw new Error(`server did not start:\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async function stop() {
    if (!child) return;
    const proc = child;
    child = null;
    await waitForExit(proc, { signal: "SIGTERM" });
  }

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const response = await fetch(base + path, {
      method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const own = (botId: string, name: string, body: string, enabled: boolean, source = "github.com/acme/skills/" + name) =>
    api("POST", `/api/bots/${botId}/skill-template`, { name, description: `Works with ${name}.`, source, text: SKILL(name, body), enabled });
  const text = async (botId: string, name: string) => (await api("GET", `/api/bots/${botId}/skills/${name}`)).body.text as string | undefined;
  /** The skill names a bot's next turn lists. */
  const index = async (botId: string) => [...((await api("GET", `/api/bots/${botId}/system-prompt`)).body.sections as Array<{ id: string; text: string }>)
    .find((section) => section.id === "skills")?.text.matchAll(/^- ([a-z0-9-]+):/gm) ?? []].map((match) => match[1]).sort();
  const rows = async () => Object.fromEntries(((await api("GET", "/api/skills")).body.skills as Array<{ id: string; who: string; bots: string[] }>)
    .filter((row) => !row.id.startsWith("builtin:")).map((row) => [row.id, { who: row.who, bots: [...row.bots].sort() }]));

  beforeAll(() => {
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-skills-boot-"));
    data = join(home, "data");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "config.json"), JSON.stringify({
      features: { smartSetupChoices: false },
      instances: { claude: { driver: "claudeAgent", config: { cli: FAKE_CLI } } },
    }));
  });
  afterAll(async () => {
    await stop();
    if (home) await removeTempDir(home);
  });

  it("moves each bot's own skills into the library, keeps who had what, and loses nothing", async () => {
    await start();
    const [pepper, scout, atlas] = await Promise.all(["Pepper", "Scout", "Atlas"].map(async (name) => (await api("POST", "/api/bots", { name })).body.bot.id as string));
    expect((await own(pepper!, "weekly-report", "Collect the wins.", true)).status).toBe(201);
    expect((await own(pepper!, "draft-notes", "Draft first.", false)).status).toBe(201);
    expect((await own(scout!, "weekly-report", "Collect the wins.", true)).status).toBe(201);
    expect((await own(scout!, "invoice-check", "Compare totals.", true)).status).toBe(201);
    expect((await own(atlas!, "weekly-report", "Atlas writes it its own way.", true)).status).toBe(201);
    const before = Object.fromEntries(await Promise.all([pepper!, scout!, atlas!].map(async (botId) => [botId, await index(botId)] as const)));
    await stop();

    await start();
    expect(output).toMatch(/\[skills-library\] boot sweep: \d+ skill\(s\) migrated or deduplicated/);
    for (const botId of [pepper!, scout!]) expect(await text(botId, "weekly-report")).toBe(SKILL("weekly-report", "Collect the wins."));
    expect(await text(atlas!, "weekly-report")).toBe(SKILL("weekly-report", "Atlas writes it its own way."));
    expect(await text(scout!, "invoice-check")).toBe(SKILL("invoice-check", "Compare totals."));

    const after = await rows();
    const weekly = after["library:weekly-report"]?.bots.includes(atlas!)
      ? { library: [atlas!], kept: [pepper!, scout!].sort() }
      : { library: [pepper!, scout!].sort(), kept: [atlas!] };
    expect(after["library:weekly-report"]).toEqual({ who: "bots", bots: weekly.library });
    expect(after["bot:weekly-report"]).toEqual({ who: "bots", bots: weekly.kept });
    expect(after["library:invoice-check"]).toEqual({ who: "bots", bots: [scout] });
    expect(after["library:draft-notes"]).toEqual({ who: "off", bots: [] });

    for (const botId of [pepper!, scout!, atlas!]) expect(await index(botId)).toEqual(before[botId]);
    expect(before[pepper!]).toEqual(["weekly-report"]);
    expect(before[scout!]).toEqual(["invoice-check", "weekly-report"]);
    expect(existsSync(join(data, "skills-library", "archive", scout!, "invoice-check", "SKILL.md"))).toBe(true);
    const stored = JSON.parse(readFileSync(join(data, "bots.json"), "utf8")) as Array<{ id: string; assignedSkills?: string[] }>;
    expect(stored.find((bot) => bot.id === scout)?.assignedSkills).toEqual(expect.arrayContaining(["invoice-check"]));
    await stop();

    await start();
    expect(await rows()).toEqual(after);
    await stop();
  }, 120_000);
});
