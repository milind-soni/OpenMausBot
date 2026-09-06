import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { setLocale } from "@/lib/i18n";
import { StoreProvider, type Bot, type Message } from "@/state/store";
import { ApprovalCard } from "./ApprovalCard";
import {
  PendingApprovalActions,
  PendingApprovalPanel,
  spokenApprovalPrompt,
  type Pending,
} from "./PendingApproval";

function commandApproval(answered?: "allow" | "deny"): { message: Message; pending: Pending } {
  const message: Message = {
    id: "approval-card",
    role: "bot",
    kind: "options",
    at: 1,
    card: {
      title: "Approval needed",
      subtitle: "pnpm test",
      options: ["Allow", "Deny"],
      answered,
      requestId: "approval-request",
      tool: "Bash",
    },
  };
  return {
    message,
    pending: {
      message,
      requestId: "approval-request",
      tool: "Bash",
      allowKey: "Bash:pnpm test",
      detail: "pnpm test",
    },
  };
}

afterEach(() => {
  setLocale("en");
});

describe("German approval cards", () => {
  it("renders a pending command approval in German", () => {
    setLocale("de");
    const { message } = commandApproval();

    const markup = renderToStaticMarkup(createElement(ApprovalCard, {
      bot: { name: "Mochi" } as Bot,
      message,
    }));

    expect(markup).toContain("Mochi möchte einen Befehl ausführen");
    expect(markup).toContain('aria-label="Details zur Freigabe"');
    expect(markup).toContain("Wartet unten auf deine Antwort");
  });

  it("renders a denied command approval in German", () => {
    setLocale("de");
    const { message } = commandApproval("deny");

    const markup = renderToStaticMarkup(createElement(ApprovalCard, { message }));

    expect(markup).toContain("Abgelehnt");
  });

  it("renders the pending approval strip in German", () => {
    setLocale("de");
    const { pending } = commandApproval();

    const markup = renderToStaticMarkup(createElement(PendingApprovalPanel, {
      pending,
      count: 3,
      index: 1,
    }));

    expect(markup).toContain('aria-label="Ausstehende Freigabe"');
    expect(markup).toContain("Ausstehende Freigabe");
    expect(markup).toContain("2 von 3");
    expect(markup).toContain("Befehlsfreigabe angefordert");
    expect(markup).toContain('aria-label="Details zur Freigabe prüfen"');
  });

  it("speaks a command approval in German", () => {
    setLocale("de");
    const { pending } = commandApproval();

    expect(spokenApprovalPrompt(pending, "Mochi")).toBe(
      "Mochi möchte Bash ausführen. pnpm test. Soll ich das erlauben?",
    );
  });

  it("renders command approval actions in German", () => {
    setLocale("de");
    const { pending } = commandApproval();

    const markup = renderToStaticMarkup(createElement(
      StoreProvider,
      null,
      createElement(PendingApprovalActions, {
        pending,
        threadId: "thread-1",
        bot: { id: "bot-1", name: "Mochi" } as Bot,
        onCancelTurn: () => undefined,
      }),
    ));

    expect(markup).toContain("Ausführung abbrechen");
    expect(markup).toContain("Ablehnen");
    expect(markup).toContain("Immer erlauben");
    expect(markup).toContain("Einmal erlauben");
    expect(markup).toContain("Bei Mochi nicht mehr nach Bash:pnpm test fragen");
  });
});
