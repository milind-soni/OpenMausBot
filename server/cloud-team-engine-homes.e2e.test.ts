// A real Team Cloud with the Owner, an Admin (Ben) and a Member (Bob), whose engine keeps its own files in its HOME the
// way Claude Code does (the synthetic CLI's FAKE_CLAUDE_HOME_FILES): each audience's engine runs in its own engine home,
// signed in with the team's sign-in, so a shell in one person's chat never finds another's transcripts. No bot box runs
// here (it needs Linux bubblewrap: server/engine-homes/box.linux.test.ts proves the box side).
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { audienceHome } from "./engine-homes/layout.ts";
import { claudeProjectSlug } from "./engine-homes/migrate.ts";
import { personKey } from "./person-key.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const posix = process.platform !== "win32";
const TOKEN = `ops_fake-team-homes-${randomBytes(8).toString("hex")}`;
const OWNER = { email: "olive@acme.test", role: "owner" as const };
const ADMIN = { email: "ben@acme.test", role: "admin" as const };
const BOB = { email: "bob@acme.test", role: "member" as const };
const HOME_FILES = `import { readFileSync as readToolCalls } from "node:fs";
process.env.FAKE_CLAUDE_DUMP = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/dump.json";
process.env.FAKE_CLAUDE_SHELL_LOG = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/shell.jsonl";
process.env.FAKE_CLAUDE_HOME_FILES = "1";
process.env.FAKE_CLAUDE_RUN_BASH = "1";
process.env.FAKE_CLAUDE_EXIT_AFTER_TURN = "1";
try { process.env.FAKE_CLAUDE_TOOL_CALLS = readToolCalls(process.env.FAKE_CLAUDE_FIXTURE_DIR + "/tool-calls.json", "utf8"); } catch {}`;

let fx: CloudSendFixture, team: CloudTeamFixture;
let owner = "", admin = "", bob = "";
let bot: { id: string; mainThreadId: string };
let dataDir = "", bobHome = "", ownerHome = "", bobThread = "", bobSession = "";

