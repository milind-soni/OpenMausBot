import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { HeadlessClient } from "./client.ts";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { approvalModeFor } from "../../shared/approval-mode.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import type { VerbContext } from "./context.ts";
import { Output } from "./output.ts";
import { botPatch, botSkillDirs, reconcile, skillFilePath, teamExportVerb, type ApplyOptions } from "./team-apply.ts";
import { loadTeamFile, type DesiredBot, type TeamFile } from "./team-file.ts";

type Rec = Record<string, any>;

function workspace(seed: { bots?: Rec[]; groups?: Rec[]; sections?: string[]; config?: Rec } = {}) {
  const state = {
    bots: (seed.bots ?? []).map((bot) => ({ busy: false, title: "", description: "", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, ...bot })) as Rec[],
    groups: seed.groups ?? [],
    sections: seed.sections ?? [],
    briefs: {} as Record<string, string>,
    skills: {} as Record<string, Record<string, { text: string; enabled: boolean }>>,
    config: seed.config ?? { anthropic: { configured: false, everyClaudeBot: true } },
  };
  const writes: string[] = [];
  let ids = 0;
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const json = async (path: string, init: RequestInit = {}): Promise<any> => {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== "GET") writes.push(`${method} ${path}`);
    const url = new URL(path, "http://omb");
    const m = url.pathname.split("/").slice(1);
    if (url.pathname === "/api/config") {
      if (method === "PUT") for (const [name, value] of Object.entries(body as Rec)) state.config[name] = { ...state.config[name], configured: true, ...(value.everyClaudeBot !== undefined ? { everyClaudeBot: value.everyClaudeBot } : {}) };
      return state.config;
    }
    if (url.pathname === "/api/bot-defaults") return { modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } };
    if (url.pathname === "/api/instances") return { instances: [{ instanceId: "claude", driverKind: "claudeAgent", snapshot: { state: "available" }, models: { default: "claude-sonnet-5", options: [{ id: "claude-sonnet-5" }, { id: "claude-haiku-5" }] } }] };
    if (url.pathname === "/api/sidebar-sections") {
      if (method === "POST") state.sections.push(body.name);
      return { sections: state.sections };
    }
    if (url.pathname === "/api/section-context") {
      const section = url.searchParams.get("section")!;
      if (method === "PUT") state.briefs[section] = body.text;
      return { text: state.briefs[section] ?? "" };
    }
    if (url.pathname === "/api/bots" && method === "GET") return { bots: state.bots, groups: state.groups };
    if (url.pathname === "/api/bots" && method === "POST") {
      const bot = { id: `bot-${++ids}`, busy: false, name: body.name, title: body.title ?? "", description: body.description ?? "",
        ...(body.section ? { section: body.section } : {}), modelSelection: body.modelSelection ?? { instanceId: "claude", model: "claude-sonnet-5" } };
      state.bots.push(bot);
      return { bot };
    }
    const bot = state.bots.find((candidate) => candidate.id === m[2]);
    if (m[1] === "bots" && m.length === 3 && method === "PATCH") {
      const { applyToAllThreads: _all, requireAvailableModel: _require, acknowledgePeerScope: _peer, acknowledgeLocalAuto: _local, ...fields } = body;
      Object.assign(bot!, fields);
      if (fields.computer === null) delete bot!.computer;
      return { bot };
    }
    if (m[1] === "bots" && m.length === 3 && method === "DELETE") { state.bots = state.bots.filter((candidate) => candidate !== bot); return { ok: true }; }
    if (m[1] === "bots" && m[3] === "skills" && m.length === 4) {
      return { skills: Object.entries(state.skills[bot!.id] ?? {}).map(([name, skill]) => ({ name, enabled: skill.enabled, sha256: sha(skill.text) })) };
    }
    if (m[1] === "bots" && m[3] === "skills" && m.length === 5) {
      const skills = state.skills[bot!.id] ??= {};
      if (method === "DELETE") delete skills[m[4]!];
      if (method === "PATCH") skills[m[4]!]!.enabled = body.enabled;
      return { text: skills[m[4]!]?.text };
    }
    if (m[1] === "bots" && m[3] === "skill-template") { (state.skills[bot!.id] ??= {})[body.name] = { text: body.text, enabled: body.enabled }; return {}; }
    if (m[1] === "groups" && method === "DELETE") { state.groups = state.groups.filter((group) => group.id !== m[2]); return { ok: true }; }
    throw new Error(`no route for ${method} ${path}`);
  };
  const client: HeadlessClient = {
    baseUrl: "http://omb", explicit: true, json, raw: async () => { throw new Error("no raw reads here"); },
    tool: async (name, args: Rec) => {
      writes.push(`tool ${name}`);
      if (name === "create_channel") state.groups.push({ id: `room-${++ids}`, name: args.name, memberIds: args.member_ids, section: args.section,
        bulletin: args.bulletin ?? "", defaultResponder: args.default_responder ? { kind: args.default_responder.kind, botId: args.default_responder.bot_id } : { kind: "member", botId: args.member_ids[0] } });
      if (name === "update_channel") Object.assign(state.groups.find((group) => group.id === args.channel_id)!, { ...(args.member_ids ? { memberIds: args.member_ids } : {}),
        ...(args.bulletin !== undefined ? { bulletin: args.bulletin } : {}), ...(args.section ? { section: args.section } : {}) });
      return {};
    },
  };
  return { state, writes, client };
}

