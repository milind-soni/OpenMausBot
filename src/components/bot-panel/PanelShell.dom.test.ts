// @vitest-environment happy-dom
// The Simple bot panel in a real DOM, where effects run and focus moves: named links, Escape and focus, and the chat
// header's pill that opens it.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, BotSettingsSection } from "@/state/store";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), settingsOpen: false }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({ state: { ...original.initialState, settingsOpen: fixture.settingsOpen }, dispatch: fixture.dispatch, flushBotPatches: () => Promise.resolve(null) }),
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
  createElement("div", { [`data-stub-${name}`]: true, "data-editing-instructions": props.editingInstructions === true ? "true" : undefined });
vi.mock("./DetailsTab", () => ({ DetailsTab: stub("details") }));
vi.mock("./LibraryTab", () => ({ LibraryTab: stub("library") }));
vi.mock("./ComputerTab", () => ({ ComputerTab: stub("computer") }));
vi.mock("./pages", () => ({
  PageBody: ({ page, editingInstructions }: { page: string; editingInstructions?: boolean }) =>
    createElement("div", { "data-stub-page": page, "data-editing-instructions": editingInstructions === true ? "true" : undefined },
      createElement("section", { "data-panel-card": "approval" })),
  pageSurfaceCls: "",
}));

const { BotPanel } = await import("./PanelShell");
const { openBotSettings } = await import("./panel-link");
const { ChatHeadPill } = await import("../ChatHeadPill");

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
const moreButton = () => host.querySelector("[data-panel-share]")?.closest("button") ?? null;
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

    click(host.querySelector('[data-panel-tab="details"]'));
    expect(tab()).toBe("details");

    flushSync(() => openBotSettings(fixture.dispatch, "access"));
    render("access");
    await settle();
    expect(tab()).toBe("computer");
  });

  it("opens Bot settings with the Instructions editor for a soul link, and closes it when the panel moves on", async () => {
    openBotSettings(fixture.dispatch, "soul");
    render("soul");
    await settle();
    expect(page()).toBe("settings");
    expect(host.querySelector('[data-stub-page="settings"]')?.getAttribute("data-editing-instructions")).toBe("true");
    click(host.querySelector("[data-panel-back]"));
    expect([tab(), page()]).toEqual(["details", null]);
    click(host.querySelector("[data-panel-gear]"));
    expect(host.querySelector('[data-stub-page="settings"]')?.getAttribute("data-editing-instructions")).toBeNull();
  });

  it("scrolls a permissions link to Before it acts on the Bot settings page", async () => {
    const scrolled = vi.mocked(HTMLElement.prototype.scrollIntoView);
    openBotSettings(fixture.dispatch, "permissions");
    render("permissions");
    await settle();
    expect(page()).toBe("settings");
    expect(scrolled.mock.contexts).toContain(host.querySelector('[data-panel-card="approval"]'));
  });

  it("lands usage, history, voice and visibility links on the Details tab, with no Advanced page", async () => {
    for (const section of ["usage", "history", "voice", "visibility", "overview"] as const) {
      openBotSettings(fixture.dispatch, section);
      render(section);
      await settle();
      expect([tab(), page()], section).toEqual(["details", null]);
    }
  });
});

describe("the panel's tabs", () => {
  it("are Details, Library and Computer, opening on Details, each drawing its own tab", async () => {
    render(null);
    await settle();
    expect([...host.querySelectorAll('[role="tab"]')].map((element) => [element.getAttribute("data-panel-tab"), element.textContent]))
      .toEqual([["details", "Details"], ["library", "Library"], ["computer", "Computer"]]);
    expect(tab()).toBe("details");
    const strip = host.querySelector('[role="tablist"]')!.className.split(" ");
    expect(strip).toEqual(expect.arrayContaining(["sticky", "top-0", "bg-app", "gap-0.5"]));
    expect(host.querySelector('[role="tab"]')!.className.split(" ")).toEqual(expect.arrayContaining(["h-[26px]", "text-[13px]", "bg-ink/[0.07]"]));
    for (const id of ["library", "computer", "details"]) {
      click(host.querySelector(`[data-panel-tab="${id}"]`));
      expect(tab()).toBe(id);
      expect(host.querySelector(`[data-stub-${id}]`), id).not.toBeNull();
    }
  });
});

