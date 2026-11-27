import { afterEach, describe, expect, it, vi } from "vitest";

import { api, persistBotUpdate, type Bot } from "@/state/store";
import { BotCreationDraft, EMPTY_BOT_DEFAULTS } from "./bot-creation-draft";
import { chosenPreset, presetDraftPatch, presetGroups, presetPictureFile, presetSummaryLines, type BotPreset } from "./bot-presets";
import { createConfiguredBot } from "./create-configured-bot";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function preset(overrides: Partial<BotPreset> = {}): BotPreset {
  return {
    id: "p1", source: "file", key: "support", name: "Support agent", description: "Kind and precise.", packageName: "Sales skills", release: "2.0.1",
    bot: { name: "Sky", title: "Support", soul: "Be kind.\n", appearance: { color: "blue", mascotExpression: "happy", avatar: { mime: "image/png", data: PNG, crop: "rounded" } } },
    skills: [{ name: "objection-handling", description: "Answer common objections." }], skillsEnabled: false,
    playbooks: ["Qualify a lead"], notes: ["MEMORY.md"],
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("presets in New bot", () => {
  it("lists organization presets under their publisher, then imported ones", () => {
    const groups = presetGroups([
      preset({ id: "o1", source: "org", publisherName: "Acme Partners", name: "Closer" }),
      preset({ id: "o2", source: "org", publisherName: "Acme Partners", name: "Opener" }),
      preset({ id: "f1" }),
    ]);
    expect(groups.map((group) => [group.label, group.presets.map((entry) => entry.id)])).toEqual([
      ["From Acme Partners", ["o1", "o2"]],
      ["Imported presets", ["f1"]],
    ]);
  });

  it("fills only the name, words and look: never a model, computer, approval or connected apps", () => {
    const patch = presetDraftPatch(preset());
    expect(patch).toEqual({ name: "Sky", title: "Support", description: "", soul: "Be kind.\n", color: "blue", mascotExpression: "happy" });
    expect(presetDraftPatch(preset({ bot: {} })).name).toBe("Support agent");
    const draft = new BotCreationDraft({ ...EMPTY_BOT_DEFAULTS, profile: { approvalMode: "auto", computer: "local", composio: true, modelSelection: { instanceId: "claude", model: "opus" } } }, vi.fn());
    draft.patch(patch);
    expect(draft.template.profile).toMatchObject({ approvalMode: "auto", computer: "local", composio: true, modelSelection: { instanceId: "claude", model: "opus" } });
  });

  it("turns the preset's picture into a file the draft uploads like any picture", async () => {
    const file = presetPictureFile(preset())!;
    expect(file.type).toBe("image/png");
    expect(new Uint8Array(await file.arrayBuffer()).slice(0, 4)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    expect(presetPictureFile(preset({ bot: { name: "Sky" } }))).toBeNull();
  });

  it("says where a preset came from and what it adds, switched on only from the organization", () => {
    expect(presetSummaryLines(preset())).toEqual([
      "From Sales skills 2.0.1", "Kind and precise.", "Skills, added switched off: objection-handling",
      "Starter notes: MEMORY.md", "Playbooks: Qualify a lead", "The model, where it works, approval level and connected apps stay as set here.",
    ]);
    expect(presetSummaryLines(preset({ source: "org", publisherName: "Acme Partners", skillsEnabled: true })).slice(0, 3)).toEqual([
      "From Sales skills 2.0.1 · Acme Partners", "Kind and precise.", "Skills, added switched on: objection-handling",
    ]);
  });

  it("creates the bot with the preset, leaving the preset's skills and notes to the server", async () => {
    const draft = new BotCreationDraft({
      ...EMPTY_BOT_DEFAULTS,
      memory: { "MEMORY.md": "defaults index", "memory/other.md": "kept" },
      skills: [
        { name: "objection-handling", description: "d", source: "x", text: "---\nname: objection-handling\ndescription: d\n---\n", enabled: true, warnings: [] },
        { name: "follow-up", description: "d", source: "x", text: "---\nname: follow-up\ndescription: d\n---\n", enabled: false, warnings: [] },
      ],
    }, vi.fn());
    draft.patch({ ...presetDraftPatch(preset()) });
    draft.choosePreset(chosenPreset(preset()));
    const calls: Array<{ path: string; body: any }> = [];
    let bot = { ...draft.bot, id: "created", threadId: "initial" } as Bot;
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls.push({ path: `${init?.method} ${path}`, body });
      if (init?.method === "PATCH") bot = { ...bot, ...body };
      return { bot };
    }) as unknown as typeof api;
    await createConfiguredBot(draft, request, persistBotUpdate);
    expect(calls[0]).toMatchObject({ path: "POST /api/bots", body: { preset: "p1", name: "Sky", useDefaults: false } });
    expect(calls.filter((call) => call.path.endsWith("/memory/file")).map((call) => call.body.path)).toEqual(["memory/other.md"]);
    expect(calls.filter((call) => call.path.endsWith("/skill-template")).map((call) => call.body.name)).toEqual(["follow-up"]);
    draft.choosePreset(undefined);
    calls.length = 0;
    await createConfiguredBot(draft, request, persistBotUpdate);
    expect(calls[0]!.body).not.toHaveProperty("preset");
  });
});
