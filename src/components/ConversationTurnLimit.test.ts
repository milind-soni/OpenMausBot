import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Group } from "@/state/store";

vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
});

const { StoreProvider } = await import("@/state/store");
const { ConversationTurnLimit } = await import("./ConversationTurnLimit");
afterAll(() => vi.unstubAllGlobals());

const room = (tasks: Group["tasks"]): Group => ({
  id: "room",
  threadId: "launch",
  name: "Launch",
  memberIds: [],
  defaultResponder: { kind: "mentions" },
  bulletin: "",
  unread: false,
  createdAt: 1,
  messages: [],
  tasks,
});

describe("conversation turn limit", () => {
  it("offers 30 minutes for this conversation and shows the group default", () => {
    const markup = renderToStaticMarkup(createElement(
      StoreProvider,
      null,
      createElement(ConversationTurnLimit, { group: room([{ threadId: "launch", title: "Launch", createdAt: 1 }]) }),
    ));
    expect(markup).toContain('data-testid="conversation-turn-limit"');
    expect(markup).toContain("Default (5 min)");
    expect(markup).toContain("30 minutes");
    expect(markup).toContain("selected");
    expect(markup).toContain('value="default"');
  });

  it("selects a saved 30 minute limit on that conversation only", () => {
    const markup = renderToStaticMarkup(createElement(
      StoreProvider,
      null,
      createElement(ConversationTurnLimit, {
        group: room([
          { threadId: "launch", title: "Launch", createdAt: 1, turnTimeoutMinutes: 30 },
          { threadId: "other", title: "Other", createdAt: 2 },
        ]),
      }),
    ));
    expect(markup).toContain('value="30" selected');
  });
});
