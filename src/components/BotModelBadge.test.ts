import { createElement, type MemoExoticComponent, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, type AppState, type Bot, type InstanceInfo } from "@/state/store";
import type { SidebarDensity } from "@/lib/sidebar-preferences";

const fixture = vi.hoisted(() => ({ state: {} as Partial<AppState> }));
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => false }));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({}) }));
vi.mock("react-dom", () => ({ createPortal: (node: ReactNode) => node }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, ...fixture.state }, dispatch: vi.fn() }) };
});

import { BotModelBadge, BotModelMark, botModel } from "./BotModelBadge";
import { BotListItem, botRowProps, type BotRowProps } from "./Sidebar";

const claude = {
  instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", snapshot: { state: "available" },
  models: { default: "sonnet", options: [{ id: "sonnet", label: "Sonnet 4.5" }, { id: "opus", label: "Opus 4.1" }] },
} as InstanceInfo;
const bot = (instanceId: string, model: string): Bot => ({
  id: "atlas", threadId: "t", name: "Atlas", title: "", description: "", color: "green",
  notifications: true, unread: false, messages: [], modelSelection: { instanceId, model },
});

describe("botModel", () => {
  it("names the bot's chosen model by its picker label", () => {
    expect(botModel(bot("claude", "opus"), [claude])).toEqual({ instance: claude, label: "Opus 4.1" });
  });

  it("names the engine's default model when the bot has not chosen one", () => {
    expect(botModel(bot("claude", ""), [claude])?.label).toBe("Sonnet 4.5");
  });

  it("falls back to the raw id of a model the engine does not list", () => {
    expect(botModel(bot("claude", "claude-custom-7"), [claude])?.label).toBe("claude-custom-7");
  });

  it("finds nothing for an engine that is not installed", () => {
    expect(botModel(bot("gone", "opus"), [claude])).toBeNull();
  });
});

describe("BotModelBadge", () => {
  it("draws the engine mark, names only the model on hover and the engine too for screen readers", () => {
    const markup = renderToStaticMarkup(createElement(BotModelBadge, { bot: bot("claude", "opus"), instances: [claude], avatarSize: 44 }));
    expect(markup).toContain('data-testid="model-badge"');
    expect(markup).toContain('aria-label="Model: Opus 4.1 (Claude)"');
    expect(markup).toContain('title="Opus 4.1"');
    expect(markup).toContain("<svg");
  });

  it("draws nothing for an engine that is not installed", () => {
    expect(renderToStaticMarkup(createElement(BotModelBadge, { bot: bot("gone", "opus"), instances: [claude], avatarSize: 44 }))).toBe("");
  });
});

describe("BotModelMark", () => {
  it("draws the engine mark, names only the model on hover and the engine too for screen readers", () => {
    const markup = renderToStaticMarkup(createElement(BotModelMark, { bot: bot("claude", "opus"), instances: [claude] }));
    expect(markup).toContain('aria-label="Model: Opus 4.1 (Claude)"');
    expect(markup).toContain('title="Opus 4.1"');
    expect(markup).toContain("<svg");
  });

  it("draws nothing for an engine that is not installed", () => {
    expect(renderToStaticMarkup(createElement(BotModelMark, { bot: bot("gone", "opus"), instances: [claude] }))).toBe("");
  });
});

describe("sidebar bot row", () => {
  const botRow = (BotListItem as MemoExoticComponent<(props: BotRowProps) => ReactNode>).type;
  const render = (candidate: Bot, density: SidebarDensity) => renderToStaticMarkup(createElement(botRow,
    botRowProps({ ...initialState, ...fixture.state }, vi.fn(), candidate, { density, quiet: density === "compact", query: "", onMenu: vi.fn() })));
  const badges = (markup: string) => markup.match(/<span data-testid="model-badge"[^>]*>/g) ?? [];

  beforeEach(() => {
    fixture.state = { bots: [bot("claude", "opus")], instances: [claude], activeView: "chat", selectedId: "other" };
    vi.stubGlobal("window", { innerWidth: 1024, innerHeight: 768 });
    vi.stubGlobal("document", { body: {} });
    vi.stubGlobal("HTMLInputElement", class {});
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  // Comfortable and compact put the mark at the end of the row's text, clear of the avatar's status dots;
  // icons-only has no row text, so the badge stays on the avatar.
  it.each<[SidebarDensity, string]>([["comfortable", "ml-auto"], ["compact", "ml-auto"], ["icons", "absolute -bottom-0.5 -left-0.5"]])(
    "shows the model once in a %s row", (density, placement) => {
      const found = badges(render(bot("claude", "opus"), density));
      expect(found).toHaveLength(1);
      expect(found[0]).toContain('aria-label="Model: Opus 4.1 (Claude)"');
      expect(found[0]).toContain(placement);
    });

  it("shows no badge while the bot's engine is missing", () => {
    expect(render(bot("gone", "opus"), "comfortable")).not.toContain('data-testid="model-badge"');
  });
});