const credentials = (home: string, token: string, expiresAt = Date.now() + 86_400_000) => {
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: "r", expiresAt } }));
  const before = new Date(Date.now() - 60_000);
  utimesSync(join(home, ".claude", ".credentials.json"), before, before);
};
const teamToken = () => JSON.parse(readFileSync(join(team.home, ".claude", ".credentials.json"), "utf8")).claudeAiOauth.accessToken as string;
type Dump = { env: Record<string, string>; argv: string[]; cwd: string; signedInAs?: string | null };
const dumpOf = (home: string) => JSON.parse(readFileSync(join(home, "dump.json"), "utf8")) as Dump;
const scriptToolCalls = (calls: unknown[] | null) => {
  const file = join(team.home, "tool-calls.json");
  if (calls) writeFileSync(file, JSON.stringify(calls)); else rmSync(file, { force: true });
};
const shellLog = () => readFileSync(join(team.home, "shell.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { command: string; output: string });
const messages = async (token: string, threadId: string) => (await team.as(token, "GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as Array<{ role: string; kind?: string; text?: string }>;
const idle = async (token: string) => ((await team.as(token, "GET", "/api/bots")).body.bots as Array<{ activity?: string; busy?: boolean }>)
  .every((entry) => entry.activity !== "working" && !entry.busy);
async function turn(token: string, threadId: string, text: string): Promise<Dump> {
  rmSync(join(team.home, "dump.json"), { force: true });
  const before = (await messages(token, threadId)).length;
  const sent = await team.as(token, "POST", `/api/bots/${bot.id}/messages`, { text, threadId });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  await expect.poll(async () => await idle(token) && (await messages(token, threadId)).length >= before + 2 && existsSync(join(team.home, "dump.json")),
    { timeout: 60_000, interval: 100 }).toBe(true);
  return dumpOf(team.home);
}
const newThread = async (token: string, title: string) => {
  const created = await team.as(token, "POST", `/api/bots/${bot.id}/tasks`, { title });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.task.threadId as string;
};
const transcriptsUnder = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { recursive: true }) as string[] : [])
  .filter((name) => name.endsWith(".jsonl")).map((name) => join(dir, name));

beforeAll(async () => {
  if (!posix) return;
  fx = await launchCloudSendFixture({ onePasswordToken: TOKEN, team: { id: "team-acme-homes", name: "Acme", engine: HOME_FILES }, cloudEngine: HOME_FILES });
  team = fx.team!;
  dataDir = join(team.home, ".openmausbot");
  bobHome = audienceHome(dataDir, `member:${personKey({ id: "", email: BOB.email })}`);
  ownerHome = audienceHome(dataDir, `member:${personKey({ id: "", email: OWNER.email })}`);
  credentials(team.home, "tok-1");
  // A Team Cloud that ran before engine homes: a transcript no conversation names, in the server's HOME.
  mkdirSync(join(team.home, ".claude", "projects", "-srv-old"), { recursive: true });
  writeFileSync(join(team.home, ".claude", "projects", "-srv-old", "0a1b2c3d-9999-4222-8333-444455556666.jsonl"), "the lighthouse code\n");
  owner = (await team.pair(OWNER)).token!;
  admin = (await team.pair(ADMIN)).token!;
  bob = (await team.pair(BOB)).token!;
  const created = await team.as(owner, "POST", "/api/bots", { name: "Scout" });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  bot = created.body.bot;
}, hostTimeout(120_000));

afterAll(async () => {
  await fx?.close();
});

it.runIf(posix)("each person's private chat runs in their own engine home, signed in with the team's sign-in, and the team's in the team's", async () => {
  bobThread = await newThread(bob, "Bob and Scout");
  const seen = await turn(bob, bobThread, "My locker code is sardine.");
  bobSession = seen.argv[seen.argv.indexOf("--session-id") + 1]!;
  expect(bobSession).toMatch(/^[0-9a-f-]{36}$/);
  expect(seen.env.HOME).toBe(bobHome);
  expect(seen.signedInAs).toBe("tok-1");
  const transcript = join(bobHome, ".claude", "projects", claudeProjectSlug(seen.cwd), `${bobSession}.jsonl`);
  expect(readFileSync(transcript, "utf8")).toContain("sardine");
  // Nothing of it in the server's HOME, which every turn's shell could once read.
  expect(transcriptsUnder(join(team.home, ".claude", "projects")).some((file) => readFileSync(file, "utf8").includes("sardine"))).toBe(false);
  // The first start moved what no conversation names out of the server's HOME, to the held folder.
  expect(existsSync(join(team.home, ".claude", "projects", "-srv-old"))).toBe(false);
  const held = readdirSync(join(dataDir, "engine-homes", ".held"));
  expect(readFileSync(join(dataDir, "engine-homes", ".held", held[0]!, ".claude", "projects", "-srv-old", "0a1b2c3d-9999-4222-8333-444455556666.jsonl"), "utf8")).toContain("lighthouse");

  const ownerThread = await newThread(owner, "Olive and Scout");
  const ownerTurn = await turn(owner, ownerThread, "Hello.");
  expect(ownerTurn.env.HOME).toBe(ownerHome);
  expect(ownerTurn.signedInAs).toBe("tok-1");
  const adminTurn = await turn(admin, await newThread(admin, "Ben and Scout"), "Hello.");
  expect(adminTurn.env.HOME).toBe(audienceHome(dataDir, `member:${personKey({ id: "", email: ADMIN.email })}`));
  expect(adminTurn.signedInAs).toBe("tok-1");
  const mainTurn = await turn(owner, bot.mainThreadId, "Hello, team.");
  expect(mainTurn.env.HOME).toBe(audienceHome(dataDir, "team"));
  expect(mainTurn.signedInAs).toBe("tok-1");
}, hostTimeout(180_000));

it.runIf(posix)("a shell in the Owner's chat, or an Admin's, lists and reads none of Bob's transcripts", async () => {
  const look = `ls -aR "$HOME"; echo "MATCHES=$(grep -rl sardine "$HOME" "${team.home}/.claude" 2>/dev/null | wc -l | tr -d ' ')"`;
  scriptToolCalls([{ name: "Bash", input: { command: look } }]);
  try {
    await turn(owner, await newThread(owner, "Olive looks around"), "What is in your home folder?");
    await turn(admin, await newThread(admin, "Ben looks around"), "What is in your home folder?");
  } finally {
    scriptToolCalls(null);
  }
  const shells = shellLog().filter((entry) => entry.command === look);
  expect(shells).toHaveLength(2);
  for (const shell of shells) {
    expect(shell.output).toContain("MATCHES=0");
    expect(shell.output).not.toContain(bobSession);
    expect(shell.output).not.toContain(bobHome);
  }
}, hostTimeout(120_000));

it.runIf(posix)("Bob's conversation resumes from his own home", async () => {
  const resumed = await turn(bob, bobThread, "What was my locker code?");
  expect(resumed.argv).toContain("--resume");
  expect(resumed.argv[resumed.argv.indexOf("--resume") + 1]).toBe(bobSession);
  const answers = (await messages(bob, bobThread)).filter((message) => message.role === "bot" && message.kind !== "activity");
  expect(JSON.stringify(answers.at(-1))).not.toMatch(/No conversation found|Not logged in/);
  const transcript = join(bobHome, ".claude", "projects", claudeProjectSlug(resumed.cwd), `${bobSession}.jsonl`);
  expect(readFileSync(transcript, "utf8").trim().split("\n")).toHaveLength(2);
}, hostTimeout(90_000));

it.runIf(posix)("a sign-in refreshed in Bob's chat becomes the team's and every other chat's", async () => {
  credentials(team.home, "tok-1", Date.now() - 1_000);
  expect((await turn(bob, bobThread, "Still there?")).signedInAs).toBe("tok-1+");
  expect(JSON.parse(readFileSync(join(bobHome, ".claude", ".credentials.json"), "utf8")).claudeAiOauth.accessToken).toBe("tok-1+");
  // Once his engine's write has settled, the next spawn anywhere takes it back for the team.
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  expect((await turn(owner, bot.mainThreadId, "And you?")).signedInAs).toBe("tok-1+");
  expect(teamToken()).toBe("tok-1+");
}, hostTimeout(90_000));

it.runIf(posix)("a Team Cloud that kept transcripts in its HOME moves each one to its conversation's home on its next start", async () => {
  const slugDir = join(bobHome, ".claude", "projects");
  const project = readdirSync(slugDir)[0]!;
  const legacy = join(team.home, ".claude", "projects", project, `${bobSession}.jsonl`);
  mkdirSync(dirname(legacy), { recursive: true });
  renameSync(join(slugDir, project, `${bobSession}.jsonl`), legacy);
  rmSync(join(dataDir, "engine-homes", ".migrated"));
  await team.relaunch();
  const resumed = await turn(bob, bobThread, "Are you back?");
  expect(resumed.argv[resumed.argv.indexOf("--resume") + 1]).toBe(bobSession);
  expect(existsSync(legacy)).toBe(false);
  expect(readFileSync(join(slugDir, project, `${bobSession}.jsonl`), "utf8")).toContain("sardine");
}, hostTimeout(120_000));

it.runIf(posix)("a member who leaves takes their engine home with them", async () => {
  expect(existsSync(bobHome)).toBe(true);
  const left = await team.signed("POST", "/api/cloud/team/member-left", { email: BOB.email });
  expect(left.status, JSON.stringify(left.body)).toBe(200);
  expect(existsSync(bobHome)).toBe(false);
  expect(existsSync(ownerHome)).toBe(true);
}, hostTimeout(60_000));

it.runIf(posix)("My Cloud is unchanged: its engine runs in the server's HOME and keeps its transcripts there", async () => {
  const cloudHome = join(dirname(team.home), "cloud");
  credentials(cloudHome, "tok-home");
  const created = await fx.onCloud("POST", "/api/bots", { name: "Solo" });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const solo = created.body.bot as { id: string; mainThreadId: string };
  rmSync(join(cloudHome, "dump.json"), { force: true });
  expect((await fx.onCloud("POST", `/api/bots/${solo.id}/messages`, { text: "Hello.", threadId: solo.mainThreadId })).status).toBe(202);
  await expect.poll(() => existsSync(join(cloudHome, "dump.json")), { timeout: 60_000, interval: 100 }).toBe(true);
  const seen = dumpOf(cloudHome);
  expect(seen.env.HOME).toBe(cloudHome);
  expect(seen.signedInAs).toBe("tok-home");
  await expect.poll(() => transcriptsUnder(join(cloudHome, ".claude", "projects")).length, { timeout: 30_000, interval: 100 }).toBeGreaterThan(0);
  expect(existsSync(join(cloudHome, ".openmausbot", "engine-homes"))).toBe(false);
}, hostTimeout(90_000));
