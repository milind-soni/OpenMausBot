import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { BOT_PROFILE_LIMITS } from "../../shared/bot-profile.ts";
import { botSkillTemplateSchema } from "../new-bot-defaults.ts";
import { SECTION_CONTEXT_MAX_BYTES } from "../section-context.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { loadTeamFile, ROOM_BRIEF_MAX_CHARS, serverFolder, SKILL_MAX_BYTES, TEAM_BRIEF_MAX_BYTES } from "./team-file.ts";

const dir = mkdtempSync(join(tmpdir(), "omb-team-file-"));
afterAll(() => removeTempDir(dir));
let n = 0;
const file = (text: string, name = `team-${++n}.yaml`) => { writeFileSync(join(dir, name), text); return join(dir, name); };
const refused = (text: string) => {
  try {
    loadTeamFile(file(text));
  } catch (error) {
    return { message: (error as Error).message, exitCode: (error as { exitCode?: number }).exitCode };
  }
  throw new Error("expected the file to be refused");
};

mkdirSync(join(dir, "souls"), { recursive: true });
mkdirSync(join(dir, "skills", "launch-report"), { recursive: true });
writeFileSync(join(dir, "souls", "lead.md"), "Lead the rehearsal.\n");
writeFileSync(join(dir, "skills", "launch-report", "SKILL.md"), "---\nname: launch-report\ndescription: Write the report.\n---\nBody.\n");
mkdirSync(join(dir, "skills", "huge"), { recursive: true });
writeFileSync(join(dir, "skills", "huge", "SKILL.md"), `---\nname: huge\ndescription: Too big.\n---\n${"x".repeat(SKILL_MAX_BYTES)}\n`);