const lead: DesiredBot = {
  name: "Room Lead", team: "Launch Room", chief: true, manages: [], title: "Launch rehearsal lead", soul: "Lead the rehearsal.\n",
  model: { instanceId: "claude", model: "claude-sonnet-5" }, approval: "full", computer: "off", cwd: "/work/room", tools: { deny: [] },
  skills: [{ name: "launch-report", description: "Write it.", text: "---\nname: launch-report\ndescription: Write it.\n---\nBody\n", enabled: true, file: "skills/launch-report/SKILL.md" }],
};
const priya: DesiredBot = { name: "Priya", team: "Launch Room", manages: [], title: "Skeptical buyer", approval: "full", computer: "browser",
  browser: { enabled: true, profile: "guest" }, tools: { deny: ["mcp:mail:*"] }, skills: [] };
const file = (patch: Partial<TeamFile> = {}): TeamFile => ({
  path: "/files/launch-room.yaml", engines: [], warnings: [],
  teams: [{ name: "Launch Room", brief: "We rehearse a launch.", prune: true }],
  bots: [lead, priya], rooms: [{ name: "Rehearsal", team: "Launch Room", members: ["Room Lead", "Priya"], brief: "The room.", responder: "Room Lead" }],
  ...patch,
});
const options = (patch: Partial<ApplyOptions> = {}): ApplyOptions => ({ apply: true, prune: false, rotateSecrets: false, waitIdleMs: 0, env: {}, ...patch });

