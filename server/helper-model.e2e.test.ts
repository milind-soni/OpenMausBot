// POSIX-gated like the other CLI e2es: the fakes are shebang scripts.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CAPTURE_MARKER } from "./memory-capture.ts";
import { NO_TEXT_ENGINE } from "./memory-upkeep.ts";
import { SKILL_REVIEW_MARKER } from "./skill-review.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const fake = (name: string) => join(SERVER_DIR, "testing", name);
const FAKES = ["fake-claude-cli.ts", "fake-codex-app-server.ts", "fake-pi-cli.ts"];
const posixOnly = describe.skipIf(process.platform === "win32");

const SKILL_MD = "---\nname: weekly-report\ndescription: Writes the weekly status report.\n---\n\n# Weekly report\n\nWrites the weekly status report from the project notes.\n\n## When to Use\n- \"write the weekly report\"\n\n## Procedure\n1. Read the notes.\n2. Keep it to five bullets.\n\n## Pitfalls\n- Long reports go unread: stop at five bullets.\n\n## Verification\n- Count the bullets.\n";

interface Msg {
  id: string;
  tool?: { name: string };
  role: string;
  kind: string;
  text?: string;
  compaction?: { summary: string };
  card?: { title?: string; answered?: string; skillRequest?: { name: string } };
}
interface Row {
  botId: string;
  threadId: string;
  instanceId: string;
  driverKind: string;
  model: string;
  trigger: { kind: string; botId?: string; job?: string };
}

/** One isolated server in a throwaway home, with the fake engines and
 * whatever else the test puts in config.json. */
async function boot(extraConfig: Record<string, unknown>) {
  for (const name of FAKES) chmodSync(fake(name), 0o755);
  const port = 18800 + Math.floor(Math.random() * 10_000);
  const base = `http://127.0.0.1:${port}`;
  const home = mkdtempSync(join(tmpdir(), "omb-helper-model-"));
  mkdirSync(join(home, ".openmausbot"), { recursive: true });
  const routes = join(home, "one-shot-routes.json");
  writeFileSync(routes, JSON.stringify({
    [CAPTURE_MARKER]: JSON.stringify([{ text: "The person is vegetarian", kind: "preference", aboutUser: true, confidence: 0.9 }]),
    [SKILL_REVIEW_MARKER]: JSON.stringify({ changes: [{ action: "create", skill_md: SKILL_MD, gist: "Five-bullet weekly report." }] }),
  }));
  writeFileSync(join(home, ".openmausbot", "config.json"), JSON.stringify({
    instances: {
      claude: { driver: "claudeAgent", config: { cli: fake("fake-claude-cli.ts"), permissionMode: "bypassPermissions" } },
      codex: { driver: "codex", config: { cli: fake("fake-codex-app-server.ts") } },
      pi: { driver: "piAgent", environment: { FAKE_PI_MODE: "tooluse" }, config: { cli: fake("fake-pi-cli.ts"), fullAuto: true } },
    },
    memory: { captureQuietMs: 1_000 },
    ...extraConfig,
  }));
  let stderr = "";
  const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, OMB_PORT: String(port), FAKE_CLAUDE_TEXT_ROUTES: routes };
  if (process.env.PATH) env.PATH = process.env.PATH;
  const child: ChildProcess = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], { cwd: join(SERVER_DIR, ".."), env, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  let stdout = "";
  child.stdout!.on("data", (chunk) => (stdout += chunk));

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  // Generous on purpose: every wait ends the moment its condition holds, and
  // a busy machine starts each fake CLI slowly.
  const waitFor = async (predicate: () => Promise<boolean> | boolean, what: string, ms = 60_000) => {
    const deadline = Date.now() + ms;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-3000)}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  };
  const close = async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  };
  try {
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; }
    }, "the server to come up");
  } catch (error) {
    // a server that never answered is still this test's to stop
    await close();
    throw error;
  }

  const getBot = async (id: string) => (await api("GET", "/api/bots")).body.bots.find((bot: any) => bot.id === id) as { busy: boolean; messages: Msg[] };
  const newBot = async (instanceId: string) => {
    const created = (await api("POST", "/api/bots")).body.bot as { id: string; threadId: string };
    expect((await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId, model: "fake-model" } })).status).toBe(200);
    return created;
  };
  /** One turn, sent and settled with its reply. */
  const turn = async (bot: { id: string }, text: string) => {
    const before = (await getBot(bot.id)).messages.filter((message) => message.role === "bot" && message.kind === "text").length;
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text })).status).toBe(202);
    await waitFor(async () => {
      const current = await getBot(bot.id);
      return !current.busy && current.messages.filter((message) => message.role === "bot" && message.kind === "text").length > before;
    }, `a turn of ${bot.id} to settle`);
  };
  const ledger = (botId: string): Row[] => {
    const file = join(home, ".openmausbot", "usage", `${new Date().toISOString().slice(0, 7)}.jsonl`);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row).filter((row) => row.botId === botId);
  };
  const memory = async (botId: string) => ((await api("GET", `/api/bots/${botId}/memory/file?path=MEMORY.md`)).body?.text ?? "") as string;
  return { api, waitFor, getBot, newBot, turn, ledger, memory, close, log: () => stdout, dataDir: join(home, ".openmausbot") };
}

