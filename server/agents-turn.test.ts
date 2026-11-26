// One conversation's agents tools on every kind of turn it gets. The tools/list a turn's server answers is the same bytes
// whatever started the turn and whatever the turn may do, so the provider's cached prompt carries over from turn to turn.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TOOL_BRIDGE_ENV } from "./drivers/agents-bridge.ts";
import { agentsMcp } from "./drivers/agents-mcp.ts";
import { agentsServerEnv, botDrivenConversation, COMPUTER_OFF_REFUSAL, computerPickRefusal, directTurnKind, handRoomSkills, roomSkillsRefusal, roomSkillsTurn, roomTurnMayWriteSkills, takeRoomSkills, type AgentsConversation, type AgentsTurn, type RoomSkillsClaim } from "./agents-turn.ts";

const HOST: AgentsConversation["host"] = { skillAuthoring: true, sharedComputers: true, cloudHome: false, team: false, voiceNotes: true, x: true, research: true, imageGeneration: false, localVm: true };
const CHAT: AgentsConversation = { threadId: "thread-1", bot: { id: "bot-1", chiefOfStaff: true }, room: false, teamComputer: false, host: HOST };
const ROOM: AgentsConversation = { ...CHAT, threadId: "room-1", room: true };

/** Every kind of turn a direct chat gets and what that turn may do, as the harness hands it over. */
const CHAT_TURNS: Record<string, AgentsTurn> = {
  "the person's own message, which may pick its computer": { generation: "person", depth: 0, skillAuthoring: true },
  "a routine run": { generation: "routine", depth: 0, skillAuthoring: true },
  "a webhook run": { generation: "webhook", depth: 0, skillAuthoring: true },
  "a teammate's hand-off": { generation: "handoff", depth: 1, skillAuthoring: true },
  "a card continuation": { generation: "card", depth: 0, skillAuthoring: true },
  "the continuation on a newly picked computer": { generation: "picked", depth: 0, skillAuthoring: true },
  "a turn that delivers files saved outside its folders": { generation: "files", depth: 0, skillAuthoring: true, deliversSavedFiles: true },
};
/** And a room: only the first answer to a person's message, and the bots it @mentions, may list or write skills. */
const ROOM_TURNS: Record<string, AgentsTurn> = {
  "the first answer to a person, holding the skill claim": { generation: "first", depth: 0, skillAuthoring: true },
  "a bot that first answer @mentioned": { generation: "mentioned", depth: 1, skillAuthoring: true },
  "a follow-up once the claim is spent": { generation: "follow-up", depth: 1, skillAuthoring: false },
  "a hand-off into the room": { generation: "room-handoff", depth: 1, skillAuthoring: false, roomHandoffId: "node-2" },
  "a goal step": { generation: "goal", depth: 0, skillAuthoring: false },
};

/** A bearer per turn, as the harness mints them: a turn's grants ride it, never the list. */
const bearer = (turn: AgentsTurn) => createHash("sha256").update(JSON.stringify(turn)).digest("hex").slice(0, 48);