describe("team apply", () => {
  it("plans without writing, applies what it planned, and then has nothing left to do", async () => {
    const { client, writes, state } = workspace();
    const plan = await reconcile(client, file(), options({ apply: false }));
    expect(plan.lines).toEqual([
      'team "Launch Room": create · brief set (1 line)',
      'bot "Room Lead": create (Chief of Launch Room · claude/claude-sonnet-5 · Full access · computer off)',
      'bot "Priya": create (team Launch Room · Full access · computer browser)',
      'room "Rehearsal": create (2 members, team Launch Room)',
    ]);
    expect(plan).toMatchObject({ created: 4, changed: 0, deleted: 0, writes: 0 });
    expect(writes).toEqual([]);

    const applied = await reconcile(client, file(), options());
    expect(applied.lines).toEqual(plan.lines);
    expect(writes).toEqual([
      "POST /api/sidebar-sections", "PUT /api/section-context?section=Launch%20Room",
      "POST /api/bots", "PATCH /api/bots/bot-1", "POST /api/bots", "PATCH /api/bots/bot-2",
      "POST /api/bots/bot-1/skill-template", "PATCH /api/bots/bot-1", "tool create_channel",
    ]);
    expect(state.bots.find((bot) => bot.name === "Priya")).toMatchObject({ section: "Launch Room", computer: "browser",
      browserProfile: "guest", toolScope: { deny: ["mcp:mail:*"] } });
    expect(approvalModeFor(state.bots.find((bot) => bot.name === "Priya")!)).toBe("full");
    expect(state.bots.find((bot) => bot.name === "Room Lead")).toMatchObject({ chiefOfStaff: true, managedSections: [], soul: "Lead the rehearsal.", cwd: "/work/room" });

    writes.length = 0;
    const second = await reconcile(client, file(), options());
    expect(second).toMatchObject({ lines: [], created: 0, changed: 0, deleted: 0, writes: 0 });
    expect(writes).toEqual([]);
  });

  it("changes only what differs, with the words for it", async () => {
    const { client, writes } = workspace();
    await reconcile(client, file(), options());
    writes.length = 0;
    const changed = file({ bots: [{ ...lead, soul: "Lead the rehearsal.\nWrite report.md.\n" }, { ...priya, title: "Careful buyer", approval: "auto" }] });
    const result = await reconcile(client, changed, options());
    expect(result.lines).toEqual([
      'bot "Room Lead": update soul 1 line changed',
      'bot "Priya": update title "Skeptical buyer" → "Careful buyer"; approval Full access → Auto',
    ]);
    expect(writes).toEqual(["PATCH /api/bots/bot-1", "PATCH /api/bots/bot-2"]);
  });

  it("keeps bots and rooms the file leaves out, and deletes them only with --prune in a team marked prune", async () => {
    const { client, writes, state } = workspace();
    await reconcile(client, file(), options());
    state.bots.push({ id: "old", name: "Old visitor", section: "Launch Room", busy: false });
    writes.length = 0;
    const kept = await reconcile(client, file(), options());
    expect(kept.lines).toEqual(['bot "Old visitor": not in file (kept; --prune deletes it)']);
    expect(writes).toEqual([]);
    const unmarked = await reconcile(client, file({ teams: [{ name: "Launch Room", prune: false }] }), options({ prune: true }));
    expect(unmarked.lines).toEqual(['bot "Old visitor": not in file (kept)']);
    const pruned = await reconcile(client, file(), options({ prune: true }));
    expect(pruned.lines).toEqual(['bot "Old visitor": delete (not in file)']);
    expect(writes).toEqual(["DELETE /api/bots/old"]);
  });

  it("replaces a skill whose SKILL.md changed and turns one on or off, keeping skills the file does not list", async () => {
    const { client, writes, state } = workspace();
    await reconcile(client, file(), options());
    state.skills["bot-1"]!["own-skill"] = { text: "mine", enabled: true };
    writes.length = 0;
    const edited = { ...lead.skills[0]!, text: `${lead.skills[0]!.text}More.\n` };
    expect((await reconcile(client, file({ bots: [{ ...lead, skills: [edited] }, priya] }), options())).lines)
      .toEqual(['skill "launch-report" for "Room Lead": replace with skills/launch-report/SKILL.md']);
    expect(writes).toEqual(["DELETE /api/bots/bot-1/skills/launch-report", "POST /api/bots/bot-1/skill-template"]);
    writes.length = 0;
    expect((await reconcile(client, file({ bots: [{ ...lead, skills: [{ ...edited, enabled: false }] }, priya] }), options())).lines)
      .toEqual(['skill "launch-report" for "Room Lead": turn off']);
    expect(writes).toEqual(["PATCH /api/bots/bot-1/skills/launch-report"]);
    expect(state.skills["bot-1"]!["own-skill"]).toEqual({ text: "mine", enabled: true });
  });

  it("writes an engine key only when none is set (or to rotate it), and never says it", async () => {
    const engine = { kind: "claude", key: { env: "ANTHROPIC_API_KEY" } };
    const env = { ANTHROPIC_API_KEY: "sk-ant-test-0123456789abcdefghij" };
    const { client, writes } = workspace();
    const first = await reconcile(client, file({ engines: [engine] }), options({ env }));
    expect(first.lines[0]).toBe("engine claude: key «redacted 32 chars»");
    expect(JSON.stringify(first)).not.toContain("sk-ant-test");
    expect(writes[0]).toBe("PUT /api/config");
    writes.length = 0;
    expect((await reconcile(client, file({ engines: [engine] }), options({ env: {} }))).lines).toEqual([]);
    expect(writes).toEqual([]);
    expect((await reconcile(client, file({ engines: [engine] }), options({ env, rotateSecrets: true }))).lines[0]).toMatch(/^engine claude: key «redacted 32 chars»/);
    await expect(reconcile(client, file({ engines: [engine] }), options({ env: {}, rotateSecrets: true }))).rejects.toThrow("ANTHROPIC_API_KEY is not set");
  });

  it("keeps a base URL given as a secret out of the plan, and reads it only when the key is written", async () => {
    const engine = { kind: "claude", key: { env: "ANTHROPIC_API_KEY" }, baseUrl: { env: "ANTHROPIC_BASE_URL" } };
    const env = { ANTHROPIC_API_KEY: "sk-ant-test-0123456789abcdefghij", ANTHROPIC_BASE_URL: "https://gw.example.com/v1/team-7f3a9c" };
    const { client } = workspace();
    const first = await reconcile(client, file({ engines: [engine] }), options({ env }));
    expect(first.lines[0]).toBe("engine claude: key «redacted 32 chars» · base URL set");
    expect(JSON.stringify(first)).not.toContain("team-7f3a9c");
    const again = await reconcile(client, file({ engines: [engine] }), options({ env: {} }));
    expect(again.lines).toEqual(["engine claude: its key is already set and the server does not show its base URL, so the file's was not compared (--rotate-secrets writes both)"]);
    expect(again).toMatchObject({ created: 0, changed: 0, writes: 0 });
  });

  it("of two bots with the file's name, changes the one in the file's team, never the other team's", async () => {
    // someone else's Priya, in Sales, listed before the team's own
    const { client, writes, state } = workspace({ sections: ["Sales", "Launch Room"], bots: [
      { id: "sales-priya", name: "Priya", section: "Sales", title: "Account manager", soul: "Sell." },
      { id: "room-priya", name: "Priya", section: "Launch Room", title: "Buyer", approvalMode: "ask" }] });
    const applied = await reconcile(client, file(), options());
    expect(applied.lines).toContain('bot "Priya": update title "Buyer" → "Skeptical buyer"; approval Ask → Full access; computer auto → browser; browser profile its own → guest; tools changed');
    expect(state.bots.find((bot) => bot.id === "sales-priya")).toEqual({ id: "sales-priya", name: "Priya", section: "Sales", title: "Account manager", soul: "Sell.",
      busy: false, description: "", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } });
    expect(state.bots.find((bot) => bot.id === "room-priya")).toMatchObject({ title: "Skeptical buyer", approvalMode: "full" });
    writes.length = 0;
    expect(await reconcile(client, file(), options())).toMatchObject({ lines: [], writes: 0 });
  });

  it("refuses a rename onto a name another bot has, before anything is written", async () => {
    const { client, writes } = workspace({ sections: ["Launch Room"], bots: [
      { id: "m1", name: "Marcus", section: "Launch Room" }, { id: "m2", name: "Marcus Lee", section: "Launch Room" }] });
    const renamed = file({ bots: [lead, priya, { name: "Marcus Lee", was: "Marcus", team: "Launch Room", manages: [], skills: [] }] });
    await expect(reconcile(client, renamed, options({ apply: false }))).rejects.toThrow('bot "Marcus Lee": both "Marcus" (its was:) and "Marcus Lee" exist');
    expect(writes).toEqual([]);
  });

  it("names a room member that is neither in the workspace nor in the file before anything is written", async () => {
    const { client, writes } = workspace();
    const stray = file({ rooms: [{ name: "Rehearsal", members: ["Room Lead", "Nobody"] }] });
    await expect(reconcile(client, stray, options({ apply: false }))).rejects.toThrow('room "Rehearsal": no bot named "Nobody"');
    expect(writes).toEqual([]);
  });

  it("waits for a busy bot, then reports it unchanged", async () => {
    const { client, state } = workspace();
    await reconcile(client, file(), options());
    state.bots.find((bot) => bot.name === "Priya")!.busy = true;
    await expect(reconcile(client, file({ bots: [lead, { ...priya, title: "Changed" }] }), options({ waitIdleMs: 0 })))
      .rejects.toThrow('"Priya" is still working after 0s, so it was not changed');
  });

  it("refuses a tool selection the bot's engine cannot hold, before anything is written", async () => {
    const { client, writes } = workspace();
    // Claude limits MCP tools only: a built-in one in the selection would stop every turn it runs
    for (const visitor of [{ ...priya, tools: { deny: ["native:Bash"] } }, { ...priya, model: { instanceId: "claude", model: "claude-haiku-5" }, tools: { deny: ["native:Bash"] } }]) {
      await expect(reconcile(client, file({ bots: [lead, visitor] }), options({ apply: false })))
        .rejects.toThrow('bot "Priya": claudeAgent: native tool selection is not supported by this engine');
    }
    expect(writes).toEqual([]);
    expect((await reconcile(client, file(), options({ apply: false }))).created).toBe(4);
  });

  it("refuses an engine or model the server does not have", async () => {
    const { client } = workspace();
    await expect(reconcile(client, file({ bots: [{ ...priya, model: { instanceId: "codex", model: "gpt-6" } }] }), options({ apply: false })))
      .rejects.toThrow('bot "Priya": no engine "codex" here');
    await expect(reconcile(client, file({ bots: [{ ...priya, model: { instanceId: "claude", model: "claude-opus-9" } }] }), options({ apply: false })))
      .rejects.toThrow('claude offers no model "claude-opus-9"');
  });
});

