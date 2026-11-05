import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SkillRequestCardData, SkillSwitchAction } from "../../shared/skill-request.ts";
import type { OptionCardData } from "../../shared/wire.ts";
import { flushDecisionLog } from "../decision-log.ts";
import type { BotRecord } from "../store.ts";

const mocks = vi.hoisted(() => ({ setImportedSkillEnabled: vi.fn() }));
vi.mock("../imported-skills.ts", () => ({ setImportedSkillEnabled: mocks.setImportedSkillEnabled }));
vi.mock("../skills.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../skills.ts")>()),
  listSkills: () => [],
  readSkillFile: () => null,
}));

import { createSkillSwitchHost } from "./skill-switch-host.ts";

const skillMd = (key: string) => `---\nname: lookup\ndescription: Looks things up\n---\nkey: sk-ant-api03-${key.repeat(40)}\n`;
const dirs: string[] = [];

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "skill-switch-host-"));
  dirs.push(dataDir);
  const bot = { id: "b1", name: "Bot", color: "blue" } as BotRecord;
  const messages: Array<{ id: string; card: OptionCardData }> = [];
  let file = skillMd("A");
  let enabled = true;
  let appendFails = false;
  const host = createSkillSwitchHost({
    store: {
      bot: () => bot,
      appendMessage: ((_threadId: string, message: { card: OptionCardData }) => { if (appendFails) throw new Error("disk full"); messages.push({ id: `m${messages.length}`, card: message.card }); }) as never,
      patchMessage: ((_threadId: string, id: string, patch: { card: OptionCardData }) => { messages.find((message) => message.id === id)!.card = patch.card; }) as never,
    },
    dataDir,
    persistence: () => ({ ok: true }),
    listBotSkills: () => [{ name: "lookup", enabled, source: "imported", description: "Looks things up", origin: "imported" } as never],
    readBotSkillFile: () => file,
    noteSkillChange: vi.fn(),
  });
  const card = () => messages.at(-1)!.card;
  const approve = () => {
    const { id, card: shown } = messages.at(-1)!;
    const request = shown.skillRequest as SkillRequestCardData & { action: SkillSwitchAction };
    return host.resolve({ botId: bot.id, threadId: "t1", requestId: request.requestId, behavior: "allow", reviewedSha256: request.sha256 }, id, shown, request);
  };
  const pins = () => { try { return readdirSync(join(dataDir, "skill-switch")); } catch { return []; } };
  const undo = () => {
    const { id, card: shown } = messages.at(-1)!;
    const request = shown.skillRequest as SkillRequestCardData & { action: SkillSwitchAction };
    return host.undo(bot.id, "t1", { id, card: shown } as never, request);
  };
  return { bot, host, card, approve, undo, pins, edit: (next: string) => { file = next; }, failAppend: () => { appendFails = true; }, setEnabled: (next: boolean) => { enabled = next; } };
}

beforeEach(() => {
  mocks.setImportedSkillEnabled.mockReset().mockReturnValue({ name: "lookup", enabled: false });
});
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await flushDecisionLog(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("skill switch cards", () => {
  it("turns off an imported skill only after the person approves when changes wait for the owner", () => {
    const { bot, host, card, approve, pins } = setup();
    expect(host.stage(bot, "t1", "disable", { skill_name: "lookup" }, null)).toMatchObject({ status: 201, body: { state: "pending" } });
    expect(card()).toMatchObject({ title: "Turn off skill \"lookup\"?", options: ["Turn off", "Deny"] });
    expect(card().skillRequest?.preview).not.toContain("AAAA");
    expect(mocks.setImportedSkillEnabled).not.toHaveBeenCalled();
    expect(pins()).toHaveLength(1);

    expect(approve()).toEqual({ claimed: true, outcome: "allowed-once" });
    expect(mocks.setImportedSkillEnabled).toHaveBeenCalledWith("b1", "lookup", false);
    expect(card()).toMatchObject({ answered: "allow", title: "Skill \"lookup\" turned off" });
    expect(pins()).toHaveLength(0);
  });

  it("refuses approval when a hidden secret changed after the card opened", () => {
    const { bot, host, card, approve, edit } = setup();
    expect(host.stage(bot, "t1", "disable", { skill_name: "lookup" }, null).status).toBe(201);
    const shown = card().skillRequest?.sha256;
    // Same length, so the redacted preview and the card's sha256 stay the same.
    edit(skillMd("B"));
    expect(approve()).toEqual({ claimed: true, status: 422, error: expect.stringContaining("changed after this card was shown") });
    expect(card().skillRequest?.sha256).toBe(shown);
    expect(card().held).toContain("changed after this card was shown");
    expect(mocks.setImportedSkillEnabled).not.toHaveBeenCalled();
  });

  it("leaves no digest pin behind when the card can't be added", () => {
    const { bot, host, pins, failAppend } = setup();
    failAppend();
    expect(() => host.stage(bot, "t1", "disable", { skill_name: "lookup" }, null)).toThrow("disk full");
    expect(pins()).toHaveLength(0);
  });

  it("turns off an imported skill at once where the bot's own changes apply directly, and undoes it from the receipt", () => {
    const { bot, host, card, undo, pins, setEnabled } = setup();
    expect(host.stage(bot, "t1", "disable", { skill_name: "lookup" }, "full-access")).toMatchObject({
      status: 201, body: { state: "applied", name: "lookup", action: "disable", summary: "Skill \"lookup\" turned off." },
    });
    expect(mocks.setImportedSkillEnabled).toHaveBeenCalledWith("b1", "lookup", false);
    expect(card()).toMatchObject({ answered: "allow", autoApplied: true, options: [], title: "Skill \"lookup\" turned off" });
    expect(card().skillRequest?.preview).not.toContain("AAAA");
    expect(pins()).toHaveLength(0);

    setEnabled(false);
    expect(undo()).toEqual({ claimed: true, state: "undone" });
    expect(mocks.setImportedSkillEnabled).toHaveBeenLastCalledWith("b1", "lookup", true);
    expect(card().undone).toBe(true);
  });

  it("refuses Undo, changing nothing, once the skill was switched back since", () => {
    const { bot, host, undo } = setup();
    expect(host.stage(bot, "t1", "disable", { skill_name: "lookup" }, "level").body.state).toBe("applied");
    mocks.setImportedSkillEnabled.mockClear();
    expect(undo()).toMatchObject({ claimed: true, state: "invalid", status: 409, stale: true });
    expect(mocks.setImportedSkillEnabled).not.toHaveBeenCalled();
  });

  it("reports a switch that fails to apply directly, with no receipt", () => {
    const { bot, host, card } = setup();
    mocks.setImportedSkillEnabled.mockReturnValue({ error: "the skill folder is gone" });
    expect(host.stage(bot, "t1", "disable", { skill_name: "lookup" }, "self")).toEqual({ status: 422, body: { state: "failed", error: "the skill folder is gone" } });
    expect(() => card()).toThrow();
  });
});
