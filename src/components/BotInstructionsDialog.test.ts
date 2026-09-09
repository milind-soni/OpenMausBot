import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Bot } from "@/state/store";

vi.mock("react-dom", () => ({
  createPortal: (children: ReactNode) => children,
}));

import { BotInstructionsDialog } from "./BotInstructionsDialog";

const bot = (description: string): Bot => ({
  id: "bot-1",
  threadId: "thread-1",
  name: "Scout",
  title: "Research specialist",
  description,
  notifications: true,
  color: "purple",
  unread: false,
  modelSelection: { instanceId: "fixture", model: "fixture-model" },
  messages: [],
});

function renderDialog(description: string): string {
  vi.stubGlobal("document", { body: {} });
  return renderToStaticMarkup(
    createElement(BotInstructionsDialog, { bot: bot(description), onClose: vi.fn() }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("BotInstructionsDialog", () => {
  it("renders the complete multiline instructions without truncating them", () => {
    const instructions = [
      "BEGIN-INSTRUCTIONS",
      "",
      "Research every claim and preserve its source URL.",
      "- Separate facts from inference.",
      "- Call out uncertainty plainly.",
      "",
      "END-INSTRUCTIONS",
    ].join("\n");

    const markup = renderDialog(instructions);

    expect(markup).toContain(instructions);
    expect(markup).not.toContain("line-clamp");
  });

  it("renders a clear empty state for blank instructions", () => {
    const markup = renderDialog("  \n\t  ");

    expect(markup).toContain("No instructions yet");
    expect(markup).toContain("Add them from this bot’s profile.");
    expect(markup).not.toContain("whitespace-pre-wrap");
  });
});
