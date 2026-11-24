import { beforeEach, expect, it, vi } from "vitest";

const sounds = vi.hoisted(() => ({ played: [] as string[], replies: [] as Array<[string, boolean]>, read: [] as string[] }));
vi.mock("@/lib/app-sounds", () => ({
  playAppSound: (event: string) => (sounds.played.push(event), "played"),
  replySound: (id: string, inView: boolean) => (sounds.replies.push([id, inView]), "played"),
  notificationsRead: (ids: string[]) => void sounds.read.push(...ids),
}));
vi.mock("./thread-navigation", () => ({ visibleNotificationThread: (_state: unknown, threadId: string) => (threadId === "on-screen" ? threadId : null) }));

import type { ServerFrame } from "../../shared/wire";
import type { Action, AppState } from "./store";
import { actionSound, approvalSound, errorSound, frameSound } from "./store-sounds";

beforeEach(() => {
  sounds.played = [];
  sounds.replies = [];
  sounds.read = [];
});

it("sounds a send and a stop, and nothing for an approval not yet carried out or any other action", () => {
  for (const action of [
    { type: "send", botId: "b", text: "hi" },
    { type: "sendGroup", groupId: "g", text: "hi" },
    { type: "interrupt", botId: "b" },
    { type: "interruptGroup", groupId: "g" },
    { type: "decideRequest", threadId: "t", requestId: "r", behavior: "allow" },
    { type: "decideRequest", threadId: "t", requestId: "r", behavior: "deny" },
    { type: "select", botId: "b" },
  ]) actionSound(action as unknown as Action);
  errorSound();
  expect(sounds.played).toEqual(["send", "send", "stop", "stop", "error"]);
});

it("sounds a bot's text reply, saying whether its thread is on screen, and nothing for other frames", () => {
  const state = {} as AppState;
  const reply = (threadId: string, message: object) => ({ kind: "message", threadId, message }) as unknown as ServerFrame;
  frameSound(state, reply("on-screen", { id: "m1", role: "bot", kind: "text" }));
  frameSound(state, reply("elsewhere", { id: "m2", role: "bot", kind: "text" }));
  frameSound(state, reply("on-screen", { id: "m3", role: "user", kind: "text" }));
  frameSound(state, reply("on-screen", { id: "m4", role: "bot", kind: "tool" }));
  frameSound(state, { kind: "sections", sections: [] } as unknown as ServerFrame);
  expect(sounds.replies).toEqual([["m1", true], ["m2", false]]);
});

it("sounds an approval only when the server carried it out", () => {
  const answer = { ok: true, outcome: "allowed-once" };
  expect(approvalSound(answer)).toBe(answer);
  approvalSound({ ok: true, outcome: "allowed-once", settlementPending: true, message: "record pending" });
  approvalSound({ ok: true, outcome: "rejected" });
  approvalSound({ ok: true, outcome: "unavailable" });
  approvalSound(undefined);
  expect(sounds.played).toEqual(["approved"]);
});

it("passes the notices read elsewhere on, so a sound still waiting will not play for them", () => {
  frameSound({} as AppState, { kind: "notifications.read", threadId: "t", ids: ["n1", "n2"] } as ServerFrame);
  expect(sounds.read).toEqual(["n1", "n2"]);
});