async function unsupportedCheckpoint(server: Awaited<ReturnType<typeof boot>>, bot: { id: string; threadId: string }) {
  const content = (messages: Msg[]) => messages.filter(message => message.kind === "text")
    .map(({ id, role, kind, text }) => ({ id, role, kind, text }));
  const before = content((await server.getBot(bot.id)).messages);
  expect(before.length).toBeGreaterThan(0);
  const cursor = () => (JSON.parse(readFileSync(join(server.dataDir, "bots.json"), "utf8")) as any[])
    .find(record => record.id === bot.id)?.tasks.find((task: any) => task.threadId === bot.threadId)?.resumeCursors;
  const priorCursor = cursor();
  expect((await server.api("POST", `/api/bots/${bot.id}/compact`, { threadId: bot.threadId })).status).toBe(202);
  await server.waitFor(async () => {
    const current = await server.getBot(bot.id);
    return !current.busy && current.messages.some(message => message.tool?.name.includes("does not support tool-free streaming checkpoints; original history retained"));
  }, "the unsupported checkpoint response");
  const after = (await server.getBot(bot.id)).messages;
  expect(content(after)).toEqual(before);
  expect(after.filter(message => message.kind === "compaction")).toEqual([]);
  expect(cursor()).toEqual(priorCursor);
  expect(server.ledger(bot.id).some(row => row.trigger.job === "compaction")).toBe(false);
  await server.turn(bot, "Continue after the unsupported checkpoint without dropping the earlier requirement.");
  expect(content((await server.getBot(bot.id)).messages).slice(0, before.length)).toEqual(before);
}

