import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Message } from "@/state/store";
import { t } from "@/lib/i18n";
import { ConnectorCard } from "./ConnectorCard";

const view = (connector: Partial<NonNullable<Message["connector"]>>) => renderToStaticMarkup(createElement(ConnectorCard, {
  botId: "atlas",
  threadId: "thread",
  message: {
    id: "m1",
    role: "bot",
    kind: "connector",
    at: 1,
    connector: { slug: "github", label: "GitHub", description: "Read pull requests", status: "required", resumeKey: "resume1", ...connector },
  },
}));

describe("ConnectorCard ask card", () => {
  it("asks for the sign-in in the shared ask card, with the app as its accent title", () => {
    const html = view({});
    expect(html).toContain('data-ask-card="pending"');
    expect(html).toContain('data-tour="connector"');
    expect(html).toContain("text-accent-text");
    expect(html).toContain(t("connectors.card.connectSecurely"));
    expect(html).toContain(`aria-label="${t("connectors.card.notNow")}"`);
  });

  it("folds into one line once connected and the bot is continuing", () => {
    const html = view({ status: "connected", resumed: true });
    expect(html).toContain('data-ask-card="settled"');
    expect(html).toContain(t("connectors.card.connected"));
    expect(html).toContain(t("connectors.card.continuing"));
    expect(html).not.toContain(t("connectors.card.connectSecurely"));
    expect(html).not.toContain(t("connectors.card.notNow"));
  });

  it("keeps Continue task on the line while the task is still paused", () => {
    const html = view({ status: "connected" });
    expect(html).toContain('data-ask-card="settled"');
    expect(html).toContain(t("connectors.card.continueTask"));
  });

  it("draws nothing once dismissed", () => {
    expect(view({ dismissed: true })).toBe("");
  });
});
