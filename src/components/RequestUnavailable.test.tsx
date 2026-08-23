import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ApprovalCard } from "./ApprovalCard";
import { OptionCardView } from "./OptionCard";
import type { Message } from "@/state/store";

const unavailable = (tool?: string): Message => {
  const message: Message = {
    id: "request-unavailable",
    at: 1,
    role: "bot",
    kind: "options",
    card: {
      title: "Permission needed",
      subtitle: "Run the fixture",
      options: [],
      requestId: "request-1",
      answered: "unavailable",
      dismissed: true,
    },
  };
  if (tool && message.card) message.card.tool = tool;
  return message;
};

describe("unavailable request cards", () => {
  it("does not misrepresent an unavailable approval as denied", () => {
    const markup = renderToStaticMarkup(createElement(ApprovalCard, { message: unavailable("shell") }));

    expect(markup).toContain("Unavailable");
    expect(markup).toContain("action not run");
    expect(markup).not.toContain("Denied");
  });

  it("keeps an unavailable question visible with an explicit no-answer status", () => {
    const markup = renderToStaticMarkup(createElement(OptionCardView, {
      message: unavailable(),
      custom: "",
      selected: [],
      setCustom: () => {},
      toggle: () => {},
      claimSubmission: () => false,
      onAnswer: () => {},
      onDismiss: () => {},
    }));

    expect(markup).toContain("Unavailable");
    expect(markup).toContain("no answer was sent");
  });
});
