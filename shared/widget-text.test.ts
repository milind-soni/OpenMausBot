import { describe, expect, it } from "vitest";

import { readWidgetText } from "./widget-text.ts";

describe("readWidgetText", () => {
  it("keeps brief keys, their params, nested keys and moments", () => {
    const fields = { title: { key: "brief.card.meetingLine", params: { time: { at: 1, style: "clock", zone: "UTC" }, title: "Standup", who: { key: "brief.part.aBot" } } } };
    expect(readWidgetText(fields)).toEqual(fields);
  });

  it("drops any other key, a malformed param, a moment of no known style and nesting past its depth", () => {
    expect(readWidgetText({ value: { key: "settings.title" } })).toBeUndefined();
    expect(readWidgetText({ value: { key: "brief.card.more", params: { count: { x: 1 } } } })).toBeUndefined();
    expect(readWidgetText({ value: { key: "brief.card.more", params: { at: { at: 1, style: "eon" } } } })).toBeUndefined();
    const deep = { key: "brief.part.aBot", params: { a: { key: "brief.part.aBot", params: { a: { key: "brief.part.aBot", params: { a: { key: "brief.part.aBot", params: { a: { key: "brief.part.aBot" } } } } } } } } };
    expect(readWidgetText({ value: deep })).toBeUndefined();
    expect(readWidgetText("brief.card.title")).toBeUndefined();
  });
});
