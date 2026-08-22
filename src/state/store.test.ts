import { describe, expect, it, vi } from "vitest";

import {
  configStatusFromFrame,
  initialState,
  openNotificationTarget,
  reducer,
  type Bot,
  type Message,
} from "./store";

describe("notification routing", () => {
  const bots = [{ id: "bot-1", threadId: "main-thread", tasks: [{ threadId: "detached-thread" }] }] as never;
  const groups = [{ id: "room-1", threadId: "room-thread" }] as never;

  it("selects the bot and switches to the notification's exact task", () => {
    const dispatch = vi.fn();

    openNotificationTarget(dispatch, { botId: "bot-1", threadId: "detached-thread" }, { bots, groups });

    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "select", id: "bot-1" },
      { type: "switchTask", botId: "bot-1", threadId: "detached-thread" },
    ]);
  });

  it("opens the room when the thread is a group's — never a bot task switch that would 404", () => {
    // room approval/question notifications carry the asker bot with the
    // GROUP's thread id; the exact destination is the room itself
    const dispatch = vi.fn();

    openNotificationTarget(dispatch, { botId: "bot-1", threadId: "room-thread" }, { bots, groups });

    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([{ type: "select", id: "room-1" }]);
  });

  it("lands on a plain bot select for a thread it cannot place, not an error", () => {
    const dispatch = vi.fn();

    openNotificationTarget(dispatch, { botId: "bot-1", threadId: "deleted-task-thread" }, { bots, groups });

    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([{ type: "select", id: "bot-1" }]);
  });
});

describe("config status frames", () => {
  it("keeps the room turn timeout with the existing config fields", () => {
    expect(
      configStatusFromFrame({
        xai: { configured: true },
        composio: { configured: true, mode: "managed" },
        box: { configured: false },
        vps: { configured: true, sshAlias: "homelab" },
        rooms: { turnTimeoutMinutes: 20 },
        localVm: { mode: "per-bot", maxInstances: 3 },
        opencodeGo: { configured: true },
        tts: { configured: true, ready: true, voice: "Ada" },
        profile: { name: "Ian", email: "ian@example.test" },
      }),
    ).toEqual({
      xai: { configured: true },
      composio: { configured: true, mode: "managed" },
      box: { configured: false },
      vps: { configured: true, sshAlias: "homelab" },
      rooms: { turnTimeoutMinutes: 20 },
      localVm: { mode: "per-bot", maxInstances: 3 },
      opencodeGo: { configured: true },
      tts: { configured: true, ready: true, voice: "Ada" },
      profile: { name: "Ian", email: "ian@example.test" },
    });
  });
});

describe("cross-client bot creation", () => {
  it("adds an announced bot before its greeting frames arrive", () => {
    const announced = {
      id: "phone-bot",
      threadId: "phone-thread",
      name: "Scout",
      title: "",
      description: "",
      notifications: true,
      color: "green",
      unread: false,
      modelSelection: { instanceId: "codex", model: "default" },
    } satisfies Omit<Bot, "messages">;

    const added = reducer(initialState, { type: "botPatched", bot: announced });

    expect(added.bots).toEqual([{ ...announced, messages: [] }]);

    const greeting = {
      id: "greeting",
      role: "bot",
      kind: "text",
      text: "Hey — I'm Scout. Nice to meet you.",
      at: 2,
    } satisfies Message;
    const greeted = reducer(added, {
      type: "messageAdded",
      threadId: announced.threadId,
      message: greeting,
    });

    expect(greeted.bots[0]?.messages).toEqual([greeting]);
  });
});

describe("team switcher", () => {
  const bot = (id: string, teamId?: string): Bot => ({
    id,
    threadId: `${id}-thread`,
    name: id,
    title: "",
    description: "",
    notifications: true,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "codex", model: "default" },
    messages: [],
    ...(teamId ? { teamId } : {}),
  });

  it("hydrate and setActiveTeam keep the current chat when it still belongs", () => {
    const scout = bot("scout", "eng");
    const copy = bot("copy", "mkt");
    const hydrated = reducer(initialState, {
      type: "hydrate",
      bots: [scout, copy],
      groups: [],
      teams: [
        { id: "eng", name: "Engineering", createdAt: 1 },
        { id: "mkt", name: "Marketing", createdAt: 2 },
      ],
      activeTeamId: "eng",
      computerControl: {},
    });
    expect(hydrated.selectedId).toBe("scout");
    expect(hydrated.activeTeamId).toBe("eng");

    const selected = reducer(hydrated, { type: "select", id: "scout" });
    const switched = reducer(selected, { type: "setActiveTeam", teamId: "mkt" });
    expect(switched.activeTeamId).toBe("mkt");
    expect(switched.selectedId).toBe("copy");
  });

  it("moves selection when the open bot leaves the active team", () => {
    const scout = bot("scout", "eng");
    const tester = bot("tester", "eng");
    const start = reducer(initialState, {
      type: "hydrate",
      bots: [scout, tester],
      groups: [],
      teams: [{ id: "eng", name: "Engineering", createdAt: 1 }],
      activeTeamId: "eng",
      computerControl: {},
    });
    const selected = reducer(start, { type: "select", id: "scout" });
    const moved = reducer(selected, { type: "updateBot", botId: "scout", patch: { teamId: "" } });
    expect(moved.selectedId).toBe("tester");
  });

  it("teamsListed refreshes names without rewinding the active team", () => {
    const start = reducer(initialState, {
      type: "hydrate",
      bots: [bot("scout", "eng")],
      groups: [],
      teams: [{ id: "eng", name: "Engineering", createdAt: 1 }],
      activeTeamId: "eng",
      computerControl: {},
    });
    const listed = reducer(start, {
      type: "teamsListed",
      teams: [
        { id: "eng", name: "Platform", createdAt: 1 },
        { id: "mkt", name: "Marketing", createdAt: 2 },
      ],
    });
    expect(listed.activeTeamId).toBe("eng");
    expect(listed.selectedId).toBe("scout");
    expect(listed.teams.map((team) => team.name)).toEqual(["Platform", "Marketing"]);
  });
});
