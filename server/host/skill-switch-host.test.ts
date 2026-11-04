import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SkillRequestCardData, SkillSwitchAction } from "../../shared/skill-request.ts";
import type { OptionCardData } from "../../shared/wire.ts";
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
  const host = createSkillSwitchHost({
    store: {
      bot: () => bot,
      appendMessage: ((_threadId: string, message: { card: OptionCardData }) => { messages.push({ id: `m${messages.length}`, card: message.card }); }) as never,
      patchMessage: ((_threadId: string, id: string, patch: { card: OptionCardData }) => { messages.find((message) => message.id === id)!.card = patch.card; }) as never,
    },
    dataDir,
    persistence: () => ({ ok: true }),
    listBotSkills: () => [{ name: "lookup", enabled: true, source: "imported", description: "Looks things up", origin: "imported" } as never],
    readBotSkillFile: () => file,
    noteSkillChange: vi.fn(),
  });
  const card = () => messages.at(-1)!.card;
  const approve = () => {
    const { id, card: shown } = messages.at(-1)!;
    const request = shown.skillRequest as SkillRequestCardData & { action: SkillSwitchAction };
    return host.resolve({ botId: bot.id, threadId: "t1", requestId: request.requestId, behavior: "allow", reviewedSha256: request.sha256 }, id, shown, request);
  };
  const pins = () => readdirSync(join(dataDir, "skill-switch"));
  return { bot, host, card, approve, pins, edit: (next: string) => { file = next; } };
}

beforeEach(() => {
  mocks.setImportedSkillEnabled.mockReset().mockReturnValue({ name: "lookup", enabled: false });
});
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("skill switch cards", () => {
  it("turns off an imported skill only after the person approves", () => {
    const { bot, host, card, approve, pins } = setup();
    expect(host.stage(bot, "t1", "disable", { skill_name: "lookup" })).toMatchObject({ status: 201, body: { state: "pending" } });
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
    expect(host.stage(bot, "t1", "disable", { skill_name: "lookup" }).status).toBe(201);
    const shown = card().skillRequest?.sha256;
    // Same length, so the redacted preview and the card's sha256 stay the same.
    edit(skillMd("B"));
    expect(approve()).toEqual({ claimed: true, status: 422, error: expect.stringContaining("changed after this card was shown") });
    expect(card().skillRequest?.sha256).toBe(shown);
    expect(card().held).toContain("changed after this card was shown");
    expect(mocks.setImportedSkillEnabled).not.toHaveBeenCalled();
  });
});
