import { describe, expect, it, vi } from "vitest";
import { TeamSetupRequestService } from "./team-setup-requests.ts";
import { canAccessTeam } from "./peer-roster.ts";
import type { BotRecord, OptionCardData } from "./store.ts";
import type { TeamSetupRequest, TeamSetupResult } from "../shared/team-setup.ts";

function harness() {
  const bots: BotRecord[] = [];
  const messages: Array<{ id: string; card?: OptionCardData }> = [];
  const teams = ["", "Work", "Engineering", "Private"];
  const bot = (id: string, overrides: Partial<BotRecord> = {}) => {
    const value: BotRecord = { id, threadId: `${id}-thread`, name: id, title: "", description: "", soul: "", section: "Work",
      notifications: true, color: "blue", unread: false, createdAt: 1, resumeCursors: {}, modelSelection: { instanceId: "claude", model: "sonnet" },
      ...overrides };
    bots.push(value); return value;
  };
  const chief = bot("Clive", { chiefOfStaff: true, managedSections: ["Engineering"] });
  const peer = bot("Ada");
  const apply = vi.fn((request: TeamSetupRequest): TeamSetupResult => {
    const result: TeamSetupResult = { state: "applied", newTeams: request.newTeams, bots: request.operations.map((op) => {
      const target = bots.find((item) => item.id === op.botId) ?? bot(op.botId);
      Object.assign(target, op.fields);
      return { id: target.id, name: target.name, action: op.action === "create" ? "created" : "updated" };
    }) };
    chief.lastTeamSetupReceipt = { requestId: request.requestId, result }; return result;
  });
  const store = { bots, bot: (id: string) => bots.find((item) => item.id === id), messagesFor: () => messages,
    appendMessage: (_thread: string, input: { card: OptionCardData }) => { const message = { id: `message-${messages.length}`, card: input.card }; messages.push(message); return message; },
    patchMessage: (_thread: string, id: string, patch: { card: OptionCardData }) => { const message = messages.find((item) => item.id === id); if (!message) return null; Object.assign(message, patch); return message; },
    applyTeamSetup: apply,
  };
  let sourceExists = true;
  const deleteBot = vi.fn(async (id: string, revalidate: () => void) => { revalidate(); bots.splice(bots.findIndex((item) => item.id === id), 1); });
  const service = new TeamSetupRequestService({ store, teams: () => teams, maxBots: 100, canAccessTeam,
    canPersist: () => ({ ok: true }), ownsThread: () => sourceExists, targetBusy: (id) => Boolean(store.bot(id)?.busy), deleteBot,
    validateModel: (selection, current) => {
      if (!({ claude: ["sonnet", "opus"], codex: ["gpt-fixture"] }[selection.instanceId]?.includes(selection.model))) return "Model is not in the current catalog";
      return current?.approvalMode === "full" && selection.instanceId !== current.modelSelection.instanceId ? "Existing permissions are incompatible" : null;
    },
  });
  const propose = (operations: unknown[], newTeams: string[] = []) => service.propose({ botId: chief.id, threadId: chief.threadId, plan: { reason: "Requested specialist setup", operations, newTeams } });
  const resolve = (requestId: string, behavior = "allow") => service.resolve({ botId: chief.id, threadId: chief.threadId, requestId, behavior });
  return { service, store, chief, peer, bot, teams, propose, resolve, apply, deleteBot, messages, removeSource: () => { sourceExists = false; } };
}
const specialist = (key: string, section: string, modelSelection = { instanceId: "claude", model: "sonnet" }) => ({ action: "create", key,
  fields: { name: key, title: "Specialist", soul: "Finish the assigned work.", section, modelSelection } });

