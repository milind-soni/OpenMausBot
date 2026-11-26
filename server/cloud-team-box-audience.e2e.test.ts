// A real Team Cloud with the Owner (Olive) and two Members (Mira, Ben), whose engine runs a shell in its turns: a turn
// that is not the team's never writes the bot's own folder (the team's notes and skills) nor reads another person's
// conversation, while the team's chat still writes the team's notes and "Save to team memory" still works from a private
// chat. The box itself runs only where an unprivileged bubblewrap does (a Cloud home; not macOS, not CI's Ubuntu 24.04):
// there the shell's refusals are checked here; elsewhere the same plan is proven in server/host/team-box-scope.test.ts,
// and a real box in server/host/team-box-scope.linux.test.ts.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { detectBox } from "./bot-box/detect.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const posix = process.platform !== "win32";
const boxed = posix && detectBox({ env: { ...process.env, OMB_CLOUD_ROLE: "team" } }).box === "bwrap";
const TOKEN = `ops_fake-team-box-${randomBytes(8).toString("hex")}`;
const OWNER = { email: "olive@acme.test", role: "owner" as const };
const MIRA = { email: "mira@acme.test", role: "member" as const };
const BEN = { email: "ben@acme.test", role: "member" as const };
const SHELL = `import { readFileSync as readToolCalls } from "node:fs";
process.env.FAKE_CLAUDE_DUMP = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/dump.json";
process.env.FAKE_CLAUDE_SHELL_LOG = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/shell.jsonl";
process.env.FAKE_CLAUDE_RUN_BASH = "1";
process.env.FAKE_CLAUDE_EXIT_AFTER_TURN = "1";
try { process.env.FAKE_CLAUDE_TOOL_CALLS = readToolCalls(process.env.FAKE_CLAUDE_FIXTURE_DIR + "/tool-calls.json", "utf8"); } catch {}`;

let fx: CloudSendFixture, team: CloudTeamFixture;
let owner = "", mira = "", ben = "";
let bot: { id: string; mainThreadId: string };
let dataDir = "", teamNotes = "", miraThread = "", benThread = "";

