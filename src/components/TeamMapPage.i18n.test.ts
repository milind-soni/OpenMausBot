// The team map computes its status in a plain helper the component renders
// through, and that helper is also read as logic. This covers that shape plus
// the panels that only render.
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setLocale, t } from "@/lib/i18n";
import { locales } from "@/locales";
import { teamMapStatus } from "@/lib/team-map";

vi.mock("@/lib/analytics", () => ({ track: () => {} }));
vi.mock("react-dom", () => ({ createPortal: (children: ReactNode) => children }));

const { BotInstructionsDialog } = await import("./BotInstructionsDialog");

afterEach(() => {
  setLocale("en");
});

describe("panel translation", () => {
  it("keeps the team-map status as a key so the pulse still matches", () => {
    // The map compares this to decide whether the dot animates. A translated
    // label would silently stop matching.
    expect(teamMapStatus({ id: "a", name: "A", busy: true })).toEqual({
      labelKey: "teamMap.status.working",
      tone: "success",
    });

    setLocale("pt-br");
    expect(t("teamMap.status.working")).toBe(locales["pt-br"]!["teamMap.status.working"]);
  });

  it("translates the bot instructions dialog", () => {
    setLocale("fr");
    vi.stubGlobal("document", { body: {} });
    const html = renderToStaticMarkup(createElement(BotInstructionsDialog, {
      bot: { id: "atlas", name: "Atlas", color: "blue", description: "" },
      onClose: () => {},
    } as never));
    expect(html).toContain(locales.fr!["botInstructions.empty"]!.replace(/'/g, "&#x27;"));
    expect(html).not.toContain("No instructions yet");
  });
});