describe("reviewed Chief team setup", () => {
  it("coalesces each bot's fields into one review and applies once with a durable receipt", async () => {
    const h = harness();
    const request = h.propose([
      { action: "update", botId: h.peer.id, fields: { title: "Research lead" } },
      { action: "update", botId: h.peer.id, fields: { soul: "Verify sources.", modelSelection: { instanceId: "codex", model: "gpt-fixture" } } },
    ]);
    expect(h.messages).toHaveLength(1);
    expect(request.title).toBe("Apply setup for 1 bot?");
    expect(h.messages[0].card?.teamSetupRequest?.operations).toHaveLength(1);
    expect(request.detail).toContain("Every existing thread keeps its current model and permissions");
    expect(h.peer.title).toBe("");
    expect((await h.resolve(request.requestId))?.result.state).toBe("applied");
    expect(h.peer).toMatchObject({ title: "Research lead", soul: "Verify sources.", modelSelection: { instanceId: "codex", model: "gpt-fixture" } });
    expect((await h.resolve(request.requestId))?.duplicate).toBe(true);
    expect(h.apply).toHaveBeenCalledTimes(1);
  });
  it("reviews Research, Engineering and Growth with multiple providers and explicit new-team access", async () => {
    const h = harness();
    const request = h.propose([specialist("Mira", "Research"), specialist("Patch", "Engineering", { instanceId: "codex", model: "gpt-fixture" }), specialist("Quill", "Growth")], ["Research", "Growth"]);
    expect(request.detail).toContain('Create teams: "Research", "Growth"');
    expect(request.detail).toContain("Authorize @Clive");
    expect(h.store.bots).toHaveLength(2);
    expect((await h.resolve(request.requestId))?.result.bots).toHaveLength(3);
  });
  it("denial leaves all bots and scopes unchanged and closes the card", async () => {
    const h = harness(); const before = structuredClone(h.store.bots);
    const request = h.propose([specialist("Mira", "Research")], ["Research"]);
    expect((await h.resolve(request.requestId, "deny"))?.result.state).toBe("denied");
    expect(h.store.bots).toEqual(before); expect(h.apply).not.toHaveBeenCalled();
    expect((await h.resolve(request.requestId))?.result.state).toBe("denied");
  });
  it.each(["approvalMode", "autoApprove", "managedSections", "peers", "chiefOfStaff", "composio", "cwd"])("rejects injected %s with no card", (field) => {
    const h = harness();
    expect(() => h.propose([{ action: "update", botId: h.peer.id, fields: { [field]: true } }])).toThrow();
    expect(h.messages).toHaveLength(0);
  });
  it("rejects unknown models, foreign teams, missing specialists and duplicate names", () => {
    const h = harness();
    expect(() => h.propose([specialist("Mira", "Engineering", { instanceId: "codex", model: "made-up" })])).toThrow(/catalog/);
    expect(() => h.propose([specialist("Mira", "Private")])).toThrow(/authorized/);
    expect(() => h.propose([specialist("Mira", "Private")], ["Private"])).toThrow(/exists/);
    expect(() => h.propose([specialist("Mira", "Engineering")], ["Growth"])).toThrow(/needs a specialist/);
    expect(() => h.propose([specialist("Ada", "Work")])).toThrow(/already exists/);
    expect(h.apply).not.toHaveBeenCalled();
  });
  it.each(["target", "chief", "team", "scope", "busy", "source"])("cancels a %s change while the review was open, without any batch mutation", async (change) => {
    const h = harness();
    const request = h.propose([{ action: "update", botId: h.peer.id, fields: { title: "Researcher", section: "Engineering" } }, specialist("Mira", "Research")], ["Research"]);
    if (change === "target") h.peer.description = "newer user edit";
    if (change === "chief") h.chief.chiefOfStaff = false;
    if (change === "team") h.teams.push("Research");
    if (change === "scope") h.chief.managedSections = [];
    if (change === "busy") h.peer.busy = true;
    if (change === "source") h.removeSource();
    const before = structuredClone(h.store.bots);
    expect((await h.resolve(request.requestId))?.result.state).toBe("cancelled");
    expect(h.store.bots).toEqual(before); expect(h.apply).not.toHaveBeenCalled();
    expect(h.messages[0].card?.answered).toBe("deny");
  });
  it("preserves existing elevated permissions and peer allowlists", () => {
    const h = harness(); h.peer.approvalMode = "full";
    expect(() => h.propose([{ action: "update", botId: h.peer.id, fields: { modelSelection: { instanceId: "codex", model: "gpt-fixture" } } }])).toThrow(/incompatible/);
    h.chief.peers = [];
    expect(() => h.propose([{ action: "update", botId: h.peer.id, fields: { title: "X" } }])).toThrow(/peer scope/);
  });
  it("routes separately confirmed deletion through lifecycle guards once and never permits self-deletion", async () => {
    const h = harness();
    expect(() => h.service.proposeDeletion({ botId: h.chief.id, threadId: h.chief.threadId, targetBotId: h.chief.id, reason: "remove" })).toThrow(/authorized/);
    const request = h.service.proposeDeletion({ botId: h.chief.id, threadId: h.chief.threadId, targetBotId: h.peer.id, reason: "User asked to remove Ada" });
    expect(request.detail).toContain("Permanently removes this bot");
    expect(h.deleteBot).not.toHaveBeenCalled();
    expect((await h.resolve(request.requestId))?.result.bots).toEqual([{ id: h.peer.id, name: "Ada", action: "deleted" }]);
    await h.resolve(request.requestId); expect(h.deleteBot).toHaveBeenCalledTimes(1);
  });
  it("reports storage failure without claiming application", async () => {
    const h = harness(); h.apply.mockImplementation(() => { throw new Error("fixture disk full"); });
    const request = h.propose([specialist("Mira", "Work")]);
    expect((await h.resolve(request.requestId))?.result).toMatchObject({ state: "failed", bots: [], error: "fixture disk full" });
    expect(h.store.bots).toHaveLength(2);
  });
  it("enforces the persisted 60-character team and 100-grant boundaries", async () => {
    const h = harness(); const name = "T".repeat(60);
    expect(() => h.propose([specialist("Mira", name + "x")], [name + "x"])).toThrow();
    h.chief.managedSections = Array.from({ length: 99 }, (_, i) => `Team ${i}`);
    const card = h.propose([specialist("Mira", name)], [name]);
    expect((await h.resolve(card.requestId))?.result.state).toBe("applied");
    h.chief.managedSections.push("Last allowed team");
    expect(() => h.propose([specialist("Patch", "One too many")], ["One too many"])).toThrow(/100 additional/);
  });
  it("does not apply or resurrect a review closed by Stop", async () => {
    const h = harness(); const card = h.propose([specialist("Mira", "Work")]);
    Object.assign(h.messages[0].card!, { answered: "unavailable", dismissed: true });
    expect(await h.resolve(card.requestId)).toMatchObject({ result: { state: "cancelled" }, duplicate: true });
    expect(h.apply).not.toHaveBeenCalled();
  });
});
