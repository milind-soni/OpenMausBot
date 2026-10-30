import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Bot } from "@/state/store";
import type { CalendarEventItem } from "../RoutineCalendarPage";
import { CalendarEventCard, cardLayout, HOUR_HEIGHT } from "./CalendarEventCard";

const hazel: Bot = {
  id: "hazel", threadId: "t", name: "Hazel", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages: [], modelSelection: { instanceId: "test", model: "test" },
} as Bot;
const at = new Date(2026, 9, 29, 11, 31).getTime();
const commitCheck: CalendarEventItem = {
  kind: "routine", id: "next-streak", at, durationMinutes: 30, run: null,
  routine: {
    id: "streak", name: "Daily GitHub commit-streak check", prompt: "Check today's commits.", target: "bot", botId: hazel.id, runOn: "maus", enabled: true,
    schedule: { type: "interval", everyMinutes: 360 }, durationMinutes: 30, nextRunAt: at, createdAt: 0, updatedAt: 0,
  },
} as CalendarEventItem;
const call = (minutes: number): CalendarEventItem => ({
  kind: "call", id: `call-${minutes}`, at, durationMinutes: minutes,
  call: { id: "c", name: "Weekly planning", description: "", botIds: [hazel.id], schedule: { type: "once" }, durationMinutes: minutes, attachments: [], nextRunAt: at, createdAt: 0, updatedAt: 0 },
} as unknown as CalendarEventItem);
const render = (item: CalendarEventItem) => renderToStaticMarkup(createElement(CalendarEventCard, {
  item, bots: [hazel], groups: [], compact: true, layout: { column: 0, columns: 1 }, onOpen: () => {}, onResize: () => {},
}));
const visibleText = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("a calendar card's fit", () => {
  it("gives a 30-minute marker one line, a full hour two, and a quarter hour just the title", () => {
    expect(cardLayout((30 / 60) * HOUR_HEIGHT)).toBe("compact");
    expect(cardLayout(HOUR_HEIGHT)).toBe("roomy");
    expect(cardLayout((15 / 60) * HOUR_HEIGHT)).toBe("tiny");
  });

  it("draws a 30-minute automation as one line of title, status and time, with the rest on hover", () => {
    const html = render(commitCheck);
    expect(html).toContain('data-event-fit="compact"');
    expect(html).toContain('data-event-status="working"');
    const text = visibleText(html);
    expect(text).toContain("Daily GitHub commit-streak check");
    expect(text).not.toContain("Hazel");
    expect(text).not.toMatch(/Every/);
    expect(/title="([^"]*)"/.exec(html)?.[1]).toMatch(/^Daily GitHub commit-streak check · 11:31.* · Hazel · Every 6 hr$/);
  });

  it("keeps the second line for an hour-long call, and only the title for a 15-minute one", () => {
    const hour = render(call(60));
    expect(hour).toContain('data-event-fit="roomy"');
    expect(visibleText(hour)).toMatch(/Weekly planning .* · 1 bot/);
    const quarter = render(call(15));
    expect(quarter).toContain('data-event-fit="tiny"');
    expect(visibleText(quarter)).toBe("Weekly planning");
  });
});
