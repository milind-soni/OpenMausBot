// @vitest-environment happy-dom
// The Simple bot panel in a real DOM, where effects run and focus moves: named links, Escape and focus.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, BotSettingsSection } from "@/state/store";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({ state: original.initialState, dispatch: fixture.dispatch, flushBotPatches: () => Promise.resolve(null) }),
  };
});
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => false, readAdvancedMode: () => false, setAdvancedMode: vi.fn() }));
vi.mock("../DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("../DesktopCapabilities")>(),
  useCaptionChrome: () => ({ dragProps: {}, padClass: "" }),
}));
vi.mock("../Avatar", () => ({ BotAvatar: () => null, MausAvatar: () => null }));
vi.mock("../AvatarImageGenerator", () => ({ AvatarImageGenerator: () => null }));
vi.mock("@/lib/use-organization-branding", () => ({ useOrganizationBranding: () => null }));
const stub = (name: string) => (props: Record<string, unknown>) =>
  createElement("div", { [`data-stub-${name}`]: true, "data-editing-instructions": props.editingInstructions === true ? "true" : undefined },
    name === "bot" ? createElement("section", { "data-panel-card": "conversations" }) : null);
vi.mock("./BotTab", () => ({ BotTab: stub("bot") }));
vi.mock("./ComputerTab", () => ({ ComputerTab: stub("computer") }));
vi.mock("./pages", () => ({ PageBody: ({ page }: { page: string }) => createElement("div", { "data-stub-page": page }), pageSurfaceCls: "" }));

const { BotPanel } = await import("./PanelShell");
const { openBotSettings } = await import("./panel-link");
const { ChatHeadConversation } = await import("../ChatHeadConversation");

const bot: Bot = {
  id: "scout", threadId: "thread-scout", name: "Scout", title: "Researcher", description: "", soul: "",
  notifications: true, color: "green", unread: false, messages: [],
  modelSelection: { instanceId: "claude", model: "claude-opus-5-5" },
};
const onClose = vi.fn();
const derived = { activeState: "idle", patch: vi.fn() } as never;

let host: HTMLDivElement;
let root: Root;
// The panel sits inside BotSettingsDialog's <aside role="dialog">, as it does in the app.
const render = (linkedSection: BotSettingsSection | null) =>
  flushSync(() => root.render(createElement("aside", { role: "dialog" }, createElement(BotPanel, { bot, derived, linkedSection, onClose }))));
