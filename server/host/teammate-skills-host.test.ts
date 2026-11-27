import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { SkillRequestCardData } from "../../shared/skill-request.ts";
import type { OptionCardData } from "../../shared/wire.ts";
import { flushDecisionLog } from "../decision-log.ts";
import type { SwitchableSkill } from "../skill-switch.ts";
import type { BotRecord } from "../store.ts";

import { createTeammateSkillsHost } from "./teammate-skills-host.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await flushDecisionLog(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

type Skill = { kind: SwitchableSkill["kind"]; enabled: boolean; text: string };

function setup(options: { chief?: boolean; refuse?: string[]; failTurn?: string; throwTurn?: string; failBack?: string; room?: boolean } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "teammate-skills-host-"));
  dirs.push(dataDir);
  const bots: Record<string, BotRecord> = {
    chief: { id: "chief", name: "Chief", color: "blue", chiefOfStaff: options.chief !== false } as BotRecord,
    writer: { id: "writer", name: "Writer", color: "red" } as BotRecord,
    coder: { id: "coder", name: "Coder", color: "green" } as BotRecord,
  };
  const skills = new Map<string, Skill>([
    ["writer/research", { kind: "own", enabled: false, text: "---\nname: research\n---\n" }],
    ["writer/lint", { kind: "own", enabled: true, text: "---\nname: lint\n---\n" }],
    ["coder/lint", { kind: "own", enabled: true, text: "---\nname: lint\n---\n" }],
    ["coder/pulled", { kind: "imported", enabled: false, text: "---\nname: pulled\n---\n" }],
    ["coder/org", { kind: "fixed", enabled: true, text: "---\nname: org\n---\n" }],
  ]);
  const messages: Array<{ id: string; card: OptionCardData }> = [];
  const turns: string[] = [];
  const host = createTeammateSkillsHost({
    store: {
      bot: (id: string) => bots[id],
      groupByThread: () => (options.room ? ({} as never) : undefined),
      appendMessage: ((_threadId: string, message: { card: OptionCardData }) => { messages.push({ id: `m${messages.length}`, card: message.card }); }) as never,
      patchMessage: ((_threadId: string, id: string, patch: { card: OptionCardData }) => { messages.find((message) => message.id === id)!.card = patch.card; }) as never,
    } as never,
    dataDir,
    persistence: () => ({ ok: true }),
    refusal: (_from, target) => (options.refuse?.includes(target) ? "that bot is not in a department this Chief manages" : null),
    skill: (bot, name) => {
      const skill = skills.get(`${bot.id}/${name}`);
      return skill ? { kind: skill.kind, enabled: skill.enabled, text: skill.text, source: "conversation", description: name } : undefined;
    },
    turn: (botId, name, on) => {
      if (options.failTurn === `${botId}/${name}`) return { error: "disk full" };
      if (options.throwTurn === `${botId}/${name}`) throw Object.assign(new Error("ENOSPC: no space left on device, open '/data/skills/lint.md'"), { code: "ENOSPC" });
      if (options.failBack === `${botId}/${name}` && turns.includes(`${botId}/${name}=${!on}`)) return { error: "files changed" };
      skills.get(`${botId}/${name}`)!.enabled = on;
      turns.push(`${botId}/${name}=${on}`);
      return { name, enabled: on };
    },
    noteSkillChange: () => {},
  });
  const enabled = (key: string) => skills.get(key)!.enabled;
  const card = () => messages.at(-1)!.card;
  const request = () => card().skillRequest as SkillRequestCardData;
  const approve = (behavior: "allow" | "deny" = "allow") =>
    host.resolve({ botId: "chief", threadId: "t1", requestId: request().requestId, behavior, reviewedSha256: request().sha256 }, messages.at(-1)!.id, card(), request());
  const undo = () => host.undo("chief", "t1", { id: messages.at(-1)!.id, card: card() } as never, request());
  const records = () => { try { return readdirSync(join(dataDir, "teammate-skills")); } catch { return []; } };
  const edit = (key: string, text: string) => { skills.get(key)!.text = text; };
  return { bots, host, enabled, card, request, approve, undo, records, turns, edit, messages };
}

const both = { changes: [{ bot_id: "writer", skill_name: "research", on: true }, { bot_id: "coder", skill_name: "lint", on: false }] };