describe("botPatch", () => {
  const echo = { id: "b1", name: "Priya", section: "Launch Room", title: "Skeptical buyer", description: "", approvalMode: "full",
    computer: "browser", browserProfile: "guest", toolScope: { deny: ["native:Bash", "native:Write"] }, modelSelection: { instanceId: "claude", model: "claude-sonnet-5", effort: "high" } };

  const same: DesiredBot = { ...priya, tools: { deny: ["native:Write", "native:Bash"] } };

  it("finds nothing to change when the echo already matches, whatever the order of tool selectors", () => {
    expect(botPatch({ ...same, model: { instanceId: "claude", model: "claude-sonnet-5" } }, echo, "Launch Room")).toEqual({ patch: {}, changes: [] });
    expect(botPatch(priya, echo, "Launch Room")).toEqual({ patch: { toolScope: { deny: ["mcp:mail:*"] } }, changes: ["tools changed"] });
  });

  it("reads every way of selecting every tool as the same, and clears a selection to get there", () => {
    const everything: DesiredBot = { ...same, tools: null };
    expect(botPatch(everything, { ...echo, toolScope: undefined }, "Launch Room")).toEqual({ patch: {}, changes: [] });
    expect(botPatch(everything, { ...echo, toolScope: { deny: [] } }, "Launch Room")).toEqual({ patch: {}, changes: [] });
    expect(botPatch(everything, echo, "Launch Room")).toEqual({ patch: { toolScope: null }, changes: ["tools: every tool"] });
    expect(botPatch({ ...same, tools: { allow: [] } }, { ...echo, toolScope: undefined }, "Launch Room").patch).toEqual({ toolScope: { allow: [] } });
  });

  it("sends Auto on this computer's confirmation whenever the change leaves the bot there, and only then", () => {
    expect(botPatch({ ...same, computer: "local", approval: "auto" }, echo, "Launch Room").patch).toMatchObject({
      computer: "local", approvalMode: "auto", applyToAllThreads: true, acknowledgeLocalAuto: true });
    expect(botPatch({ ...same, computer: "local" }, echo, "Launch Room").patch).not.toHaveProperty("acknowledgeLocalAuto");
    expect(botPatch({ ...same, approval: "auto", computer: undefined }, { ...echo, computer: "local" }, "Launch Room").patch)
      .toEqual({ approvalMode: "auto", applyToAllThreads: true, acknowledgeLocalAuto: true });
    expect(botPatch({ ...same, approval: undefined, computer: "local" }, { ...echo, approvalMode: "auto" }, "Launch Room").patch)
      .toEqual({ computer: "local", acknowledgeLocalAuto: true });
    expect(botPatch({ ...same, approval: "auto" }, echo, "Launch Room").patch).not.toHaveProperty("acknowledgeLocalAuto");
  });

  it("changes the model, keeps an effort the file does not name, and moves a bot to Auto computer with null", () => {
    expect(botPatch({ ...same, model: { instanceId: "claude", model: "claude-haiku-5" } }, echo, "Launch Room")).toEqual({
      patch: { modelSelection: { instanceId: "claude", model: "claude-haiku-5", effort: "high" }, requireAvailableModel: true },
      changes: ["model claude/claude-sonnet-5 (high) → claude/claude-haiku-5 (high)"] });
    expect(botPatch({ ...same, model: { instanceId: "codex", model: "gpt-6" } }, echo, "Launch Room").patch.modelSelection).toEqual({ instanceId: "codex", model: "gpt-6" });
    expect(botPatch({ ...same, effort: "low" }, echo, "Launch Room").patch.modelSelection).toEqual({ instanceId: "claude", model: "claude-sonnet-5", effort: "low" });
    expect(botPatch({ ...same, computer: "auto" }, echo, "Launch Room")).toEqual({ patch: { computer: null }, changes: ["computer browser → auto"] });
  });
});