type Dump = { cwd: string; systemPrompt?: string | null };
const messages = async (token: string, threadId: string) => (await team.as(token, "GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as Array<{ id: string; role: string; kind?: string; text?: string }>;
const idle = async (token: string) => ((await team.as(token, "GET", "/api/bots")).body.bots as Array<{ activity?: string; busy?: boolean }>)
  .every((entry) => entry.activity !== "working" && !entry.busy);
const shellLog = () => existsSync(join(team.home, "shell.jsonl"))
  ? readFileSync(join(team.home, "shell.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { command: string; output: string }) : [];
async function turn(token: string, threadId: string, text: string, command?: string): Promise<{ dump: Dump; output: string }> {
  rmSync(join(team.home, "dump.json"), { force: true });
  const file = join(team.home, "tool-calls.json");
  if (command) writeFileSync(file, JSON.stringify([{ name: "Bash", input: { command } }])); else rmSync(file, { force: true });
  try {
    const before = (await messages(token, threadId)).length;
    const sent = await team.as(token, "POST", `/api/bots/${bot.id}/messages`, { text, threadId });
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    await expect.poll(async () => await idle(token) && (await messages(token, threadId)).length >= before + 2 && existsSync(join(team.home, "dump.json")),
      { timeout: 60_000, interval: 100 }).toBe(true);
  } finally {
    rmSync(file, { force: true });
  }
  const dump = JSON.parse(readFileSync(join(team.home, "dump.json"), "utf8")) as Dump;
  return { dump, output: command ? shellLog().filter((entry) => entry.command === command).at(-1)?.output ?? "" : "" };
}
const newThread = async (token: string, title: string) => {
  const created = await team.as(token, "POST", `/api/bots/${bot.id}/tasks`, { title });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.task.threadId as string;
};

beforeAll(async () => {
  if (!posix) return;
  fx = await launchCloudSendFixture({ onePasswordToken: TOKEN, team: { id: "team-acme-box", name: "Acme", engine: SHELL }, cloudEngine: SHELL });
  team = fx.team!;
  dataDir = join(team.home, ".openmausbot");
  owner = (await team.pair(OWNER)).token!;
  mira = (await team.pair(MIRA)).token!;
  ben = (await team.pair(BEN)).token!;
  const created = await team.as(owner, "POST", "/api/bots", { name: "Scout", visibility: "everyone" });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  bot = created.body.bot;
  teamNotes = join(dataDir, "workspaces", bot.id, "MEMORY.md");
  benThread = await newThread(ben, "Ben's payslip");
  miraThread = await newThread(mira, "Mira and Scout");
}, hostTimeout(180_000));

afterAll(async () => {
  await fx?.close();
});

it.runIf(posix)("Mira's private chat is told the team's folder is read-only there; the team's chat is not", async () => {
  // Ben's conversation folder, with what only he may read.
  const benTurn = await turn(ben, benThread, "Keep this.", "echo 'locker code sardine' > notes.md");
  expect(realpathSync(benTurn.dump.cwd)).toBe(realpathSync(join(dataDir, "task-workspaces", bot.id, benThread)));
  const { dump } = await turn(mira, miraThread, "Hello.");
  expect(realpathSync(dump.cwd)).toBe(realpathSync(join(dataDir, "task-workspaces", bot.id, miraThread)));
  expect(dump.systemPrompt).toContain(`${join("workspaces", bot.id)}) holds Acme's notes and skills: in this conversation they are read-only`);
  const main = await turn(owner, bot.mainThreadId, "Hello, team.");
  expect(main.dump.systemPrompt ?? "").not.toContain("in this conversation they are read-only");
  // A conversation folder of its own, so in a box its turns have the bot's folder (read-write, as the team's).
  expect(realpathSync(main.dump.cwd)).toBe(realpathSync(join(dataDir, "task-workspaces", bot.id, bot.mainThreadId)));
}, hostTimeout(120_000));

it.runIf(boxed)("a shell in Mira's private chat reads the team's notes but cannot write them, nor read Ben's conversation", async () => {
  const before = readFileSync(teamNotes, "utf8");
  const benNotes = join(dataDir, "task-workspaces", bot.id, benThread, "notes.md");
  const command = [
    `cat "${teamNotes}" >/dev/null && echo TEAM-READ`,
    `(echo mira >> "${teamNotes}") 2>&1 && echo TEAM-WRITTEN || echo TEAM-REFUSED`,
    `cat "${benNotes}" 2>&1 || echo BEN-UNREADABLE`,
    "echo draft > draft.md && echo OWN-WRITTEN",
  ].join("; ");
  const { output } = await turn(mira, miraThread, "Note it in the team's notes.", command);
  expect(output).toContain("TEAM-READ");
  expect(output).toContain("TEAM-REFUSED");
  expect(output).not.toContain("TEAM-WRITTEN");
  expect(output).toContain("BEN-UNREADABLE");
  expect(output).not.toContain("sardine");
  expect(output).toContain("OWN-WRITTEN");
  expect(readFileSync(teamNotes, "utf8")).toBe(before);
  // The turn ended as any other: the refusal is the shell's answer, not a failed turn.
  const last = (await messages(mira, miraThread)).filter((message) => message.role === "bot" && message.kind !== "activity").at(-1);
  expect(JSON.stringify(last)).not.toMatch(/error|failed/i);
}, hostTimeout(120_000));

it.runIf(posix)("the team's chat still writes the team's notes", async () => {
  const command = `echo 'we ship on Fridays' >> "${teamNotes}" && echo TEAM-WRITTEN`;
  const { output } = await turn(owner, bot.mainThreadId, "Remember we ship on Fridays.", command);
  expect(output).toContain("TEAM-WRITTEN");
  expect(readFileSync(teamNotes, "utf8")).toContain("we ship on Fridays");
}, hostTimeout(120_000));

it.runIf(posix)("Save to team memory still works from Mira's private chat", async () => {
  const line = (await messages(mira, miraThread)).filter((message) => message.role === "user").at(-1)!;
  const saved = await team.as(mira, "POST", `/api/bots/${bot.id}/memory/team`, { threadId: miraThread, messageId: line.id, text: "Payroll closes on the 25th" });
  expect(saved.status, JSON.stringify(saved.body)).toBeLessThan(300);
  expect(readFileSync(teamNotes, "utf8")).toContain("Payroll closes on the 25th (saved by");
}, hostTimeout(60_000));