describe("a Chief of Staff changing its teammates' skills", () => {
  it("turns every listed skill on or off at once, with one receipt and one Undo", () => {
    const t = setup();
    expect(t.host.stage(t.bots.chief!, "t1", both, "self")).toMatchObject({ status: 201, body: { state: "applied", changes: 2 } });
    expect(t.enabled("writer/research")).toBe(true);
    expect(t.enabled("coder/lint")).toBe(false);
    expect(t.messages).toHaveLength(1);
    expect(t.card()).toMatchObject({ answered: "allow", autoApplied: true, title: "Skills changed on your team (2)", options: [] });
    expect(t.request().teammates).toEqual([
      { botId: "writer", botName: "Writer", name: "research", action: "enable" },
      { botId: "coder", botName: "Coder", name: "lint", action: "disable" },
    ]);
    expect(t.request().preview).toBe("@Writer: turn on \"research\"\n@Coder: turn off \"lint\"");

    expect(t.undo()).toEqual({ claimed: true, state: "undone" });
    expect(t.enabled("writer/research")).toBe(false);
    expect(t.enabled("coder/lint")).toBe(true);
    expect(t.card().undone).toBe(true);
  });

  it("refuses a bot that is not a Chief of Staff and changes nothing", () => {
    const t = setup({ chief: false });
    expect(t.host.stage(t.bots.chief!, "t1", both, "self")).toMatchObject({ status: 403 });
    expect(t.turns).toEqual([]);
    expect(t.messages).toEqual([]);
  });

  it("changes none when any one change is not allowed, and names every problem", () => {
    const t = setup({ refuse: ["coder"] });
    const result = t.host.stage(t.bots.chief!, "t1", {
      changes: [...both.changes, { bot_id: "writer", skill_name: "missing", on: true }],
    }, "self");
    expect(result.status).toBe(422);
    expect(result.body.error).toMatch(/^Nothing was changed\. /);
    expect(result.body.error).toContain("Coder: that bot is not in a department this Chief manages");
    expect(result.body.error).toContain("Writer:");
    expect(t.turns).toEqual([]);
    expect(t.messages).toEqual([]);
  });

  it("keeps the rules of a bot's own switch: only the person turns on an imported skill, and org skills stay fixed", () => {
    const t = setup();
    const imported = t.host.stage(t.bots.chief!, "t1", { changes: [{ bot_id: "coder", skill_name: "pulled", on: true }] }, "self");
    const fixed = t.host.stage(t.bots.chief!, "t1", { changes: [{ bot_id: "coder", skill_name: "org", on: false }] }, "self");
    expect(imported.status).toBe(422);
    expect(fixed.status).toBe(422);
    expect(t.turns).toEqual([]);
  });

  it("refuses the Chief's own skills, repeated changes and empty lists", () => {
    const t = setup();
    expect(t.host.stage(t.bots.chief!, "t1", { changes: [{ bot_id: "chief", skill_name: "x", on: true }] }, "self").status).toBe(422);
    expect(t.host.stage(t.bots.chief!, "t1", { changes: [both.changes[0], both.changes[0]] }, "self").status).toBe(400);
    expect(t.host.stage(t.bots.chief!, "t1", { changes: [] }, "self").status).toBe(400);
    expect(t.host.stage(t.bots.chief!, "t1", { changes: [{ bot_id: "writer", skill_name: "research" }] }, "self").status).toBe(400);
    expect(t.turns).toEqual([]);
  });

  it("puts back the ones already turned when a later one fails", () => {
    const t = setup({ failTurn: "coder/lint" });
    const result = t.host.stage(t.bots.chief!, "t1", both, "self");
    expect(result).toMatchObject({ status: 422, body: { state: "failed" } });
    expect(result.body.error).toContain("Nothing was changed");
    expect(t.enabled("writer/research")).toBe(false);
    expect(t.enabled("coder/lint")).toBe(true);
    expect(t.messages).toEqual([]);
  });

  it("puts back the ones already turned when a later one throws", () => {
    const t = setup({ throwTurn: "coder/lint" });
    const result = t.host.stage(t.bots.chief!, "t1", both, "self");
    expect(result).toMatchObject({ status: 422, body: { state: "failed" } });
    expect(result.body.error).toContain("could not save the change (ENOSPC)");
    expect(result.body.error).not.toContain("/data/");
    expect(result.body.error).toContain("Nothing was changed");
    expect(t.enabled("writer/research")).toBe(false);
    expect(t.records()).toHaveLength(0);
  });

  it("names the skills it could not put back instead of saying nothing was changed", () => {
    const t = setup({ failTurn: "coder/lint", failBack: "writer/research" });
    const result = t.host.stage(t.bots.chief!, "t1", both, "self");
    expect(result).toMatchObject({ status: 422, body: { state: "failed" } });
    expect(result.body.error).not.toContain("Nothing was changed");
    expect(result.body.error).toContain('still changed: Writer, "research"');
    expect(t.enabled("writer/research")).toBe(true);
  });

  it("waits on one card when changes wait for the person, and applies all on approval", () => {
    const t = setup();
    expect(t.host.stage(t.bots.chief!, "t1", both, null)).toMatchObject({ status: 201, body: { state: "pending" } });
    expect(t.card()).toMatchObject({ title: "Change skills on your team (2)?", options: ["Apply", "Deny"] });
    expect(t.turns).toEqual([]);
    expect(t.records()).toHaveLength(1);

    expect(t.approve()).toEqual({ claimed: true, outcome: "allowed-once" });
    expect(t.enabled("writer/research")).toBe(true);
    expect(t.enabled("coder/lint")).toBe(false);
    expect(t.card()).toMatchObject({ answered: "allow", title: "Skills changed on your team (2)" });
    expect(t.records()).toHaveLength(1);

    expect(t.undo()).toEqual({ claimed: true, state: "undone" });
    expect(t.enabled("writer/research")).toBe(false);
    expect(t.enabled("coder/lint")).toBe(true);
    expect(t.records()).toHaveLength(0);
  });

  it("always waits on the card in a room", () => {
    const t = setup({ room: true });
    expect(t.host.stage(t.bots.chief!, "t1", both, "self")).toMatchObject({ status: 201, body: { state: "pending" } });
    expect(t.turns).toEqual([]);
  });

  it("changes nothing on Deny", () => {
    const t = setup();
    t.host.stage(t.bots.chief!, "t1", both, null);
    expect(t.approve("deny")).toEqual({ claimed: true, outcome: "rejected" });
    expect(t.turns).toEqual([]);
    expect(t.records()).toHaveLength(0);
  });

  it("refuses approval, changing none, when any skill changed after the card opened", () => {
    const t = setup();
    t.host.stage(t.bots.chief!, "t1", both, null);
    t.edit("coder/lint", "---\nname: lint\n---\nnew words\n");
    const result = t.approve();
    expect(result).toMatchObject({ claimed: true, status: 422 });
    expect(t.turns).toEqual([]);
    expect(t.card().held).toContain("Nothing was changed");
  });

  it("refuses approval when the Chief no longer manages a teammate on the card", () => {
    const refuse: string[] = [];
    const t = setup({ refuse });
    t.host.stage(t.bots.chief!, "t1", both, null);
    refuse.push("writer");
    expect(t.approve()).toMatchObject({ claimed: true, status: 422 });
    expect(t.turns).toEqual([]);
  });

  it("refuses Undo, changing none, once any listed skill moved on", () => {
    const t = setup();
    t.host.stage(t.bots.chief!, "t1", both, "self");
    t.turns.length = 0;
    const lint = t.host.stage(t.bots.chief!, "t2", { changes: [{ bot_id: "coder", skill_name: "lint", on: true }] }, "self");
    expect(lint.status).toBe(201);
    t.messages.pop();
    t.turns.length = 0;
    expect(t.undo()).toMatchObject({ claimed: true, state: "invalid", stale: true });
    expect(t.turns).toEqual([]);
    expect(t.enabled("writer/research")).toBe(true);
  });

  it("refuses Undo, changing none, once a listed skill's content changed though it is still on", () => {
    const t = setup();
    t.host.stage(t.bots.chief!, "t1", both, "self");
    t.turns.length = 0;
    t.edit("writer/research", "---\nname: research\n---\nnew words\n");
    expect(t.undo()).toMatchObject({ claimed: true, state: "invalid", stale: true });
    expect(t.turns).toEqual([]);
    expect(t.enabled("writer/research")).toBe(true);
    expect(t.enabled("coder/lint")).toBe(false);
  });

  it("refuses Undo, changing none, when the Chief no longer manages a listed teammate", () => {
    const refuse: string[] = [];
    const t = setup({ refuse });
    t.host.stage(t.bots.chief!, "t1", both, "self");
    t.turns.length = 0;
    refuse.push("coder");
    const result = t.undo();
    expect(result).toMatchObject({ claimed: true, state: "invalid", status: 403 });
    expect("error" in result && result.error).toContain("Coder");
    expect(t.turns).toEqual([]);
    expect(t.enabled("writer/research")).toBe(true);
    expect(t.enabled("coder/lint")).toBe(false);
  });

  it("keeps no record when applying fails", () => {
    const t = setup({ failTurn: "coder/lint" });
    expect(t.host.stage(t.bots.chief!, "t1", both, "self")).toMatchObject({ status: 422 });
    expect(t.records()).toHaveLength(0);
  });
});
