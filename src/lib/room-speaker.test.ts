import { describe, expect, it } from "vitest";
import type { Message } from "@/state/store";
import { groupActivityRuns } from "./activity-runs";
import { botTextShowsSpeaker, runShowsSpeaker } from "./room-speaker";

const day = 1_700_000_000_000;

function text(id: string, role: "user" | "bot", body: string, from?: { botId: string; name: string; color: "blue" | "orange" }, at = day): Message {
  return {
    id, role, kind: "text", at, text: body,
    ...(from ? { from } : {}),
  };
}

const ada = { botId: "ada", name: "Ada", color: "blue" as const };
const kai = { botId: "kai", name: "Kai", color: "orange" as const };

function tool(id: string, from: { botId: string; name: string; color: "blue" | "orange" }, at = day): Message {
  return { id, role: "bot", kind: "activity", at, tool: { name: "Read", ok: true }, from };
}

describe("room speaker labels", () => {
  it("names the first bot bubble after the person, and not the next one from the same bot", () => {
    const items = groupActivityRuns([
      text("u", "user", "hello"),
      text("a", "bot", "one", ada),
      text("b", "bot", "two", ada),
    ]);
    expect(items.map((_, index) => botTextShowsSpeaker(items, index))).toEqual([false, true, false]);
  });

  it("names each bot again when the speaker changes, including after the person", () => {
    const items = groupActivityRuns([
      text("a", "bot", "from ada", ada),
      text("u", "user", "your turn"),
      text("k", "bot", "from kai", kai),
      text("a2", "bot", "ada again", ada),
    ]);
    const named = items.flatMap((item, index) => botTextShowsSpeaker(items, index) && item.kind === "message" ? [item.message.from?.name] : []);
    expect(named).toEqual(["Ada", "Kai", "Ada"]);
  });

  it("still names the text when a digest sits between the person and the reply", () => {
    const digest: Message = { id: "d", role: "bot", kind: "digest", at: day, text: "folded", from: ada };
    const items = groupActivityRuns([
      text("u", "user", "go"),
      digest,
      text("a", "bot", "done", ada),
    ]);
    const reply = items.findIndex((item) => item.kind === "message" && item.message.id === "a");
    expect(botTextShowsSpeaker(items, reply)).toBe(true);
  });

  it("puts the name on the text, not the tool run, when both belong to the same reply", () => {
    const messages = [
      text("u", "user", "look"),
      tool("t1", ada),
      tool("t2", ada, day + 1),
      text("a", "bot", "found it", ada, day + 2),
    ];
    const shown = groupActivityRuns(messages.filter((message) => message.kind !== "activity"));
    const hiddenTools = groupActivityRuns(messages);
    const reply = hiddenTools.findIndex((item) => item.kind === "message" && item.message.id === "a");
    const run = hiddenTools.findIndex((item) => item.kind === "run");
    expect(botTextShowsSpeaker(shown, shown.findIndex((item) => item.kind === "message" && item.message.id === "a"))).toBe(true);
    expect(botTextShowsSpeaker(hiddenTools, reply)).toBe(true);
    expect(runShowsSpeaker(hiddenTools, run, true)).toBe(false);
    expect(runShowsSpeaker(hiddenTools, run, false)).toBe(false);
  });

  it("names a tool run that is the whole reply", () => {
    const items = groupActivityRuns([
      text("u", "user", "look"),
      tool("t1", kai),
      tool("t2", kai, day + 1),
    ]);
    const run = items.findIndex((item) => item.kind === "run");
    expect(runShowsSpeaker(items, run, true)).toBe(true);
  });
});
