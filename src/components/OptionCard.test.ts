import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GroupRequestCard } from "./GroupRequestCard";
import { OptionCard, questionAnswerPayload } from "./OptionCard";
import { StoreProvider, type Message } from "@/state/store";

describe("OptionCard questions", () => {
  it.each([
    { name: "selected only", selected: ["A", "B"], custom: "", expected: { answer: "A, B", selected: ["A", "B"], custom: undefined } },
    { name: "selected and custom", selected: ["A"], custom: "  because it is safer  ", expected: { answer: "because it is safer", selected: ["A"], custom: "because it is safer" } },
    { name: "single custom", selected: [], custom: "  another answer  ", expected: { answer: "another answer", selected: [], custom: "another answer" } },
    { name: "blank skip", selected: [], custom: "   ", expected: { answer: "Skipped", selected: [], custom: undefined } },
  ])("builds the official selected/custom shape for $name", ({ selected, custom, expected }) => {
    expect(questionAnswerPayload(selected, custom)).toEqual(expected);
  });

  it("treats even an empty authoritative answer as settled", () => {
    const message = {
      id: "answered-question",
      role: "bot",
      kind: "options",
      at: 1,
      card: { title: "Question", subtitle: "Choose", options: ["A"], requestId: "request", answered: "" },
    } satisfies Message;
    const markup = renderToStaticMarkup(createElement(StoreProvider, null,
      createElement(OptionCard, { botId: "bot", message }),
    ));

    expect(markup).toContain('aria-label="Dismiss question"');
    expect(markup.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("renders provider question cards through the room transcript request component", () => {
    const question = {
      id: "room-question",
      role: "bot",
      kind: "options",
      at: 1,
      card: { title: "Your bot has a question", subtitle: "Which branch?", options: ["main", "release"], requestId: "room-request" },
      from: { botId: "member", name: "Member", color: "green" },
    } satisfies Message;
    const markup = renderToStaticMarkup(createElement(StoreProvider, null,
      createElement(GroupRequestCard, { groupId: "room", message: question }),
    ));

    expect(markup).toContain("Which branch?");
    expect(markup).toContain("main");
    expect(markup).toContain("release");
    expect(markup).toContain('placeholder="Type your own answer"');
  });
});