posixOnly("the helper model, through the real server", () => {
  let server: Awaited<ReturnType<typeof boot>>;
  beforeAll(async () => {
    server = await boot({
      helper: { instanceId: "claude", model: "claude-haiku-5-5" },
      features: { skillReview: true, skillReviewSteps: 3 },
    });
  }, 90_000);
  afterAll(async () => { await server?.close(); });

  const helperRow = (job: string) => expect.objectContaining({
    instanceId: "claude", driverKind: "claudeAgent", model: "claude-haiku-5-5", threadId: expect.stringMatching(new RegExp(`^${job}-`)),
    trigger: expect.objectContaining({ kind: "helper", job }),
  });
  const unsupported = (bot: { id: string; threadId: string }) => unsupportedCheckpoint(server, bot);

  it("keeps Pi memory and skill helpers working while unsupported checkpoints preserve history", async () => {
    const { api, waitFor, getBot, newBot, turn, ledger, memory } = server;
    const bot = await newBot("pi");
    expect((await api("GET", `/api/bots/${bot.id}/memory/upkeep`)).body).toMatchObject({ enabled: true, modelSteps: true });
    // one tool step a turn: three reach the review threshold
    for (const text of ["Just so you know, I'm vegetarian.", "Write the weekly report from the notes.", "Shorter please, five bullets at most."]) await turn(bot, text);

    await waitFor(async () => (await memory(bot.id)).includes("The person is vegetarian"), "the helper to capture the fact");
    await waitFor(() => ledger(bot.id).some((row) => row.trigger.job === "memory"), "the capture call to be booked");
    expect(ledger(bot.id)).toContainEqual(helperRow("memory"));
    // the turns themselves stay the Pi engine's, booked to whoever asked
    expect(ledger(bot.id)).toContainEqual(expect.objectContaining({ driverKind: "piAgent", threadId: bot.threadId, trigger: { kind: "owner" } }));

    await waitFor(async () => (await getBot(bot.id)).messages.some((message) => message.card?.skillRequest?.name === "weekly-report"), "the skill receipt");
    expect((await getBot(bot.id)).messages.find((message) => message.card?.skillRequest)!.card).toMatchObject({ answered: "allow", title: 'Skill "weekly-report" enabled' });
    await waitFor(() => ledger(bot.id).some((row) => row.trigger.job === "skill-review"), "the review call to be booked");
    expect(ledger(bot.id)).toContainEqual(helperRow("skill-review"));

    await unsupported(bot);

    // read on its own in the usage summary, apart from the person's turns
    const byPerson = (await api("GET", "/api/usage?groupBy=user")).body.groups as Array<{ key: string; label: string }>;
    expect(byPerson.find((group) => group.key === "helper")).toMatchObject({ label: "Helper model" });
    expect(server.log()).toContain('helper model: small writing jobs for bots whose engine has no one-off text call are written by "claude" (claude-haiku-5-5)');
  }, 300_000);

  it("persists the helper opt-out and refuses invalid values while preserving unsupported checkpoint history", async () => {
    const { api, waitFor, getBot, newBot, turn, ledger, memory, dataDir } = server;
    const bot = await newBot("pi");
    const upkeep = async () => (await api("GET", `/api/bots/${bot.id}/memory/upkeep`)).body;
    expect(await upkeep()).toMatchObject({ modelSteps: true });

    for (const wrong of ["no", 0, null, { off: true }]) {
      const refused = await api("PATCH", `/api/bots/${bot.id}`, { helperModel: wrong });
      expect(refused.status, JSON.stringify(wrong)).toBe(400);
      expect(refused.body.error).toBe("helperModel must be true or false");
    }
    expect(await getBot(bot.id)).not.toHaveProperty("helperModel");

    const saved = await api("PATCH", `/api/bots/${bot.id}`, { helperModel: false });
    expect(saved.status).toBe(200);
    expect(saved.body.bot).toMatchObject({ id: bot.id, helperModel: false });
    expect(await getBot(bot.id)).toMatchObject({ helperModel: false });
    const onDisk = () => (JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8")) as Array<{ id: string; helperModel?: boolean }>).find((record) => record.id === bot.id);
    expect(onDisk()).toMatchObject({ helperModel: false });

    // memory upkeep: the panel's answer is the one a server with no helper gives, and the capture that comes due is refused
    expect(await upkeep()).toMatchObject({ modelSteps: false });
    for (const text of ["Just so you know, I'm vegetarian.", "Write the weekly report from the notes.", "Shorter please, five bullets at most."]) await turn(bot, text);
    await waitFor(async () => (await upkeep()).lastCapture?.note === NO_TEXT_ENGINE, "the capture to be refused for want of an engine");
    expect(await memory(bot.id)).not.toContain("The person is vegetarian");
    // the skill review: three tool steps are due, and it is refused the same way
    await waitFor(() => server.log().includes(`skill review: ${bot.id}: this bot's engine cannot run a background review`), "the review to be refused");
    expect((await getBot(bot.id)).messages.some((message) => message.card?.skillRequest)).toBe(false);
    await unsupported(bot);
    expect(ledger(bot.id).some((row) => row.trigger.kind === "helper")).toBe(false);

    // switched back, the helper may write for it again
    expect((await api("PATCH", `/api/bots/${bot.id}`, { helperModel: true })).status).toBe(200);
    expect(onDisk()).toMatchObject({ helperModel: true });
    expect(await upkeep()).toMatchObject({ modelSteps: true });
  }, 300_000);

  it("creates a bot already kept off the helper when the creation request says so, which is how a duplicate keeps its source's switch", async () => {
    const { api, getBot, dataDir } = server;
    // the body src/lib/bot-duplicate.ts builds for a source with helperModel: false
    const created = await api("POST", "/api/bots", { settings: { helperModel: false } });
    expect(created.status).toBe(201);
    expect(created.body.bot).toMatchObject({ helperModel: false });
    const id = created.body.bot.id as string;
    // before any later request: on the wire and in the saved record
    expect(await getBot(id)).toMatchObject({ helperModel: false });
    expect((JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8")) as Array<{ id: string }>).find((record) => record.id === id)).toMatchObject({ helperModel: false });
    // the copy then takes its source's engine, and still has no model steps from the helper
    expect((await api("PATCH", `/api/bots/${id}`, { name: "Private copy", modelSelection: { instanceId: "pi", model: "fake-model" } })).status).toBe(200);
    expect((await api("GET", `/api/bots/${id}/memory/upkeep`)).body).toMatchObject({ modelSteps: false });
    expect((await api("POST", "/api/bots", { settings: { helperModel: "false" } })).status).toBe(400);
  }, 120_000);

  it("keeps Codex memory upkeep on its own background call without substituting an unvalidated checkpoint", async () => {
    const { api, waitFor, newBot, turn, ledger } = server;
    const bot = await newBot("codex");
    expect((await api("GET", `/api/bots/${bot.id}/memory/upkeep`)).body).toMatchObject({ enabled: true, modelSteps: true });
    await turn(bot, "Just so you know, I'm vegetarian.");
    await waitFor(() => ledger(bot.id).some((row) => row.threadId.startsWith("memory-")), "Codex's own capture call to be booked");
    expect(ledger(bot.id).filter((row) => row.threadId.startsWith("memory-")).every((row) => row.driverKind === "codex" && row.trigger.kind === "bot")).toBe(true);

    await unsupported(bot);
    expect(ledger(bot.id).filter((row) => row.trigger.kind === "helper")).toEqual([]);
  }, 240_000);

  it("leaves a Claude bot writing with its own engine and its own quick model", async () => {
    const { waitFor, newBot, turn, ledger, memory } = server;
    const bot = await newBot("claude");
    await turn(bot, "Just so you know, I'm vegetarian.");
    await waitFor(async () => (await memory(bot.id)).includes("The person is vegetarian"), "the bot's own capture");
    await waitFor(() => ledger(bot.id).some((row) => row.threadId.startsWith("memory-")), "the capture call to be booked");
    const background = ledger(bot.id).filter((row) => row.threadId.startsWith("memory-"));
    expect(background.every((row) => row.trigger.kind === "bot" && row.model === "claude-haiku-4-5")).toBe(true);
    expect(ledger(bot.id).some((row) => row.trigger.kind === "helper")).toBe(false);
  }, 180_000);
});

posixOnly("without a helper model, through the real server", () => {
  let server: Awaited<ReturnType<typeof boot>>;
  beforeAll(async () => { server = await boot({}); }, 90_000);
  afterAll(async () => { await server?.close(); });

  it("keeps Pi history intact without a helper or checkpoint capability", async () => {
    const { api, newBot, turn, ledger } = server;
    const bot = await newBot("pi");
    expect((await api("GET", `/api/bots/${bot.id}/memory/upkeep`)).body).toMatchObject({ enabled: true, modelSteps: false });
    await turn(bot, "Just so you know, I'm vegetarian.");
    await unsupportedCheckpoint(server, bot);
    expect(ledger(bot.id).some((row) => row.trigger.kind === "helper")).toBe(false);
    expect(server.log()).not.toContain("helper model:");
  }, 180_000);

  it("follows the setting in config.json as the file changes, on and off, without a restart", async () => {
    const { api, waitFor, newBot, dataDir } = server;
    const bot = await newBot("pi");
    const modelSteps = async () => (await api("GET", `/api/bots/${bot.id}/memory/upkeep`)).body.modelSteps as boolean;
    expect(await modelSteps()).toBe(false);
    const file = join(dataDir, "config.json");
    const write = (change: (config: Record<string, unknown>) => void) => {
      const config = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      change(config);
      writeFileSync(file, JSON.stringify(config));
    };
    write((config) => { config.helper = { instanceId: "claude" }; });
    await waitFor(modelSteps, "the helper named in the file to be used");
    // a settings request cannot name or clear a helper: alone it is nothing
    // to save, and beside a real setting it is dropped while the file keeps its helper
    expect(await api("PATCH", "/api/config", { helper: { instanceId: "" } })).toMatchObject({ status: 400, body: { error: "nothing to save" } });
    expect((await api("PATCH", "/api/config", { helper: { instanceId: "" }, language: "en" })).status).toBe(200);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ helper: { instanceId: "claude" }, language: "en" });
    expect(await modelSteps()).toBe(true);
    write((config) => { delete config.helper; });
    await waitFor(async () => !(await modelSteps()), "the helper taken out of the file to stop being used");
  }, 120_000);
});
