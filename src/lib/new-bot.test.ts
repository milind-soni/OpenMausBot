import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ track: vi.fn(), openBot: vi.fn() }));
vi.mock("@/lib/analytics", () => ({ track: fixture.track }));
vi.mock("@/state/thread-navigation", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/thread-navigation")>(), openBot: fixture.openBot,
}));

import type { Action, Bot } from "@/state/store";
import { setTeamChats } from "@/state/team-chats";
import { setTeamPeople, type TeamPeople } from "@/state/team-people";
import { makeNewBot, type BotDefaultsAnswer } from "./new-bot";

const ME = { email: "ada@acme.test", name: "Ada", role: "member", you: true as const };
const BOB = { email: "bob@acme.test", name: "Bob", role: "admin" };
const team: TeamPeople = { people: [ME, BOB], me: ME, admin: false, needsYou: [] };

function server(answer: Partial<BotDefaultsAnswer> = {}, fail?: { on: "POST" | "PATCH"; error: string }) {
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  let bot: Bot | null = null;
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ method, path, body });
    if (path === "/api/bot-defaults") {
      return { defaults: { profile: {}, memory: {}, skills: [], routines: [] }, modelSelection: { instanceId: "claude", model: "sonnet" }, suggestedName: "Pixel", ...answer };
    }
    if (fail?.on === method) throw new Error(fail.error);
    if (path === "/api/bots" && method === "POST") {
      bot = { id: "created", threadId: "created-main", name: body.name, title: "", description: "", soul: "", color: "green", notifications: true,
        unread: false, messages: [], section: body.section, modelSelection: body.modelSelection ?? { instanceId: "", model: "" } } as Bot;
      return { bot };
    }
    if (path === "/api/bots/created" && method === "PATCH") { bot = { ...bot!, ...body }; return { bot }; }
    return {};
  });
  return { calls, request: request as never, created: () => calls.find((call) => call.method === "POST" && call.path === "/api/bots")?.body };
}

async function newBot(request: never, action: Partial<Extract<Action, { type: "newBot" }>> = {}, bots: Bot[] = []) {
  const dispatch = vi.fn<(action: Action) => void>();
  await makeNewBot({ type: "newBot", ...action }, bots, dispatch, false, request);
  return dispatch.mock.calls.map(([sent]) => sent);
}

beforeEach(() => { fixture.track.mockReset(); fixture.openBot.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); setTeamPeople(null); setTeamChats(null); });

describe("New bot", () => {
  it("makes a bot at once from the New bot defaults and opens its chat", async () => {
    const { calls, request, created } = server();
    const sent = await newBot(request);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(["GET /api/bot-defaults", "POST /api/bots", "PATCH /api/bots/created"]);
    expect(created()).toMatchObject({ name: "Pixel", modelSelection: { instanceId: "claude", model: "sonnet" }, requireAvailableModel: true, useDefaults: false });
    expect(created()).not.toHaveProperty("reportsTo");
    expect(sent).toEqual([{ type: "botAdded", bot: expect.objectContaining({ id: "created", name: "Pixel" }), preserveSelection: false }]);
    expect(fixture.track.mock.calls).toEqual([["bot_created", { source: "blank" }]]);
  });

  it("names the bot so it never repeats one already here", async () => {
    const taken = [{ name: "Helper" }, { name: "helper 2" }] as Bot[];
    const named = server({ defaults: { profile: { name: "Helper" }, memory: {}, skills: [], routines: [] } });
    await newBot(named.request, {}, taken);
    expect(named.created()).toMatchObject({ name: "Helper 3" });
  });

  it("with no AI set up, still makes the bot, without one, for the first AI connected later", async () => {
    const { calls, request, created } = server({ modelSelection: { instanceId: "", model: "" } });
    const sent = await newBot(request);
    expect(created()).not.toHaveProperty("modelSelection");
    expect(created()).not.toHaveProperty("requireAvailableModel");
    expect(calls.find((call) => call.method === "PATCH")!.body).not.toHaveProperty("modelSelection");
    expect(sent.map((action) => action.type)).toEqual(["botAdded"]);
  });

  it("on a team, makes it in this place, reporting to the department's person or else to its creator, in their own chat", async () => {
    setTeamPeople(team);
    setTeamChats({ teamId: "acme", member: true, opened: [] });
    const sales = [{ id: "closer", name: "Closer", section: "Sales", reportsTo: BOB.email }] as Bot[];
    const inSales = server();
    const sent = await newBot(inSales.request, { section: "Sales" }, sales);
    expect(inSales.created()).toMatchObject({ section: "Sales", reportsTo: BOB.email });
    expect(sent[0]).toMatchObject({ type: "botAdded", preserveSelection: false });
    expect(fixture.openBot).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ id: "created" }), false);
    const general = server();
    await newBot(general.request, {}, sales);
    expect(general.created()).toMatchObject({ reportsTo: ME.email });
  });

  it("keeps a department dialog where it is", async () => {
    setTeamChats({ teamId: "acme", member: true, opened: [] });
    const onCreated = vi.fn();
    const sent = await newBot(server().request, { section: "Sales", preserveSelection: true, onCreated });
    expect(sent).toEqual([expect.objectContaining({ type: "botAdded", preserveSelection: true })]);
    expect(fixture.openBot).not.toHaveBeenCalled();
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "created" }));
  });

  it.each(["POST", "PATCH"] as const)("a failure (%s) shows one plain error and leaves no bot behind", async (on) => {
    const { calls, request } = server({}, { on, error: "this workspace is limited to 200 bots" });
    const sent = await newBot(request);
    expect(sent).toEqual([{ type: "error", message: "Couldn't make a new bot: this workspace is limited to 200 bots" }]);
    if (on === "PATCH") expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: "/api/bots/created" });
    expect(fixture.track).not.toHaveBeenCalled();
    const onError = vi.fn();
    expect(await newBot(server({}, { on, error: "offline" }).request, { onError })).toEqual([]);
    expect(onError).toHaveBeenCalledWith("Couldn't make a new bot: offline");
  });

  it("starts a bot whose defaults say Auto on this computer on Ask, and says so", async () => {
    const { calls, request } = server({ defaults: { profile: { approvalMode: "auto", computer: "local" }, memory: {}, skills: [], routines: [] } });
    const sent = await newBot(request);
    expect(calls.find((call) => call.method === "PATCH")!.body).toMatchObject({ approvalMode: "ask" });
    expect(sent.at(-1)).toEqual({ type: "notice", notice: { kind: "note", botName: null,
      text: "Pixel will ask before acting. To let it act on this computer by itself, choose Approve for me in its settings." } });
  });

  it("from a paired device, sends one request and leaves the defaults to the host", async () => {
    vi.stubGlobal("window", { ogb: { remoteClient: { active: true } } });
    const { calls, request } = server();
    const sent = await newBot(request, { section: "Sales" });
    expect(calls).toEqual([{ method: "POST", path: "/api/bots", body: { section: "Sales" } }]);
    expect(sent.map((action) => action.type)).toEqual(["botAdded"]);
  });
});