// Passive effects and the renders they schedule.
const settle = async () => {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const tab = () => host.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute("data-panel-tab") ?? null;
const page = () => host.querySelector("[data-panel-page-view]")?.getAttribute("data-panel-page-view") ?? null;
const click = (element: Element | null) => {
  if (!element) throw new Error("nothing to click");
  flushSync(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
};
const press = (element: Element | null, key: string) => {
  if (!element) throw new Error("nothing to press");
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  flushSync(() => element.dispatchEvent(event));
  return event;
};
const menu = () => document.querySelector("[data-sidebar-popover-menu]");
const moreButton = () => host.querySelector('[data-testid="chat-more"]')?.closest("button") ?? null;
// What BotSettingsDialog's window listener would do with the key: close the whole panel.
const dialogCloses = vi.fn();
const onWindowKey = (event: KeyboardEvent) => {
  if (event.key === "Escape" && !event.defaultPrevented) dialogCloses();
};

beforeEach(() => {
  fixture.dispatch.mockReset();
  onClose.mockReset();
  dialogCloses.mockReset();
  window.addEventListener("keydown", onWindowKey);
  // Menus close at once instead of animating out.
  document.documentElement.dataset.reducedMotion = "true";
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  window.removeEventListener("keydown", onWindowKey);
  flushSync(() => root.unmount());
  host.remove();
  // A link without a page lands where its section does, so no test sees another's page.
  openBotSettings(vi.fn(), "overview");
});

describe("named links into the bot panel", () => {
  it("opens on the page a link names, and moves there when a link arrives while it is open", async () => {
    openBotSettings(fixture.dispatch, "access", { page: "apps" });
    render("access");
    await settle();
    expect(page()).toBe("apps");

    flushSync(() => openBotSettings(fixture.dispatch, "access", { page: "folder" }));
    await settle();
    expect(page()).toBe("folder");

    // Simple mode has no MCP page: the link lands where Access does.
    flushSync(() => openBotSettings(fixture.dispatch, "access", { page: "mcp" }));
    await settle();
    expect([tab(), page()]).toEqual(["computer", null]);

    flushSync(() => openBotSettings(fixture.dispatch, "access"));
    await settle();
    expect([tab(), page()]).toEqual(["computer", null]);
  });

  it("follows the same link again after the panel has moved on", async () => {
    openBotSettings(fixture.dispatch, "access");
    render("access");
    await settle();
    expect(tab()).toBe("computer");

    click(host.querySelector('[data-panel-tab="bot"]'));
    expect(tab()).toBe("bot");

    flushSync(() => openBotSettings(fixture.dispatch, "access"));
    render("access");
    await settle();
    expect(tab()).toBe("computer");
  });

  it("opens the Instructions editor for a soul link, and closes it when the panel moves on", async () => {
    openBotSettings(fixture.dispatch, "soul");
    render("soul");
    await settle();
    expect(tab()).toBe("bot");
    expect(host.querySelector("[data-stub-bot]")?.getAttribute("data-editing-instructions")).toBe("true");
    click(host.querySelector('[data-panel-tab="computer"]'));
    click(host.querySelector('[data-panel-tab="bot"]'));
    expect(host.querySelector("[data-stub-bot]")?.getAttribute("data-editing-instructions")).toBeNull();
  });

  it("lands usage, history, voice and visibility links on the Bot tab, with no Advanced page", async () => {
    for (const section of ["usage", "history", "voice", "visibility", "overview"] as const) {
      openBotSettings(fixture.dispatch, section);
      render(section);
      await settle();
      expect([tab(), page()], section).toEqual(["bot", null]);
    }
  });
});

describe("the panel header's Call button", () => {
  it("sits right after the bot's name, in the name's row, small and round, and not on the avatar", async () => {
    render(null);
    await settle();
    const row = host.querySelector("[data-panel-name-row]")!;
    const call = row.querySelector<HTMLButtonElement>('[data-call-button="panel"]')!;
    const name = row.querySelector("[data-panel-rename]")!;
    expect(name.textContent).toBe("Scout");
    expect(name.compareDocumentPosition(call) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(call.className.split(" ")).toEqual(expect.arrayContaining(["rounded-full", "size-8"]));
    expect(call.getAttribute("aria-label")).toContain("Scout");
    const avatar = host.querySelector("[data-panel-avatar]")!;
    expect(avatar.contains(call)).toBe(false);
    expect(avatar.nextElementSibling).toBe(row);
    expect(host.querySelectorAll("[data-call-button]")).toHaveLength(1);
  });
});

describe("the chat header's conversation title", () => {
  const withTasks: Bot = { ...bot, tasks: [
    { threadId: "thread-scout", title: "Plan the launch", createdAt: 1 },
    { threadId: "other", title: "Older notes", createdAt: 0, unread: true },
  ] };
  const scrolledTo = () => vi.mocked(HTMLElement.prototype.scrollIntoView).mock.contexts
    .map((element) => (element as HTMLElement).getAttribute("data-panel-card"));

  it("reads Bot / Conversation ▾, marks other conversations that need a look, and opens the panel at Conversations", async () => {
    const header = document.createElement("div");
    document.body.append(header);
    const headerRoot = createRoot(header);
    try {
      flushSync(() => headerRoot.render(createElement(ChatHeadConversation, { bot: withTasks })));
      const title = header.querySelector("[data-chathead-conversation]")!;
      expect(header.textContent).toBe("/Plan the launch");
      expect(title.getAttribute("title")).toBe("Show Scout's conversations");
      expect(title.querySelector('[role="img"]')!.getAttribute("aria-label")).toBe("Other activity (1)");
      click(title);
      expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "toggleSettings", open: true, section: "overview" });

      render("overview");
      await settle();
      expect(tab()).toBe("bot");
      expect(scrolledTo()).toEqual(["conversations"]);

      vi.mocked(HTMLElement.prototype.scrollIntoView).mockClear();
      click(host.querySelector('[data-panel-tab="computer"]'));
      click(title);
      render("overview");
      await settle();
      expect(tab()).toBe("bot");
      expect(scrolledTo()).toEqual(["conversations"]);
    } finally {
      flushSync(() => headerRoot.unmount());
      header.remove();
    }
  });

  it("draws nothing for a bot without a conversation list, and no dot when the others are quiet", () => {
    const header = document.createElement("div");
    const headerRoot = createRoot(header);
    flushSync(() => headerRoot.render(createElement(ChatHeadConversation, { bot })));
    expect(header.innerHTML).toBe("");
    flushSync(() => headerRoot.render(createElement(ChatHeadConversation, { bot: { ...withTasks, tasks: withTasks.tasks!.map((task) => ({ ...task, unread: false })) } })));
    expect(header.querySelector('[role="img"]')).toBeNull();
    flushSync(() => headerRoot.unmount());
  });
});

describe("Escape in the bot panel", () => {
  const onPage = async () => {
    openBotSettings(fixture.dispatch, "skills");
    render("skills");
    await settle();
    expect(page()).toBe("skills");
  };

  it("goes back from a drill-in page instead of closing the panel, though the panel sits in a dialog", async () => {
    await onPage();
    const back = host.querySelector<HTMLElement>("[data-panel-back]");
    back?.focus();
    const event = press(back, "Escape");
    expect(event.defaultPrevented).toBe(true);
    expect([tab(), page()]).toEqual(["bot", null]);
    expect(dialogCloses).not.toHaveBeenCalled();
    // On a tab, Escape is the dialog's: it closes the panel.
    press(host.querySelector('[data-panel-tab="bot"]'), "Escape");
    expect(dialogCloses).toHaveBeenCalledTimes(1);
  });

  it("closes the ⋯ menu first, on a tab and on a page, and only the next Escape reaches the panel", async () => {
    render(null);
    await settle();
    moreButton()?.focus();
    click(moreButton());
    expect(menu()).not.toBeNull();
    press(moreButton(), "Escape");
    expect(menu()).toBeNull();
    expect(dialogCloses).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(moreButton());

    flushSync(() => root.unmount());
    root = createRoot(host);
    await onPage();
    moreButton()?.focus();
    click(moreButton());
    expect(menu()).not.toBeNull();
    press(moreButton(), "Escape");
    expect(menu()).toBeNull();
    expect(page()).toBe("skills");
    press(moreButton(), "Escape");
    expect([tab(), page()]).toEqual(["bot", null]);
    expect(dialogCloses).not.toHaveBeenCalled();
  });
});

describe("focus around the hero", () => {
  const avatar = () => host.querySelector<HTMLElement>("[data-panel-avatar]");
  const card = () => host.querySelector("[data-panel-avatar-editor]");

  it("moves focus into the avatar editor, and back to the avatar however it closes", async () => {
    render(null);
    await settle();
    avatar()!.focus();
    click(avatar());
    await settle();
    expect(card()).not.toBeNull();
    expect(document.activeElement?.getAttribute("data-avatar-tab")).toBe("bot");

    const event = press(document.activeElement, "Escape");
    expect(event.defaultPrevented).toBe(true);
    expect(card()).toBeNull();
    expect(document.activeElement).toBe(avatar());
    expect(dialogCloses).not.toHaveBeenCalled();

    click(avatar());
    await settle();
    click(host.querySelector("[data-panel-scrim]"));
    expect(card()).toBeNull();
    expect(document.activeElement).toBe(avatar());
    // Focus is back where Escape is heard: the next one is the dialog's.
    press(document.activeElement, "Escape");
    expect(dialogCloses).toHaveBeenCalledTimes(1);
  });

  it.each([["data-panel-rename", "Enter"], ["data-panel-rename", "Escape"], ["data-panel-label", "Enter"], ["data-panel-label", "Escape"]])(
    "gives focus back to the %s button after %s, so the next Escape still works",
    async (attr, key) => {
      render(null);
      await settle();
      click(host.querySelector(`[${attr}]`));
      const input = host.querySelector<HTMLInputElement>(`[${attr}-input]`);
      expect(document.activeElement).toBe(input);
      press(input, key);
      await settle();
      expect(host.querySelector(`[${attr}-input]`)).toBeNull();
      expect(document.activeElement).toBe(host.querySelector(`[${attr}]`));
      expect(dialogCloses).not.toHaveBeenCalled();
      press(document.activeElement, "Escape");
      expect(dialogCloses).toHaveBeenCalledTimes(1);
    },
  );
});