describe("team export", () => {
  it("names a skill's file with /, so a file exported on Windows applies on Linux", () => {
    expect(skillFilePath("room-lead", "launch-report")).toBe("skills/room-lead/launch-report/SKILL.md");
  });

  it("gives bots whose names make the same folder name their own skill folders", async () => {
    expect(botSkillDirs(["Room Lead", "!!!", "Room-Lead", "Room Lead 2"])).toEqual(["room-lead", "bot", "room-lead-2", "room-lead-2-2"]);
    const skill = (body: string) => `---\nname: common\ndescription: Shared.\n---\n${body}\n`;
    const { client, state } = workspace({ bots: [{ id: "bot-a", name: "Dev A" }, { id: "bot-b", name: "Dev-A" }, { id: "bot-c", name: "Dev A 2" }] });
    state.skills["bot-a"] = { common: { text: skill("first"), enabled: true } };
    state.skills["bot-b"] = { common: { text: skill("second"), enabled: true } };
    state.skills["bot-c"] = { common: { text: skill("third"), enabled: true } };
    const dir = mkdtempSync(join(tmpdir(), "omb-team-export-"));
    try {
      const out = join(dir, "team.yaml");
      const ctx = { verb: "team export", flags: { out }, positionals: [], env: {}, io: { out: () => undefined, err: () => undefined, readStdin: async () => "" },
        output: new Output({ out: () => undefined, err: () => undefined, readStdin: async () => "" }, {}), client: async () => client,
        signal: new AbortController().signal, defaultWaitMs: 1_000 } as VerbContext;
      await teamExportVerb(ctx);
      const back = loadTeamFile(out);
      expect(back.bots.map((bot) => [bot.name, bot.skills.map((s) => s.text.trim().split("\n").at(-1))])).toEqual([
        ["Dev A", ["first"]], ["Dev-A", ["second"]], ["Dev A 2", ["third"]],
      ]);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("takes a key written into a soul, a brief or a skill out of the file, and apply leaves those as they are", async () => {
    const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
    const { client, writes, state } = workspace();
    await reconcile(client, file(), options());
    state.bots.find((bot) => bot.name === "Room Lead")!.soul = `Lead the rehearsal. Pay with ${KEY}.`;
    state.briefs["Launch Room"] = `We rehearse a launch. The staging key is ${KEY}.`;
    state.skills["bot-1"]!["launch-report"]!.text = `---\nname: launch-report\ndescription: Write it.\n---\nUpload with ${KEY}\n`;
    const dir = mkdtempSync(join(tmpdir(), "omb-team-export-"));
    try {
      const out = join(dir, "team.yaml");
      const ctx = { verb: "team export", flags: { out }, positionals: [], env: {}, io: { out: () => undefined, err: () => undefined, readStdin: async () => "" },
        output: new Output({ out: () => undefined, err: () => undefined, readStdin: async () => "" }, {}), client: async () => client,
        signal: new AbortController().signal, defaultWaitMs: 1_000 } as VerbContext;
      const exported = await teamExportVerb(ctx);
      expect((exported.result as Rec).redacted).toEqual(['team "Launch Room" brief', 'bot "Room Lead" soul', 'bot "Room Lead" skill launch-report']);
      const written = [readFileSync(out, "utf8"), readFileSync(join(dir, "skills/room-lead/launch-report/SKILL.md"), "utf8")].join("\n");
      expect(written).not.toContain(KEY);
      expect(written).toContain("«redacted");
      const back = loadTeamFile(out);
      expect(back.bots.find((bot) => bot.name === "Room Lead")).not.toHaveProperty("soul");
      expect(back.bots.find((bot) => bot.name === "Room Lead")!.skills).toEqual([]);
      expect(back.teams[0]).not.toHaveProperty("brief");
      expect(back.warnings).toEqual(expect.arrayContaining(['bot "Room Lead": its soul has a secret taken out («redacted …»), so it is left as it is']));
      writes.length = 0;
      expect(await reconcile(client, back, options())).toMatchObject({ created: 0, changed: 0, deleted: 0, writes: 0 });
      expect(state.bots.find((bot) => bot.name === "Room Lead")!.soul).toContain(KEY);
    } finally {
      await removeTempDir(dir);
    }
  });
});
