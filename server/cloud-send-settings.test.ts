import { describe, expect, it } from "vitest";
import { adoptConversationSettings, conversationSettings, settingsSchema } from "./cloud-send-chats.ts";
import { listConnections, connectionFingerprints, answerConnection } from "./cloud-connections.ts";
import type { AppConfig } from "./config.ts";

/** A bot with one conversation, and a room with one, as My Cloud holds them; each change is recorded. */
function held(task: Record<string, unknown> = {}, room: Record<string, unknown> = {}) {
  const bot = { id: "b1", threadId: "t-main", modelSelection: { instanceId: "claude", model: "s" }, projects: [{ id: "p1", name: "Launch" }], tasks: [{ threadId: "t1", ...task }] };
  const group = { id: "g1", threadId: "t-room", tasks: [{ threadId: "t-room" }], ...room };
  const changes: unknown[] = [];
  const store = {
    bots: [bot], groups: [group],
    bot: (id: string) => (id === "b1" ? bot : undefined), group: (id: string) => (id === "g1" ? group : undefined),
    taskByThread: (_bot: string, threadId: string) => bot.tasks.find((entry) => entry.threadId === threadId),
    patchTask: (_bot: string, threadId: string, patch: object) => { changes.push(["task", threadId, patch]); Object.assign(bot.tasks.find((entry) => entry.threadId === threadId)!, patch); return {}; },
    patchGroupTask: (_group: string, threadId: string, patch: object) => { changes.push(["room-task", threadId, patch]); return {}; },
    patchGroup: (_group: string, patch: object) => { changes.push(["room", patch]); return {}; },
  };
  return { store: store as never, changes, bot };
}
const allowed = { instance: (id: string) => id === "claude", approval: (_selection: unknown, mode: string) => mode !== "full" };

describe("a conversation's own settings", () => {
  it("go as this computer has them, without Custom approval", () => {
    const { store } = held({ approvalMode: "custom", autoApprove: false, snoozedUntil: 5, projectId: "p1", modelSelection: { instanceId: "claude", model: "o" } });
    expect(conversationSettings(store, { bot: "b1", threadId: "t1" })).toEqual({ snoozedUntil: 5, projectId: "p1", modelSelection: { instanceId: "claude", model: "o" } });
    expect(conversationSettings(held({}, { audienceFloor: "admins", tasks: [{ threadId: "t-room", turnTimeoutMinutes: 45 }] }).store, { room: "g1", threadId: "t-room" }))
      .toEqual({ turnTimeoutMinutes: 45, audienceFloor: "admins" });
  });

  it("fill only what My Cloud's copy lacks, with an engine, approval level and project it has; the audience floor only narrows", () => {
    const settings = { modelSelection: { instanceId: "claude", model: "o" }, approvalMode: "edits" as const, snoozedUntil: 9, projectId: "p1" };
    const fresh = held();
    expect(adoptConversationSettings(fresh.store, [{ threadId: "t1", settings }], allowed)).toBe(1);
    expect(fresh.changes).toEqual([["task", "t1", { modelSelection: settings.modelSelection, approvalMode: "edits", autoApprove: false, snoozedUntil: 9, projectId: "p1" }]]);
    expect(adoptConversationSettings(fresh.store, [{ threadId: "t1", settings }], allowed), "taken once").toBe(0);

    const own = held({ snoozedUntil: 1, approvalMode: "ask" });
    adoptConversationSettings(own.store, [{ threadId: "t1", settings: { ...settings, modelSelection: { instanceId: "gone", model: "x" }, projectId: "p-unknown" } }], allowed);
    expect(own.changes, "My Cloud's own snooze and approval stay; an engine or project it lacks is left out").toEqual([]);
    const full = held();
    adoptConversationSettings(full.store, [{ threadId: "t1", settings: { approvalMode: "full" } }], allowed);
    expect(full.changes, "an approval level My Cloud does not allow on that model is left out").toEqual([]);

    const room = held({}, { audienceFloor: { people: ["p_a"] } });
    expect(adoptConversationSettings(room.store, [{ threadId: "t-room", settings: { turnTimeoutMinutes: 45, audienceFloor: "everyone" } }], allowed)).toBe(1);
    expect(room.changes).toEqual([["room-task", "t-room", { turnTimeoutMinutes: 45 }]]);
    const wide = held();
    adoptConversationSettings(wide.store, [{ threadId: "t-room", settings: { audienceFloor: "admins" } }], allowed);
    expect(wide.changes).toEqual([["room", { audienceFloor: "admins" }]]);
  });

  it("carry a thread's notification mute and who chose it, and My Cloud's own choice stays", () => {
    const sent = conversationSettings(held({ notificationsMuted: true, notificationsMutedBy: "chief", snoozedUntil: 7 }).store, { bot: "b1", threadId: "t1" });
    expect(sent).toEqual({ notificationsMuted: true, notificationsMutedBy: "chief", snoozedUntil: 7 });
    const received = settingsSchema.parse(JSON.parse(JSON.stringify({ v: 1, conversations: [{ threadId: "t1", settings: sent }] })));
    const fresh = held();
    expect(adoptConversationSettings(fresh.store, received.conversations, allowed)).toBe(1);
    expect(fresh.bot.tasks[0]).toMatchObject({ notificationsMuted: true, notificationsMutedBy: "chief", snoozedUntil: 7 });

    const own = held({ notificationsMuted: false, notificationsMutedBy: "person" });
    adoptConversationSettings(own.store, received.conversations, allowed);
    expect(own.bot.tasks[0]).toMatchObject({ notificationsMuted: false, notificationsMutedBy: "person" });
    expect(conversationSettings(held({ notificationsMuted: true, snoozedUntil: 7 }).store, { bot: "b1", threadId: "t1" })).toEqual({ notificationsMuted: true, snoozedUntil: 7 });
  });
});

describe("a model on this computer's own network", () => {
  it("stays here: its key is neither listed for a move, handed over, nor fingerprinted", () => {
    const config = { openaiCompat: { key: "sk-home", url: "http://192.168.1.20:11434/v1" }, openrouter: { key: "sk-or" }, groq: { key: "gk", url: "http://localhost:9000" },
      xai: { key: "xk", url: "https://api.x.ai/v1" } } as unknown as AppConfig;
    const listed = listConnections({ config, mcpAuth: () => "signed-out" as never, composio: null, highlevel: () => null }).map((item) => item.id);
    expect(listed).toEqual(["key:openrouter", "key:xai"]);
    expect(Object.keys(connectionFingerprints("n".repeat(43), { config, highlevel: () => null }))).toEqual(["key:openrouter", "key:xai"]);
    expect(answerConnection("key:openaiCompat", { config, mcpSignIn: () => undefined, highlevel: () => null })).toEqual({ ok: false, error: "This key's model is on this computer's own network, so it stays here." });
  });
});
