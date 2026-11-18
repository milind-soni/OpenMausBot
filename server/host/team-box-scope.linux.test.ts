// The audience rule in a real box, where one can run: Linux with an unprivileged bubblewrap (a Cloud home, the Fly test
// machine). Elsewhere the suite says so and skips, like the box's own self-check; team-box-scope.test.ts proves the plan.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { detectBox } from "../bot-box/detect.ts";
import { bwrapArgs, planBox, type BoxRequest } from "../bot-box/plan.ts";
import { createTeamBoxScope } from "./team-box-scope.ts";

const detection = detectBox({ env: { ...process.env, OMB_BOT_BOX: "1" } });
const available = detection.box === "bwrap" && detection.tools !== null;
const root = mkdtempSync(join(tmpdir(), "omb-team-box-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const home = join(root, "home"), dataDir = join(home, ".openmausbot");
const team = join(dataDir, "workspaces", "bot-a"), miraLayer = join(dataDir, "workspaces", "bot-a--member-p_mira");
const conversation = (threadId: string) => join(dataDir, "task-workspaces", "bot-a", threadId);
const put = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const audiences: Record<string, "team" | `member:${string}`> = { "t-team": "team", "t-mira": "member:p_mira", "t-ben": "member:p_ben" };
const scope = createTeamBoxScope({ audienceOf: (threadId) => audiences[threadId] ?? "team", bots: () => [{ id: "bot-a", tasks: Object.keys(audiences).map((threadId) => ({ threadId })) }] });

function shellIn(threadId: string, script: string, more: Partial<BoxRequest> = {}): string {
  const cwd = conversation(threadId);
  const audience = scope({ threadId, botId: "bot-a", sharedProcess: Boolean(more.botThreads) });
  const plan = planBox({ dataDir, home, codeRoots: [], engineRoots: [], bridges: [] }, { command: "/bin/sh", args: [], cwd, env: { HOME: home, PATH: "/usr/bin:/bin" }, ...(audience ? { audience } : {}), ...more });
  const ran = spawnSync(detection.tools!.bwrap, [...bwrapArgs(plan), "--", "/bin/sh", "-c", script], { env: { HOME: home, PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 30_000 });
  return `${ran.stdout}${ran.stderr}`;
}

describe.skipIf(!available)(`the audience rule in a real box (${available ? "bubblewrap works here" : `skipped: ${detection.reason}`})`, () => {
  beforeAll(() => {
    put(join(team, "MEMORY.md"), "team notes\n");
    put(join(team, "skills", "report", "SKILL.md"), "the team's skill\n");
    put(join(miraLayer, "MEMORY.md"), "mira's notes\n");
    for (const threadId of Object.keys(audiences)) put(join(conversation(threadId), "notes.md"), `${threadId}: sardine\n`);
  });

  it("a shell in Mira's private chat reads the team's notes but cannot write them, nor read Ben's conversation", () => {
    const output = shellIn("t-mira", [
      `cat "${join(team, "MEMORY.md")}"`,
      `echo mira >> "${join(team, "MEMORY.md")}" || echo TEAM-NOTES-REFUSED`,
      `echo x > "${join(team, "skills", "report", "SKILL.md")}" || echo TEAM-SKILL-REFUSED`,
      `echo mira >> "${join(miraLayer, "MEMORY.md")}" && echo OWN-LAYER-WRITTEN`,
      `cat "${join(conversation("t-ben"), "notes.md")}" || echo BEN-UNREADABLE`,
      `echo done > "${join(conversation("t-mira"), "draft.md")}" && echo OWN-FOLDER-WRITTEN`,
    ].join("\n"), { rw: [miraLayer] });
    expect(output).toContain("team notes");
    expect(output).toContain("TEAM-NOTES-REFUSED");
    expect(output).toMatch(/Read-only file system/);
    expect(output).toContain("TEAM-SKILL-REFUSED");
    expect(output).toContain("OWN-LAYER-WRITTEN");
    expect(output).toContain("BEN-UNREADABLE");
    expect(output).not.toContain("t-ben: sardine");
    expect(output).toContain("OWN-FOLDER-WRITTEN");
    expect(readFileSync(join(team, "MEMORY.md"), "utf8")).toBe("team notes\n");
  }, 60_000);

  it("a process Mira's conversations share lists neither Ben's conversation nor writes the team's", () => {
    const output = shellIn("t-mira", [
      `ls "${join(dataDir, "task-workspaces", "bot-a")}"`,
      `cat "${join(conversation("t-team"), "notes.md")}"`,
      `echo x >> "${join(conversation("t-team"), "notes.md")}" || echo TEAM-CHAT-REFUSED`,
    ].join("\n"), { botThreads: true });
    expect(output).not.toContain("t-ben");
    expect(output).toContain("t-team: sardine");
    expect(output).toContain("TEAM-CHAT-REFUSED");
  }, 60_000);

  it("the team's chat still writes the team's notes", () => {
    const output = shellIn("t-team", `echo team >> "${join(team, "MEMORY.md")}" && echo TEAM-NOTES-WRITTEN`);
    expect(output).toContain("TEAM-NOTES-WRITTEN");
    expect(readFileSync(join(team, "MEMORY.md"), "utf8")).toBe("team notes\nteam\n");
  }, 60_000);
});