describe("loadTeamFile", () => {
  it("puts defaults under every bot, reads souls and skills from beside the file, and keeps keys as references", () => {
    const team = loadTeamFile(file(`version: 1
engines:
  claude: { key: { env: ANTHROPIC_API_KEY }, baseUrl: https://gateway.example, everyClaudeBot: true }
  openaiCompatible: { key: { file: keys/compat }, baseUrl: { env: COMPAT_URL } }
defaults:
  team: Launch Room
  model: claude/claude-haiku-5-5
  approval: full
  computer: browser
  browser: { enabled: true, profile: guest }
  cwd: /work/visitors/
  tools: { deny: ["native:Bash"] }
teams:
  - { name: Launch Room, prune: true, brief: "We rehearse." }
bots:
  - name: Room Lead
    chief: true
    manages: [Support]
    model: claude/claude-sonnet-5-5
    effort: medium
    computer: local
    browser: false
    tools: { deny: [] }
    soul: { file: souls/lead.md }
    skills: [{ file: skills/launch-report/SKILL.md }]
  - name: Priya
    soul: You are Priya.
rooms:
  - { name: Rehearsal, members: [Room Lead, Priya], responder: Room Lead }
`));
    expect(team.bots[0]).toEqual({
      name: "Room Lead", team: "Launch Room", chief: true, manages: ["Support"], soul: "Lead the rehearsal.\n",
      model: { instanceId: "claude", model: "claude-sonnet-5-5" }, effort: "medium", approval: "full", computer: "local",
      cwd: "/work/visitors", browser: { enabled: false }, tools: null,
      skills: [{ name: "launch-report", description: "Write the report.", text: expect.stringContaining("Body."), enabled: true, file: "skills/launch-report/SKILL.md" }],
    });
    expect(team.bots[1]).toMatchObject({ name: "Priya", team: "Launch Room", model: { instanceId: "claude", model: "claude-haiku-5-5" },
      browser: { enabled: true, profile: "guest" }, tools: { deny: ["native:Bash"] }, soul: "You are Priya.", skills: [], manages: [] });
    expect(team.bots[1]).not.toHaveProperty("chief");
    expect(team.teams).toEqual([{ name: "Launch Room", brief: "We rehearse.", prune: true }]);
    expect(team.rooms).toEqual([{ name: "Rehearsal", members: ["Room Lead", "Priya"], responder: "Room Lead" }]);
    expect(team.engines).toEqual([
      { kind: "claude", key: { env: "ANTHROPIC_API_KEY" }, baseUrl: "https://gateway.example", everyClaudeBot: true },
      { kind: "openai-compatible", key: { file: join(dir, "keys", "compat") }, baseUrl: { env: "COMPAT_URL" } },
    ]);
    expect(team.warnings).toEqual([]);
  });

  it("reads a working folder by the rules of the system it is written for, never this computer's", () => {
    // Applied from a Windows laptop to a Linux sandbox, or the other way: the folder is the server's.
    const team = loadTeamFile(file(JSON.stringify({ version: 1, bots: [
      { name: "A", cwd: "/work/room/" }, { name: "B", cwd: "C:\\work\\room\\" }, { name: "C", cwd: "C:/work/visitors" },
      { name: "D", cwd: "\\\\nas\\share\\room" }, { name: "E", cwd: "/work//visitors/../room" },
    ] }), "folders.json"));
    expect(team.bots.map((bot) => bot.cwd)).toEqual(["/work/room", "C:\\work\\room", "C:\\work\\visitors", "\\\\nas\\share\\room", "/work/room"]);
    expect(serverFolder("work/room")).toBeUndefined();
    expect(serverFolder("\\work")).toBeUndefined();
  });

  it("reads a file checked out on Windows exactly as on Linux: LF line ends, either path separator", () => {
    // Git on Windows checks text out with CRLF and Linux CI with LF: each apply from the other would rewrite every file.
    mkdirSync(join(dir, "crlf", "skills", "report"), { recursive: true });
    writeFileSync(join(dir, "crlf", "soul.md"), "Lead the rehearsal.\r\nWrite report.md.\r\n");
    writeFileSync(join(dir, "crlf", "skills", "report", "SKILL.md"), "---\r\nname: report\r\ndescription: Write it.\r\n---\r\nBody.\r\n");
    const team = loadTeamFile(file(JSON.stringify({ version: 1,
      teams: [{ name: "T", brief: "Line one.\r\nLine two.\r\n" }],
      bots: [{ name: "A", team: "T", soul: { file: "soul.md" }, skills: [{ file: "skills\\report\\SKILL.md" }] }],
    }), join("crlf", "team.json")));
    expect(team.bots[0]!.soul).toBe("Lead the rehearsal.\nWrite report.md.\n");
    expect(team.bots[0]!.skills[0]).toMatchObject({ name: "report", text: "---\nname: report\ndescription: Write it.\n---\nBody.\n" });
    expect(team.teams[0]!.brief).toBe("Line one.\nLine two.\n");
  });

  it("reads JSON too, and warns about a bot left on an automatic computer", () => {
    const team = loadTeamFile(file(JSON.stringify({ version: 1, bots: [{ name: "Solo" }] }), "team.json"));
    expect(team.bots).toEqual([{ name: "Solo", manages: [], skills: [] }]);
    expect(team.warnings).toEqual([expect.stringContaining('bot "Solo" has no computer set')]);
  });

  it.each([
    ["a literal key", "engines: { claude: { key: sk-ant-abcdefghijklmnopqrstuvwx } }\nbots: [{ name: A }]", "put the key in an environment variable or a file"],
    ["an unknown field", "bots: [{ name: A, colour: blue }]", 'bots[0]: unknown field "colour"'],
    ["no bots", "bots: []", "list at least one bot"],
    ["a duplicate name", "bots: [{ name: Priya }, { name: priya }]", '"priya" is listed twice'],
    ["two chiefs in a team", "bots: [{ name: A, team: T, chief: true }, { name: B, team: T, chief: true }]", 'team "T" has two chiefs: A and B'],
    ["manages without chief", "bots: [{ name: A, manages: [T] }]", "manages needs chief: true"],
    ["a model without its engine", "bots: [{ name: A, model: sonnet }]", "must be INSTANCE/MODEL"],
    ["a relative folder", "bots: [{ name: A, cwd: work/a }]", "cwd must be an absolute path on the server"],
    ["a home folder", "bots: [{ name: A, cwd: ~/work }]", "~ is not expanded the same way on the server"],
    ["Custom approval", "bots: [{ name: A, approval: custom }]", "custom is set in the desktop app"],
    ["a soul file that is not there", "bots: [{ name: A, soul: { file: souls/nobody.md } }]", "souls/nobody.md could not be read (ENOENT)"],
    ["a bad tool selector", 'bots: [{ name: A, tools: { deny: ["Bash"] } }]', "selectors look like native:Bash"],
    ["a room member listed twice", "bots: [{ name: A }]\nrooms: [{ name: R, members: [A, a] }]", "a member is listed twice"],
    ["a responder from outside the room", "bots: [{ name: A }]\nrooms: [{ name: R, members: [A], responder: B }]", "responder must be everyone, mentions, or one of its members"],
    ["a title on two lines", 'bots: [{ name: A, title: "Buyer\\nand critic" }]', "bots[0].title: a title must fit on one line"],
    ["a name too long", `bots: [{ name: ${"n".repeat(BOT_PROFILE_LIMITS.name + 1)} }]`, `bots[0].name: must be at most ${BOT_PROFILE_LIMITS.name} characters`],
    ["a soul too long", `bots: [{ name: A, soul: ${"s".repeat(BOT_PROFILE_LIMITS.soul + 1)} }]`, `soul is over ${BOT_PROFILE_LIMITS.soul} bytes`],
    ["a team brief too long", `teams: [{ name: T, brief: ${"b".repeat(TEAM_BRIEF_MAX_BYTES + 1)} }]\nbots: [{ name: A }]`, `brief is over ${TEAM_BRIEF_MAX_BYTES} bytes`],
    ["a room brief too long", `bots: [{ name: A }]\nrooms: [{ name: R, members: [A], brief: ${"b".repeat(ROOM_BRIEF_MAX_CHARS + 1)} }]`, `brief is over ${ROOM_BRIEF_MAX_CHARS} characters`],
    ["a skill too big", "bots: [{ name: A, skills: [{ file: skills/huge/SKILL.md }] }]", "skills/huge/SKILL.md is over 256 KiB"],
  ])("refuses %s (exit 2)", (_what, body, message) => {
    expect(refused(`version: 1\n${body}\n`)).toEqual({ message: expect.stringContaining(message), exitCode: 2 });
  });

  it("holds a file to the limits the server holds each write to", async () => {
    expect(TEAM_BRIEF_MAX_BYTES).toBe(SECTION_CONTEXT_MAX_BYTES);
    // a room's brief goes through MCP's create_channel, which holds it to the same length
    const { handleToolCall } = await import("../../scripts/mcp-server.ts");
    const fetcher = async () => ({ group: { id: "g1", name: "R", memberIds: ["a"] } });
    await expect(handleToolCall("create_channel", { name: "R", member_ids: ["a"], bulletin: "b".repeat(ROOM_BRIEF_MAX_CHARS) }, fetcher)).resolves.toMatchObject({ success: true });
    await expect(handleToolCall("create_channel", { name: "R", member_ids: ["a"], bulletin: "b".repeat(ROOM_BRIEF_MAX_CHARS + 1) }, fetcher)).rejects.toThrow();
    const skill = { name: "big", description: "", source: "x", enabled: true };
    expect(botSkillTemplateSchema.safeParse({ ...skill, text: "x".repeat(SKILL_MAX_BYTES) }).success).toBe(true);
    expect(botSkillTemplateSchema.safeParse({ ...skill, text: "x".repeat(SKILL_MAX_BYTES + 1) }).success).toBe(false);
  });

  it("refuses a file without its version, or one that is not YAML", () => {
    expect(refused("bots: [{ name: A }]\n").message).toContain("version: 1 is required");
    expect(refused("version: 1\nbots: [ { name: A\n").message).toContain("is not valid YAML");
  });
});
