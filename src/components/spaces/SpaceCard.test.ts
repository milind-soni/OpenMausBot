import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SpaceCard } from "./SpaceCard";
import type { Bot, Group } from "@/state/store";

const bot = (over: Partial<Bot> = {}) =>
  ({
    id: "bot-1",
    threadId: "t1",
    name: "Gmail",
    title: "Inbox",
    description: "",
    notifications: true,
    color: "blue",
    unread: false,
    modelSelection: {},
    messages: [],
    ...over,
  }) as Bot;

const group = (over: Partial<Group> = {}) =>
  ({
    id: "room-1",
    threadId: "t2",
    name: "Design",
    memberIds: ["bot-1"],
    defaultResponder: "auto",
    bulletin: "",
    unread: false,
    createdAt: 0,
    messages: [],
    ...over,
  }) as unknown as Group;

const render = (props: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(SpaceCard as never, {
      focused: false,
      onFocus: () => {},
      children: createElement("div", null, "body"),
      ...props,
    }),
  );

describe("SpaceCard", () => {
  it("names the bot and shows its status chip", () => {
    const html = render({ subject: bot({ activity: "waiting-on-you" }) });
    expect(html).toContain("Gmail");
    expect(html).toContain("Waiting on you");
  });

  it("labels a room as a room, not a bot", () => {
    const html = render({ subject: group({ memberIds: ["a", "b", "c"] }) });
    expect(html).toContain("Design");
    expect(html).toContain("3 members");
  });

  it("marks the focused card for assistive tech and leaves the rest unmarked", () => {
    expect(render({ subject: bot(), focused: true })).toContain('aria-current="true"');
    expect(render({ subject: bot(), focused: false })).not.toContain('aria-current="true"');
  });

  it("renders the body it is given", () => {
    expect(render({ subject: bot() })).toContain("body");
  });

  it("shows a snapshot placeholder instead of the body when parked", () => {
    const html = render({ subject: bot(), parked: true });
    expect(html).not.toContain("body");
    expect(html).toContain("Gmail");
  });

  it("stays keyboard reachable", () => {
    expect(render({ subject: bot() })).toContain("<button");
  });
});
