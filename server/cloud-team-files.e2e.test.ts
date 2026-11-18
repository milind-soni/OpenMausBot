// Team files on a real Team Cloud: Olive (the Owner), Mira and Ben (Members), a Payroll bot an admin lets edit the shared
// folder and a Notes bot that only reads it. Mira uploads; Payroll writes a record from Mira's private chat and the page
// names them both; members delete only what they uploaded and an admin anything; the export carries the folder; Mira
// leaving takes none of it; a personal Cloud has no such routes. The bot box runs only where an unprivileged bubblewrap
// does (not macOS, not CI's Ubuntu 24.04): there the read-only folder is checked here too, elsewhere in
// server/host/team-box-scope.test.ts and server/bot-box/plan.test.ts.
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import type { TeamFilesListing } from "../shared/team-files.ts";
import { detectBox } from "./bot-box/detect.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { stagedWorkspaceData, stageWorkspaceBackup } from "./workspace-backup.ts";

const posix = process.platform !== "win32";
const boxed = posix && detectBox({ env: { ...process.env, OMB_CLOUD_ROLE: "team" } }).box === "bwrap";
const TOKEN = `ops_fake-team-files-${randomBytes(8).toString("hex")}`;
const PASSWORD = "correct horse battery staple";
const OLIVE = { email: "olive@acme.test", role: "owner" as const };
const MIRA = { email: "mira@acme.test", role: "member" as const };
const BEN = { email: "ben@acme.test", role: "member" as const };
const SHELL = `import { readFileSync as readToolCalls } from "node:fs";
process.env.FAKE_CLAUDE_DUMP = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/dump.json";
process.env.FAKE_CLAUDE_SHELL_LOG = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/shell.jsonl";
process.env.FAKE_CLAUDE_RUN_BASH = "1";
process.env.FAKE_CLAUDE_EXIT_AFTER_TURN = "1";
try { process.env.FAKE_CLAUDE_TOOL_CALLS = readToolCalls(process.env.FAKE_CLAUDE_FIXTURE_DIR + "/tool-calls.json", "utf8"); } catch {}`;

let fx: CloudSendFixture, team: CloudTeamFixture;
let olive = "", mira = "", ben = "";
let payroll: { id: string; name: string }, notes: { id: string; name: string };
let dataDir = "", folder = "";

