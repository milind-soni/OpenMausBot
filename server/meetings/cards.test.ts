import { describe, expect, it } from "vitest";
import { readWidgetText } from "../../shared/widget-text.ts";
import { parseWidgetInput } from "../../shared/widget.ts";
import en from "../../src/locales/en.json" with { type: "json" };
import { LEAVE_ACTION, liveCard, notesCard } from "./cards.ts";
import type { MeetingRecord } from "./manager.ts";

const record = (over: Partial<MeetingRecord> = {}): MeetingRecord => ({
  id: "m-1", botId: "b1", botName: "Ada", threadId: "t1", owner: "b1", platform: "meet", url: "https://meet.google.com/abc-defg-hij", createdAt: 0,
  phase: "lobby", others: 0, attendees: [], lines: 0, seq: 0, speech: "eleven", questions: 0, ...over,
});

const nodes = (root: unknown): Array<Record<string, any>> => {
  const node = root as Record<string, any>;
  return [node, ...((node.children as unknown[] | undefined) ?? []).flatMap(nodes)];
};

describe("meeting cards", () => {
  it("shows where the meeting is, with Leave until it ends", () => {
    const waiting = liveCard(record(), 0);
    expect(nodes(waiting).map((node) => node.value).filter(Boolean)).toEqual(["Waiting for the host to let me in"]);
    expect(nodes(waiting).find((node) => node.type === "Button")).toMatchObject({ label: "Leave meeting", onClickAction: { type: LEAVE_ACTION, payload: { meetingId: "m-1" } } });
    const live = liveCard(record({ phase: "in_meeting", others: 3, joinedAt: 1 }), 12);
    expect(nodes(live).find((node) => node.type === "Text")?.value).toBe("In the meeting · others here: 3 · 12 min");
    const ended = liveCard(record({ phase: "ended", joinedAt: 1, endReason: "alone", notes: "asked" }), 47);
    expect(nodes(ended).map((node) => node.value).filter(Boolean)).toEqual(["Ended after 47 min. Everyone else left, so I left too.", "Writing the notes…"]);
    expect(nodes(ended).some((node) => node.type === "Button")).toBe(false);
    expect(nodes(liveCard(record({ phase: "ended", endReason: "denied" }), 0)).find((node) => node.type === "Text")?.value).toBe("The host turned down my request to join.");
  });

  it("are valid widgets whose words all come from the language packs", () => {
    const cards = [
      liveCard(record({ phase: "in_meeting", others: 1, joinedAt: 1, questions: 2 }), 3),
      liveCard(record({ phase: "ended", joinedAt: 1, endReason: "stop_requested" }), 3),
      notesCard(record({ phase: "ended", attendees: ["Alice"] }), { title: "Sync", summary: "One.\nTwo.", decisions: ["Ship"], actions: [{ item: "Write it", owner: "Bob" }], questions: ["When?"] }, 30, "Monday"),
    ];
    for (const card of cards) {
      expect(parseWidgetInput(card)).toMatchObject({ ok: true });
      for (const node of nodes(card)) {
        for (const text of Object.values(readWidgetText(node.i18n) ?? {})) {
          expect(Object.hasOwn(en, text.key)).toBe(true);
          for (const param of Object.values(text.params ?? {})) if (typeof param === "object" && "key" in param) expect(Object.hasOwn(en, param.key)).toBe(true);
        }
      }
    }
  });
});
