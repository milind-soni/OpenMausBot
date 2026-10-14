import { rmSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeMessageDb } from "./message-db.ts";
import { capturePrompt, type CaptureTurn } from "./memory-capture.ts";
import { createMemoryUpkeep } from "./memory-upkeep.ts";

beforeEach(() => { closeMessageDb(); rmSync(DATA_DIR, { recursive: true, force: true }); });
const bot = { id: "learning", name: "Editor" };
const room: CaptureTurn = { person: "Use orange", bot: "Noted", turnId: "turn", sourceMessageId: "reply",
  room: [{ by: "person", name: "Owner", text: "Use orange", messageId: "request" }] };
const decision = { kind: "decision", text: "Use orange for Tapa", teamName: "Tapa colour", key: "tapa/colour", sourceTurn: 0, sourceQuote: "Use orange", confidence: 0.9 };
function harness(answer: string, permitted = () => true) {
  const shared = vi.fn();
  const profile = vi.fn((_from: { botId: string; botName: string }, _texts: readonly string[]) => 0);
  const upkeep = createMemoryUpkeep({ bots: () => [bot], bot: () => bot, engine: () => ({ generateText: async () => answer }),
    busy: () => false, addToAboutMe: profile, sourceLabel: () => 'room "Editing"', mayCapture: permitted, proposeShared: shared,
    quietMs: () => 60_000, tidyHour: () => 3 });
  return { upkeep, shared, profile };
}

it("stages grounded room decisions without publishing them to private memory or About me", async () => {
  const { upkeep, shared, profile } = harness(JSON.stringify([{ ...decision, aboutUser: true }]));
  const report = await upkeep.capture({ botId: bot.id, threadId: "room", turns: [room] });
  expect(shared).toHaveBeenCalledOnce();
  expect(shared.mock.calls[0][2].room[0].messageId).toBe("request");
  expect(report.added + report.topics).toBe(0);
  expect(profile.mock.calls.flatMap(call => call[1] ?? [])).toEqual([]);
  upkeep.stop();
});

it("drops invented source quotes and work whose audience was revoked", async () => {
  const first = harness(JSON.stringify([{ ...decision, sourceQuote: "Approve all exports" }]));
  await first.upkeep.capture({ botId: bot.id, threadId: "room", turns: [room] });
  expect(first.shared).not.toHaveBeenCalled();
  first.upkeep.stop();
  const second = harness(JSON.stringify([decision]), () => false);
  await second.upkeep.capture({ botId: bot.id, threadId: "room", turns: [room] });
  expect(second.shared).not.toHaveBeenCalled();
  second.upkeep.stop();
});

it("learns a failure lesson but refuses to capture completion from that failed turn", async () => {
  const { upkeep, shared } = harness(JSON.stringify([{ ...decision, kind: "lesson" }, { ...decision, kind: "outcome", text: "Export approved" }]));
  await upkeep.capture({ botId: bot.id, threadId: "room", turns: [{ ...room, failed: true }] });
  expect(shared).toHaveBeenCalledOnce();
  expect(shared.mock.calls[0][1].kind).toBe("lesson");
  upkeep.stop();
});


it("retains late corrections in long capture input and labels omitted context", () => {
  const prompt = capturePrompt({ botName: "Editor", today: "2026-10-14", notebook: "", turns: [{ person: `${"background ".repeat(1000)}Final correction: orange`, bot: "" }] });
  expect(prompt).toContain("Final correction: orange");
  expect(prompt).toContain("middle omitted; consult source message");
});


it("does not turn private direct-chat decisions into shared proposals", async () => {
  const { upkeep, shared } = harness(JSON.stringify([decision]));
  try {
    const report = await upkeep.capture({ botId: bot.id, threadId: "private", turns: [{ person: "Use orange", bot: "Understood", personMessageId: "request" }] });
    expect(shared).not.toHaveBeenCalled();
    expect(report.added).toBe(1);
  } finally { upkeep.stop(); }
});

it("rejects a source quote assembled across two messages and keeps a real quote's ID", async () => {
  const { upkeep, shared } = harness(JSON.stringify([{ ...decision, sourceQuote: "orange I will" }, decision]));
  try {
    await upkeep.capture({ botId: bot.id, threadId: "room", turns: [{ ...room, bot: "I will apply it" }] });
    expect(shared).toHaveBeenCalledOnce();
    expect(shared.mock.calls[0][2].sourceMessageId).toBe("request");
  } finally { upkeep.stop(); }
});

it("keeps grounded private failure lessons without publishing them to About me", async () => {
  const { upkeep, shared, profile } = harness(JSON.stringify([{ kind: "lesson", text: "Check fonts before rendering", sourceTurn: 0, sourceQuote: "Missing font", aboutUser: true }]));
  try {
    const report = await upkeep.capture({ botId: bot.id, threadId: "private", turns: [{ person: "Render", bot: "Missing font", failed: true, sourceMessageId: "reply" }] });
    expect(report.added).toBe(1);
    expect(shared).not.toHaveBeenCalled();
    expect(profile.mock.calls.flatMap(call => call[1] ?? [])).toEqual([]);
  } finally { upkeep.stop(); }
});