describe("the panel's top", () => {
  it("has a round Share button that copies or downloads the conversation, a gear for Bot settings, and Close", async () => {
    render(null);
    await settle();
    const top = [...host.querySelectorAll("button")].slice(0, 3);
    expect(top.map((button) => button.getAttribute("aria-label") ?? button.getAttribute("title"))).toEqual(["Share", "Bot settings", "Close settings"]);
    for (const button of [moreButton()!, top[1]!, top[2]!]) expect(button.querySelector("span, svg")).not.toBeNull();
    click(moreButton());
    expect([...menu()!.querySelectorAll("[data-menu-key]")].map((row) => row.getAttribute("data-menu-key"))).toEqual(["copy", "download"]);
    press(moreButton(), "Escape");
    click(top[2]!);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("opens Bot settings from the gear on any tab, with Back to Details", async () => {
    render(null);
    await settle();
    click(host.querySelector('[data-panel-tab="computer"]'));
    click(host.querySelector("[data-panel-gear]"));
    expect(page()).toBe("settings");
    expect(host.querySelector("[data-panel-gear]")!.getAttribute("aria-current")).toBe("page");
    expect(host.querySelector("[data-panel-back]")!.textContent).toBe("Details");
    click(host.querySelector("[data-panel-back]"));
    expect([tab(), page()]).toEqual(["details", null]);
  });

  it("puts the name right under the avatar, with no call button beside it", async () => {
    render(null);
    await settle();
    const row = host.querySelector("[data-panel-name-row]")!;
    expect(row.querySelector("[data-panel-rename]")!.textContent).toBe("Scout");
    expect(host.querySelector("[data-panel-avatar]")!.nextElementSibling).toBe(row);
    expect(host.querySelector("[data-call-button]")).toBeNull();
  });
});

describe("the chat header's pill", () => {
  const withTasks: Bot = { ...bot, tasks: [
    { threadId: "thread-scout", title: "Plan the launch", createdAt: 1 },
    { threadId: "other", title: "Older notes", createdAt: 0, unread: true },
  ] };
  const pill = (props: Partial<Parameters<typeof ChatHeadPill>[0]> = {}) => {
    const header = document.createElement("div");
    document.body.append(header);
    const headerRoot = createRoot(header);
    const onToggle = vi.fn();
    flushSync(() => headerRoot.render(createElement(ChatHeadPill, { bot: withTasks, avatar: { state: "idle" }, privacy: null, onToggle, ...props })));
    return { header, onToggle, done: () => { flushSync(() => headerRoot.unmount()); header.remove(); } };
  };

  it("names the bot, opens the bot panel, and dots another conversation that needs a look", () => {
    const { header, onToggle, done } = pill();
    try {
      const button = header.querySelector<HTMLButtonElement>("[data-chathead-pill]")!;
      expect(button.textContent).toBe("Scout");
      expect(button.getAttribute("aria-label")).toBe("Open Scout's profile");
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(button.hasAttribute("aria-controls")).toBe(false);
      expect(header.querySelector("[data-chathead-chevron]")).not.toBeNull();
      expect(header.querySelector("[data-chathead-elsewhere]")!.getAttribute("aria-label")).toBe("Other activity (1)");
      click(button);
      expect(onToggle).toHaveBeenCalledOnce();
    } finally {
      done();
    }
  });

  it("says the panel is open and points at it, then hides the hover chevron", () => {
    fixture.settingsOpen = true;
    const { header, done } = pill();
    try {
      const button = header.querySelector<HTMLButtonElement>("[data-chathead-pill]")!;
      expect(button.getAttribute("aria-expanded")).toBe("true");
      expect(button.getAttribute("aria-controls")).toBe("bot-panel");
      expect(header.querySelector("[data-chathead-chevron]")).toBeNull();
    } finally {
      fixture.settingsOpen = false;
      done();
    }
  });

  it("names the conversation on screen when it is not the bot's main one", () => {
    const { header, done } = pill({ bot: { ...withTasks, mainThreadId: "other" } });
    try {
      const button = header.querySelector<HTMLButtonElement>("[data-chathead-pill]")!;
      expect(header.querySelector("[data-chathead-conversation]")!.textContent).toBe("Plan the launch");
      expect(button.getAttribute("aria-label")).toBe("Open Scout's profile, Plan the launch");
      expect(header.querySelector("[data-chathead-chevron]")).toBeNull();
    } finally {
      done();
    }
    const untitled = pill({ bot: { ...withTasks, mainThreadId: "other", tasks: [{ ...withTasks.tasks![0]!, title: "New thread" }, withTasks.tasks![1]!] } });
    try {
      expect(untitled.header.querySelector("[data-chathead-conversation]")!.textContent).toBe("New conversation");
    } finally {
      untitled.done();
    }
  });

  it("has no dot when the other conversations are quiet, and says who can read a team chat", () => {
    const quiet = pill({ bot: { ...withTasks, tasks: withTasks.tasks!.map((task) => ({ ...task, unread: false })) }, privacy: { kind: "private" } });
    try {
      expect(quiet.header.querySelector("[data-chathead-elsewhere]")).toBeNull();
      expect(quiet.header.querySelector('[data-chathead-privacy="private"]')!.textContent).toBe("Private · only you");
    } finally {
      quiet.done();
    }
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
    expect([tab(), page()]).toEqual(["library", null]);
    expect(dialogCloses).not.toHaveBeenCalled();
    // On a tab, Escape is the dialog's: it closes the panel.
    press(host.querySelector('[data-panel-tab="library"]'), "Escape");
    expect(dialogCloses).toHaveBeenCalledTimes(1);
  });

  it("closes the Share menu first, on a tab and on a page, and only the next Escape reaches the panel", async () => {
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
    expect([tab(), page()]).toEqual(["library", null]);
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