const messages = async (token: string, threadId: string) => (await team.as(token, "GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as Array<{ role: string }>;
const idle = async (token: string) => ((await team.as(token, "GET", "/api/bots")).body.bots as Array<{ activity?: string; busy?: boolean }>)
  .every((entry) => entry.activity !== "working" && !entry.busy);
const shellOutput = (command: string) => existsSync(join(team.home, "shell.jsonl"))
  ? readFileSync(join(team.home, "shell.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { command: string; output: string }).filter((entry) => entry.command === command).at(-1)?.output ?? "" : "";
async function turn(token: string, botId: string, threadId: string, command: string): Promise<{ systemPrompt: string; output: string }> {
  rmSync(join(team.home, "dump.json"), { force: true });
  writeFileSync(join(team.home, "tool-calls.json"), JSON.stringify([{ name: "Bash", input: { command } }]));
  try {
    const before = (await messages(token, threadId)).length;
    const sent = await team.as(token, "POST", `/api/bots/${botId}/messages`, { text: "Do it.", threadId });
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    await expect.poll(async () => await idle(token) && (await messages(token, threadId)).length >= before + 2 && existsSync(join(team.home, "dump.json")),
      { timeout: 60_000, interval: 100 }).toBe(true);
  } finally {
    rmSync(join(team.home, "tool-calls.json"), { force: true });
  }
  return { systemPrompt: (JSON.parse(readFileSync(join(team.home, "dump.json"), "utf8")) as { systemPrompt?: string }).systemPrompt ?? "", output: shellOutput(command) };
}
const newThread = async (token: string, botId: string) => {
  const created = await team.as(token, "POST", `/api/bots/${botId}/tasks`, { title: "Chat" });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.task.threadId as string;
};
const list = async (token: string, path = "") => {
  const answer = await team.as(token, "GET", `/api/team-files?path=${encodeURIComponent(path)}`);
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return answer.body as TeamFilesListing;
};
const upload = (token: string, path: string, name: string, text: string) =>
  team.as(token, "PUT", `/api/team-files/file?path=${encodeURIComponent(path)}&name=${encodeURIComponent(name)}`, new TextEncoder().encode(text), { "content-type": "application/octet-stream" });

beforeAll(async () => {
  if (!posix) return;
  fx = await launchCloudSendFixture({ onePasswordToken: TOKEN, team: { id: "team-acme-files", name: "Acme", engine: SHELL }, cloudEngine: SHELL });
  team = fx.team!;
  dataDir = join(team.home, ".openmausbot");
  olive = (await team.pair(OLIVE)).token!;
  mira = (await team.pair(MIRA)).token!;
  ben = (await team.pair(BEN)).token!;
  for (const name of ["Payroll", "Notes"]) {
    const created = await team.as(olive, "POST", "/api/bots", { name, visibility: "everyone" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    if (name === "Payroll") payroll = created.body.bot; else notes = created.body.bot;
  }
  folder = boxed ? "/team-files" : join(dataDir, "team-files");
}, hostTimeout(180_000));

afterAll(async () => {
  await fx?.close();
});

it.runIf(posix)("a member uploads and makes folders, and every teammate sees who did", async () => {
  expect((await team.as(mira, "POST", "/api/team-files/folder", { path: "payroll" })).status).toBe(201);
  const uploaded = await upload(mira, "", "handbook.md", "# Handbook\nBe kind.\n");
  expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);
  const seen = await list(ben);
  expect(seen.entries.map((entry) => [entry.name, entry.kind])).toEqual([["payroll", "folder"], ["handbook.md", "file"]]);
  const handbook = seen.entries.find((entry) => entry.name === "handbook.md")!;
  expect(handbook).toMatchObject({ size: 20, canDelete: false, mine: false, last: { action: "uploaded" } });
  expect(handbook.last?.person).toMatch(/mira/i);
  expect(seen.used).toBe(20);
  expect(seen.cap).toBe(5 * 1024 ** 3);
  const read = await fetch(`${team.base}/api/team-files/file?path=handbook.md`, { headers: { ...fx.edge, authorization: `Bearer ${ben}` } });
  expect([read.status, read.headers.get("content-type"), await read.text()]).toEqual([200, "text/plain; charset=utf-8", "# Handbook\nBe kind.\n"]);
  expect((await team.as(ben, "GET", "/api/team-files?path=..%2F")).status).toBe(400);
  expect((await upload(ben, "../workspaces", "x.md", "no")).status).toBe(400);
}, hostTimeout(60_000));

it.runIf(posix)("only an admin lets a bot edit team files", async () => {
  const refused = await team.as(mira, "PATCH", `/api/bots/${payroll.id}`, { teamFilesEdit: true });
  expect(refused.status).toBe(403);
  const allowed = await team.as(olive, "PATCH", `/api/bots/${payroll.id}`, { teamFilesEdit: true });
  expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
  const bots = (await team.as(mira, "GET", "/api/bots")).body.bots as Array<{ id: string; teamFilesEdit?: boolean }>;
  expect(bots.find((bot) => bot.id === payroll.id)?.teamFilesEdit).toBe(true);
  expect(bots.find((bot) => bot.id === notes.id)?.teamFilesEdit).toBeFalsy();
}, hostTimeout(60_000));

it.runIf(posix)("Payroll writes a record from Mira's private chat, and the page names Mira and Payroll", async () => {
  const thread = await newThread(mira, payroll.id);
  const command = `printf 'name,net\\nMira,4200\\n' > "${folder}/payroll/nov.csv" && echo WROTE`;
  const { systemPrompt, output } = await turn(mira, payroll.id, thread, command);
  expect(systemPrompt).toContain(`Team files, the folder everyone at Acme shares: ${folder}. You can add and change files there`);
  expect(output).toContain("WROTE");
  const listed = await list(ben, "payroll");
  const record = listed.entries.find((entry) => entry.name === "nov.csv")!;
  expect(record).toMatchObject({ kind: "file", canDelete: false, last: { action: "added", bot: "Payroll" } });
  expect(record.last?.person).toMatch(/mira/i);
  // The conversation itself never goes there.
  expect((await list(olive, "")).entries.map((entry) => entry.name).sort()).toEqual(["handbook.md", "payroll"]);
}, hostTimeout(120_000));

it.runIf(posix)("a bot nobody let edit is told the folder is read-only for it", async () => {
  const thread = await newThread(mira, notes.id);
  const command = `cat "${folder}/handbook.md" && (echo x >> "${folder}/handbook.md") 2>&1 && echo WROTE || echo REFUSED`;
  const { systemPrompt, output } = await turn(mira, notes.id, thread, command);
  expect(systemPrompt).toContain(`shares: ${folder}. It is read-only for you.`);
  expect(output).toContain("Be kind.");
  if (boxed) {
    expect(output).toContain("REFUSED");
    expect(readFileSync(join(dataDir, "team-files", "handbook.md"), "utf8")).toBe("# Handbook\nBe kind.\n");
  }
}, hostTimeout(120_000));

it.runIf(posix)("a member deletes only what they uploaded; an admin deletes anything", async () => {
  expect((await team.as(ben, "POST", "/api/team-files/delete", { path: "handbook.md" }))).toMatchObject({ status: 403, body: { code: "forbidden" } });
  expect((await team.as(ben, "POST", "/api/team-files/delete", { path: "payroll/nov.csv" })).status).toBe(403);
  expect((await team.as(ben, "POST", "/api/team-files/rename", { from: "handbook.md", to: "mine.md" })).status).toBe(403);
  expect((await upload(ben, "", "ben.txt", "Ben's")).status).toBe(201);
  expect((await team.as(ben, "POST", "/api/team-files/delete", { path: "ben.txt" })).status).toBe(200);
  expect((await list(olive)).entries.find((entry) => entry.name === "handbook.md")?.canDelete).toBe(true);
  expect((await upload(mira, "", "old.md", "old")).status).toBe(201);
  expect((await team.as(olive, "POST", "/api/team-files/delete", { path: "old.md" })).status).toBe(200);
  expect((await list(mira)).entries.map((entry) => entry.name)).toEqual(["payroll", "handbook.md"]);
}, hostTimeout(60_000));

it.runIf(posix)("the Owner's export carries the team's files and who changed them", async () => {
  const made = await team.as(olive, "POST", "/api/workspace-backup/export", { password: PASSWORD });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  const download = await fetch(`${team.base}/api/workspace-backup/download/${made.body.id}`, { headers: { ...fx.edge, authorization: `Bearer ${olive}` } });
  expect(download.status).toBe(200);
  const unpack = mkdtempSync(join(tmpdir(), "omb-team-files-export-"));
  try {
    const archive = join(unpack, "export.ombbackup");
    writeFileSync(archive, Buffer.from(await download.arrayBuffer()));
    const staged = await stageWorkspaceBackup(unpack, archive, { password: PASSWORD, currentAppVersion: made.body.summary.appVersion });
    const { data } = stagedWorkspaceData(unpack, staged.id);
    expect(readFileSync(join(data, "team-files", "payroll", "nov.csv"), "utf8")).toContain("Mira,4200");
    expect(readFileSync(join(data, "team-files", "handbook.md"), "utf8")).toContain("Be kind.");
    expect(readFileSync(join(data, "team-files-activity.json"), "utf8")).toContain("payroll/nov.csv");
  } finally {
    rmSync(unpack, { recursive: true, force: true });
  }
}, hostTimeout(180_000));

it.runIf(posix)("Mira leaving takes nothing of team files: what she wrote stays the team's", async () => {
  const left = await team.signed("POST", "/api/cloud/team/member-left", { email: MIRA.email });
  expect(left.status, JSON.stringify(left.body)).toBe(200);
  const listed = await list(olive);
  expect(listed.entries.map((entry) => entry.name)).toEqual(["payroll", "handbook.md"]);
  expect((await list(olive, "payroll")).entries.map((entry) => entry.name)).toEqual(["nov.csv"]);
}, hostTimeout(60_000));

it.runIf(posix)("a personal Cloud has no team files at all", async () => {
  expect((await fx.onCloud("GET", "/api/team-files")).status).toBe(404);
  expect((await fx.onCloud("POST", "/api/team-files/folder", { path: "x" })).status).toBe(404);
  expect(existsSync(join(team.home, "..", "cloud", ".openmausbot", "team-files"))).toBe(false);
}, hostTimeout(60_000));
