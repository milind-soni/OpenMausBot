import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { t } from "@/lib/i18n";
import { StoreProvider, type Bot } from "@/state/store";
import { draftOf, MausBotWelcomeCard, mausBotWelcomeDue, welcomeName, welcomePatch } from "./MausBotWelcome";

const maus = { id: "maus", threadId: "t1", name: "MausBot", title: "", description: "", notifications: true, color: "chrome", mascotBody: null,
  avatarUrl: null, unread: false, modelSelection: { instanceId: "claude", model: "sonnet" }, createdAt: 1, defaultBot: {} } as unknown as Bot;

describe("MausBot's first-launch welcome", () => {
  it("shows once, after onboarding and its tour, and never again after either choice", () => {
    const due = (bot: Pick<Bot, "welcomed" | "hidden"> | undefined, more: Partial<Parameters<typeof mausBotWelcomeDue>[0]> = {}) =>
      mausBotWelcomeDue({ bot, onboardingDue: false, welcomeOpen: false, tourOpen: false, ...more });
    expect(due({})).toBe(true);
    expect(due({ welcomed: true })).toBe(false);
    expect(due({}, { onboardingDue: true })).toBe(false);
    expect(due({}, { welcomeOpen: true })).toBe(false);
    expect(due({}, { tourOpen: true })).toBe(false);
    expect(due(undefined)).toBe(false);
    expect(due({ hidden: true })).toBe(false);
  });

  it("Add saves the person's changes, pins MausBot and keeps it in the sidebar", () => {
    expect(welcomePatch(maus, { ...draftOf(maus), name: " Jarvis ", color: "blue", mascotBody: "blob" }, true))
      .toEqual({ name: "Jarvis", color: "blue", mascotBody: "blob", welcomed: true, sidebarHidden: false, pinned: true });
  });

  it("Add with the panel never opened keeps the chrome-steel defaults", () => {
    expect(welcomePatch(maus, draftOf(maus), true)).toEqual({ welcomed: true, sidebarHidden: false, pinned: true });
  });

  it("Not now turns Show MausBot in the sidebar off, keeping what was changed, and nothing unchanged is sent", () => {
    expect(welcomePatch(maus, draftOf(maus), false)).toEqual({ welcomed: true, sidebarHidden: true });
    expect(welcomePatch(maus, { ...draftOf(maus), mascotBody: "star" }, false)).toEqual({ mascotBody: "star", welcomed: true, sidebarHidden: true });
  });

  it("saves an empty name as MausBot and caps a long one at the bot-name limit", () => {
    const jarvis = { ...maus, name: "Jarvis" };
    expect(welcomePatch(jarvis, { ...draftOf(jarvis), name: "   " }, true).name).toBe("MausBot");
    expect(welcomeName("x".repeat(300))).toHaveLength(100);
    expect(welcomeName("  Ada ")).toBe("Ada");
  });

  it("saves an uploaded picture as the bot's own edit screen would, and a colour picked after it goes back to the shape", () => {
    const uploaded = { ...draftOf(maus), avatarUrl: "/api/attachments/abc.png", avatarCrop: "circle" as const };
    expect(welcomePatch(maus, uploaded, true)).toEqual({ avatarUrl: "/api/attachments/abc.png", avatarCrop: "circle", welcomed: true, sidebarHidden: false, pinned: true });
    expect(welcomePatch(maus, { ...uploaded, color: "blue", avatarCrop: "mascot" }, true))
      .toEqual({ avatarUrl: "/api/attachments/abc.png", color: "blue", welcomed: true, sidebarHidden: false, pinned: true });
    const pictured = { ...maus, avatarUrl: "/api/attachments/abc.png", avatarCrop: "circle" } as Bot;
    expect(welcomePatch(pictured, { ...draftOf(pictured), avatarUrl: null, avatarCrop: "mascot" }, true))
      .toEqual({ avatarUrl: null, avatarCrop: "mascot", welcomed: true, sidebarHidden: false, pinned: true });
  });

  it("opens on MausBot's picture alone: the customise panel stays closed until the picture is clicked", () => {
    const html = renderToStaticMarkup(createElement(StoreProvider, null, createElement(MausBotWelcomeCard, { bot: maus, onClose: () => {} })));
    expect(html).toContain(`aria-label="${t("mausbotWelcome.customize", { name: "MausBot" })}"`);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-mausbot-welcome-panel="closed"');
    expect(html).toMatch(/data-mausbot-welcome-panel="closed"[^>]*|inert=""[^>]*data-mausbot-welcome-panel="closed"/);
    expect(html).toContain(t("mausbotWelcome.title", { name: "MausBot" }));
    expect(html).toContain(t("mausbotWelcome.add", { name: "MausBot" }));
  });
});
