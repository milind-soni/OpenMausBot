import { describe, expect, it, vi } from "vitest";
import { BotCreationDraft, EMPTY_BOT_DEFAULTS } from "./bot-creation-draft";
import { api } from "@/state/store";

describe("isolated creation draft", () => {
  it("keeps profile, memory and routine edits local until commitment", async () => {
    const network = vi.fn();
    const draft = new BotCreationDraft(EMPTY_BOT_DEFAULTS, vi.fn(), network as typeof api);
    draft.patch({ name: "Ada", approvalMode: "full", confirmFullAccess: true });
    draft.setMemory("MEMORY.md", "A synthetic preference");
    await draft.request("/api/routines", { method: "POST", body: JSON.stringify({ botId: draft.id,
      name: "Status", prompt: "Check status", schedule: { type: "daily", time: "09:00", weekdays: [1] } }) });
    const template = draft.export();
    expect(network).not.toHaveBeenCalled();
    expect(template.profile).toEqual({ name: "Ada", approvalMode: "full" });
    expect(template.memory).toEqual({ "MEMORY.md": "A synthetic preference" });
    expect(template.routines[0]).not.toHaveProperty("botId");
    expect(template.routines[0]).not.toHaveProperty("id");
    draft.dispose();
    expect(network).not.toHaveBeenCalled();
  });

  it("makes independent copies and new routine identities for every draft", () => {
    const defaults = { ...EMPTY_BOT_DEFAULTS, profile: { name: "Default" }, routines: [{
      name: "Status", prompt: "Check status", enabled: false, schedule: { type: "once" as const, at: 123456789 },
    }] };
    const first = new BotCreationDraft(defaults, vi.fn());
    const second = new BotCreationDraft(defaults, vi.fn());
    first.patch({ name: "Changed" });
    expect(defaults.profile.name).toBe("Default");
    expect(second.bot.name).toBe("Default");
    expect(first.id).not.toBe(second.id);
    expect(first.routines[0].id).not.toBe(second.routines[0].id);
    expect(first.routines[0].botId).toBe(first.id);
    expect(second.routines[0].enabled).toBe(false);
  });

  it("refuses unsupported and cross-bot operations rather than reaching the live API", async () => {
    const network = vi.fn();
    const draft = new BotCreationDraft(EMPTY_BOT_DEFAULTS, vi.fn(), network as typeof api);
    for (const path of ["/api/bots/real-bot", `/api/bots/${draft.id}/messages`, "/api/routines/real-id"]) {
      await expect(draft.request(path, { method: "POST" })).rejects.toThrow();
    }
    await expect(draft.request("/api/routines", { method: "POST", body: JSON.stringify({ botId: "real-bot" }) })).rejects.toThrow("another bot");
    expect(network).not.toHaveBeenCalled();
  });

  it("imports a preview without installing it, and enables only the reviewed draft copy", async () => {
    const skill = { name: "fixture", description: "Fixture", source: "example/fixture", warnings: [], text: "synthetic", enabled: false };
    const network = vi.fn().mockResolvedValue({ skills: [skill] });
    const draft = new BotCreationDraft(EMPTY_BOT_DEFAULTS, vi.fn(), network as typeof api);
    await draft.request(`/api/bots/${draft.id}/skills`, { method: "POST", body: JSON.stringify({ source: skill.source }) });
    expect(network).toHaveBeenCalledWith("/api/bot-defaults/skills/preview", expect.anything());
    expect(draft.template.skills[0].enabled).toBe(false);
    await draft.request(`/api/bots/${draft.id}/skills/fixture`, { method: "PATCH", body: JSON.stringify({ enabled: true }) });
    expect(network).toHaveBeenCalledTimes(1);
    expect(draft.export().skills[0].enabled).toBe(true);
  });
});