async function toolsList(env: Record<string, string>): Promise<string> {
  const answer = await agentsMcp(env)({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  return JSON.stringify((answer as { result: unknown }).result);
}

async function everyTurn(conversation: AgentsConversation, extra: Record<string, string> = {}) {
  return Promise.all(Object.entries(conversation.room ? ROOM_TURNS : CHAT_TURNS).map(async ([kind, turn]) => {
    const env = { ...agentsServerEnv(conversation, turn, bearer, "http://127.0.0.1:9"), ...extra };
    return { kind, env, wire: await toolsList(env) };
  }));
}

describe("one conversation's agents tools", () => {
  for (const [name, conversation] of [["a direct chat", CHAT], ["a room", ROOM]] as const) {
    for (const bridged of [false, true]) {
      it(`lists ${name} the same tools on every kind of turn, byte for byte${bridged ? ", with the tool bridge on" : ""}`, async () => {
        const turns = await everyTurn(conversation, bridged ? { [TOOL_BRIDGE_ENV]: "1" } : {});
        expect(new Set(turns.map(({ env }) => env.OMB_COMMS_TOKEN)).size).toBe(turns.length);
        for (const { kind, wire } of turns) expect(wire, kind).toBe(turns[0]!.wire);
      });
    }
  }

  it("never lists select_computer in a conversation only bots or automation drive, where every pick would be refused", async () => {
    const names = async (conversation: AgentsConversation) =>
      (JSON.parse((await everyTurn(conversation))[0]!.wire) as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
    expect(await names(CHAT)).toContain("select_computer");
    expect(await names({ ...CHAT, botDriven: true })).not.toContain("select_computer");
    expect(botDrivenConversation({ openedBy: { botId: "b" } })).toBe(true);
    expect(botDrivenConversation({ botApi: true })).toBe(true);
    expect(botDrivenConversation({ routineRunId: "r1" })).toBe(true);
    expect(botDrivenConversation({})).toBe(false);
    expect(botDrivenConversation(undefined)).toBe(false);
  });

  it("lists a direct chat select_computer and the wait tools and a room none, and both the skill tools while authoring is on", async () => {
    const names = async (conversation: AgentsConversation) =>
      (JSON.parse((await everyTurn(conversation))[0]!.wire) as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
    const chat = await names(CHAT), room = await names(ROOM);
    expect(chat).toEqual(expect.arrayContaining(["select_computer", "wait_until", "list_waits", "cancel_wait"]));
    for (const tool of ["select_computer", "wait_until", "list_waits", "cancel_wait"]) expect(room).not.toContain(tool);
    for (const tools of [chat, room]) expect(tools).toEqual(expect.arrayContaining(["skills_list", "skill_manage", "usage_limits"]));
    expect(await names({ ...CHAT, host: { ...HOST, skillAuthoring: false } })).not.toContain("skill_manage");
  });

  it("lists x_search with a research credential, and the research tools only while research works for it", async () => {
    const names = async (conversation: AgentsConversation) =>
      (JSON.parse((await everyTurn(conversation))[0]!.wire) as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name).filter((tool) => /^(x|research)_/.test(tool));
    expect(await names(CHAT)).toEqual(["x_search", "research_search", "research_endpoint", "research_call"]);
    expect(await names({ ...CHAT, host: { ...HOST, research: false } })).toEqual(["x_search"]);
    expect(await names({ ...CHAT, host: { ...HOST, x: false } })).toEqual([]);
    expect(await names({ ...CHAT, bot: { ...CHAT.bot, xResearch: false } })).toEqual([]);
  });

  it("leaves out the tool groups the bot's person turned off, on every kind of turn, and only for that bot", async () => {
    const off = { ...CHAT, host: { ...HOST, meetings: true, imageGeneration: true }, bot: { ...CHAT.bot, toolsOff: ["meetings", "pages"] } };
    const turns = await everyTurn(off);
    for (const { kind, env, wire } of turns) {
      expect(env.OMB_TOOLS_OFF, kind).toBe("meetings,pages");
      expect(wire, kind).toBe(turns[0]!.wire);
    }
    const names = (wire: string) => (JSON.parse(wire) as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
    const kept = names(turns[0]!.wire), everything = names((await everyTurn({ ...off, bot: CHAT.bot }))[0]!.wire);
    for (const tool of ["join_meeting", "show_html", "publish_page"]) {
      expect(everything).toContain(tool);
      expect(kept).not.toContain(tool);
    }
    expect(kept).toContain("generate_image");
    expect((await everyTurn(CHAT))[0]!.env.OMB_TOOLS_OFF).toBe("");
  });

  it("leaves select_computer out only where the conversation can never pick a computer", async () => {
    const selects = async (conversation: AgentsConversation) => (await everyTurn(conversation))[0]!.wire.includes('"name":"select_computer"');
    expect(await selects({ ...CHAT, bot: { ...CHAT.bot, computer: "off" } })).toBe(false);
    expect(await selects({ ...CHAT, teamComputer: true })).toBe(false);
    expect(await selects({ ...CHAT, bot: { ...CHAT.bot, computer: "browser" } })).toBe(true);
  });
});

describe("what a turn that may not use a listed tool is told", () => {
  it("names what started a direct turn", () => {
    expect(directTurnKind({})).toBe("person");
    expect(directTurnKind({ automationSource: "schedule" })).toBe("routine");
    expect(directTurnKind({ automationSource: "manual" })).toBe("routine");
    expect(directTurnKind({ automationSource: "webhook" })).toBe("webhook");
    expect(directTurnKind({ commsDepth: 1 })).toBe("handoff");
    expect(directTurnKind({ coordination: { id: "node" } })).toBe("handoff");
    expect(directTurnKind({ peerAsk: { botId: "teammate" } })).toBe("handoff");
    expect(directTurnKind({ cardContinuation: true })).toBe("continuation");
    expect(directTurnKind({ computerSelectionContinuation: true })).toBe("continuation");
    expect(directTurnKind({ unattended: true })).toBe("continuation");
  });

  it("says why a computer cannot be picked on this turn, and what to do instead", () => {
    expect(computerPickRefusal("routine")).toBe("Picking a computer works only on a person's own message. This turn is a routine run, so carry on with the computer already in use.");
    expect(computerPickRefusal("webhook")).toBe("Picking a computer works only on a person's own message. This turn was started by a webhook, so carry on with the computer already in use.");
    expect(computerPickRefusal("handoff")).toBe("Picking a computer works only on a person's own message. This turn is a teammate's hand-off, so carry on with the computer already in use.");
    expect(computerPickRefusal("continuation")).toBe("Picking a computer works only on a person's own message. This turn continues earlier work, so carry on with the computer already in use.");
    expect(computerPickRefusal(undefined)).toMatch(/^Picking a computer works only once per request, on a person's own message\. Carry on with/);
    expect(COMPUTER_OFF_REFUSAL).toMatch(/Works on setting is Off/);
  });

  it("says which room turn may change skills", () => {
    expect(roomSkillsRefusal(false)).toBe("In a room, only the first bot answering a person's message, and a bot it @mentions in that answer, can list or write skills. This turn is a follow-up, so carry on without changing skills.");
    expect(roomSkillsRefusal(true)).toMatch(/This turn is a teammate's hand-off, so carry on without changing skills\.$/);
  });

  describe("on one person's message in a room", () => {
    it("lets the first bot answering change skills once, and no other first answer", () => {
      const claim: RoomSkillsClaim = { claimed: false };
      expect(roomTurnMayWriteSkills(claim, 0, "writer")).toBe(true);
      takeRoomSkills(claim, 0, "writer", true);
      expect(roomTurnMayWriteSkills(claim, 0, "writer")).toBe(false);
      expect(roomTurnMayWriteSkills(claim, 0, "editor")).toBe(false);
    });

    it("lets a bot that first answer @mentions change its own skills once, and only that bot", () => {
      const claim: RoomSkillsClaim = { claimed: false };
      takeRoomSkills(claim, 0, "writer", true);
      expect(roomTurnMayWriteSkills(claim, 1, "video")).toBe(false);
      handRoomSkills(claim, ["video"]);
      expect(roomTurnMayWriteSkills(claim, 1, "video")).toBe(true);
      expect(roomTurnMayWriteSkills(claim, 1, "editor")).toBe(false);
      takeRoomSkills(claim, 1, "video", true);
      expect(roomTurnMayWriteSkills(claim, 1, "video")).toBe(false);
    });

    it("lets a bot that first answer @mentions use its share even when another mentioned bot reaches it first", () => {
      const claim: RoomSkillsClaim = { claimed: false };
      takeRoomSkills(claim, 0, "writer", true);
      handRoomSkills(claim, ["video", "editor"]);
      expect(roomTurnMayWriteSkills(claim, 2, "editor")).toBe(true);
      takeRoomSkills(claim, 2, "editor", true);
      expect(roomTurnMayWriteSkills(claim, 1, "editor")).toBe(false);
    });

    it("never lets a bot only a later answer mentions change skills", () => {
      const claim: RoomSkillsClaim = { claimed: false };
      takeRoomSkills(claim, 0, "writer", true);
      handRoomSkills(claim, ["video"]);
      expect(roomTurnMayWriteSkills(claim, 2, "editor")).toBe(false);
    });

    it("withdraws the shares still unused once the first answer's mentions are done", () => {
      const claim: RoomSkillsClaim = { claimed: false };
      takeRoomSkills(claim, 0, "writer", true);
      const withdraw = handRoomSkills(claim, ["video", "editor"]);
      takeRoomSkills(claim, 1, "video", true);
      withdraw();
      expect(roomTurnMayWriteSkills(claim, 1, "editor")).toBe(false);
      expect(roomTurnMayWriteSkills(claim, 1, "video")).toBe(false);
    });

    it("lets the first answer hand shares to the bots it @mentions even when its own engine can't write skills", () => {
      const claim: RoomSkillsClaim = { claimed: false };
      expect(roomSkillsTurn(claim, 0, "writer", { allowed: true, canWrite: false, personStarted: true })).toEqual({ writes: false, hands: true, claims: true });
      expect(roomSkillsTurn(claim, 0, "writer", { allowed: true, canWrite: true, personStarted: true })).toEqual({ writes: true, hands: true, claims: true });
      expect(roomSkillsTurn(claim, 0, "writer", { allowed: false, canWrite: true, personStarted: true })).toEqual({ writes: false, hands: false, claims: false });
      handRoomSkills(claim, ["video"]);
      expect(roomSkillsTurn(claim, 1, "video", { allowed: true, canWrite: true, personStarted: true })).toEqual({ writes: true, hands: false, claims: true });
      takeRoomSkills(claim, 0, "editor", true);
      expect(roomSkillsTurn(claim, 0, "other", { allowed: true, canWrite: true, personStarted: true })).toEqual({ writes: false, hands: false, claims: false });
    });

    it("hands no shares when no person started the room turn (the team board starts it with a bot trigger)", () => {
      const claim: RoomSkillsClaim = { claimed: false };
      expect(roomSkillsTurn(claim, 0, "writer", { allowed: true, canWrite: false, personStarted: false })).toEqual({ writes: false, hands: false, claims: false });
      expect(roomSkillsTurn(claim, 0, "writer", { allowed: true, canWrite: true, personStarted: false })).toEqual({ writes: true, hands: false, claims: true });
    });

    it("keeps the claim with a first answer that can't write skills, so a later top-level answer hands no shares", () => {
      const claim: RoomSkillsClaim = { claimed: false };
      const first = roomSkillsTurn(claim, 0, "writer", { allowed: true, canWrite: false, personStarted: true });
      expect(first.claims).toBe(true);
      takeRoomSkills(claim, 0, "writer", true);
      handRoomSkills(claim, ["video"])();
      expect(roomSkillsTurn(claim, 0, "editor", { allowed: true, canWrite: true, personStarted: true })).toEqual({ writes: false, hands: false, claims: false });
      takeRoomSkills(claim, 0, "writer", false);
      expect(roomSkillsTurn(claim, 0, "editor", { allowed: true, canWrite: true, personStarted: true }).hands).toBe(true);
      expect(roomSkillsTurn(claim, 1, "video", { allowed: true, canWrite: true, personStarted: true }).claims).toBe(false);
    });

    it("gives the share back to a turn that never ran", () => {
      const claim: RoomSkillsClaim = { claimed: false };
      takeRoomSkills(claim, 0, "writer", true);
      handRoomSkills(claim, ["video"]);
      takeRoomSkills(claim, 1, "video", true);
      takeRoomSkills(claim, 1, "video", false);
      expect(roomTurnMayWriteSkills(claim, 1, "video")).toBe(true);
      takeRoomSkills(claim, 0, "writer", false);
      expect(roomTurnMayWriteSkills(claim, 0, "editor")).toBe(true);
    });
  });
});
