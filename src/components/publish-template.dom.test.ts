// @vitest-environment happy-dom
// A bot's Publish, from the chat's ⋯ and from the sidebar row's menu: each choice makes the bot's template at once and
// runs on it, with no message to the bot.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import type { TemplateCard } from "../../shared/share-card";

const fixture = vi.hoisted(() => ({
  dispatch: vi.fn(),
  advanced: false,
  bots: [] as Bot[],
  api: vi.fn(async (_path: string, _init?: RequestInit): Promise<unknown> => ({})),
}));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    api: (path: string, init?: RequestInit) => fixture.api(path, init),
    useStore: () => ({ state: { ...original.initialState, bots: fixture.bots, config: { profile: { name: "Sam Rivera" } } }, dispatch: fixture.dispatch }),
  };
});
vi.mock("@/lib/session", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/session")>(),
  readSessionState: async () => ({ kind: "loopback" }),
}));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, readAdvancedMode: () => fixture.advanced, setAdvancedMode: vi.fn() }));
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => fixture.advanced }));
vi.mock("./Avatar", () => ({ BotAvatar: () => null, MausAvatar: () => null }));

const { ChatMoreMenu } = await import("./ChatMoreMenu");
const { BotContextMenu } = await import("./SidebarBotMenu");
const { PublishTemplateHost } = await import("./publish-template");

const bot: Bot = {
  id: "scout", threadId: "thread-scout", name: "Scout", title: "", description: "", soul: "",
  notifications: true, color: "green", unread: false, messages: [{ id: "hi", role: "bot", kind: "text", text: "Hello", at: 1 }],
  modelSelection: { instanceId: "claude", model: "claude-opus-5-5" },
};
const card: TemplateCard = {
  id: "tpl1", scope: "bot", name: "Scout", tagline: "Finds things.", avatars: [{ key: "scout", name: "Scout", color: "green" }],
  counts: { bots: 1, skills: 2, routines: 0, apps: 0 }, redacted: 0, skipped: [], status: "draft", scrubbed: { paths: 1, emails: 0, phones: 0, names: 0 },
};
const PR = "https://github.com/milind-soni/openmausbot-teams/pull/12";

let host: HTMLDivElement;
let root: Root;
const settle = async () => {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const click = (element: Element | null | undefined) => {
  if (!element) throw new Error("nothing to click");
  flushSync(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
};
const labels = (sheet: Element | null) => [...(sheet?.querySelectorAll('[role="menuitem"]') ?? [])].map((row) => row.textContent?.trim());
const calls = () => fixture.api.mock.calls.map(([path, init]) => [path, init?.body ?? null]);
const sent = () => fixture.dispatch.mock.calls.filter(([action]) => (action as { type: string }).type === "send");

beforeEach(() => {
  fixture.dispatch.mockReset();
  fixture.api.mockReset();
  fixture.advanced = false;
  fixture.bots = [bot];
  document.documentElement.dataset.reducedMotion = "true";
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  // The dialog asked for outlives the root; Close clears it before the next test.
  const close = [...document.querySelectorAll("footer button")].find((button) => button.textContent === "Close");
  if (close) click(close);
  flushSync(() => root.unmount());
  document.body.innerHTML = "";
  delete (window as { ogb?: unknown }).ogb;
});

describe("Publish in the chat's ⋯", () => {
  const openMenu = (shown: Bot) => {
    flushSync(() => root.render(createElement("div", null, createElement(ChatMoreMenu, { bot: shown }), createElement(PublishTemplateHost))));
    click(host.querySelector('[data-testid="chat-more"]')?.closest("button"));
    return document.querySelector("[data-sidebar-popover-menu]") ?? document.querySelector('[role="menu"]');
  };

  it("lists the publish choices in a submenu, and Publish to community makes the card and publishes it with no message", async () => {
    fixture.api.mockImplementation(async (path: string) => path === "/api/share/export" ? card
      : { ...card, status: "published", link: "https://github.com/milind-soni/openmausbot-teams/tree/abc/teams/scout", prUrl: PR, publishedBy: "Sam Rivera" });
    const menu = openMenu(bot);
    const publish = menu?.querySelector('[data-menu-key="publish"]');
    expect(publish?.getAttribute("aria-haspopup")).toBe("menu");
    expect(publish?.textContent).toContain("Publish");
    expect(menu?.querySelector('[data-menu-key="as-template"]')).toBeNull();
    click(publish);
    const submenu = document.querySelector("[data-sidebar-popover-submenu]");
    expect(labels(submenu)).toEqual(["Publish to community", "Your GitHub repo…", "Download"]);
    click(submenu!.querySelector('[data-menu-key="publish:community"]'));
    await vi.waitFor(() => expect(document.body.textContent).toContain("View pull request"));
    expect(calls()).toEqual([
      ["/api/share/export", JSON.stringify({ botId: "scout" })],
      ["/api/share/tpl1/publish", JSON.stringify({ author: "Sam Rivera" })],
    ]);
    expect(document.querySelector("[data-publish-bot=scout]")).not.toBeNull();
    expect(document.body.textContent).toContain("Publish Scout");
    expect(document.body.textContent).toContain("Published by Sam Rivera");
    expect(document.body.textContent).toContain("We removed 1 local path before publishing");
    expect(sent()).toEqual([]);
  });

  it("offers Save folder… on the desktop, and doesn't publish a template holding a key", async () => {
    (window as { ogb?: unknown }).ogb = { pickFolder: vi.fn(async () => null) };
    fixture.api.mockResolvedValue({ ...card, secret: true });
    const menu = openMenu(bot);
    click(menu?.querySelector('[data-menu-key="publish"]'));
    const submenu = document.querySelector("[data-sidebar-popover-submenu]");
    expect(labels(submenu)).toEqual(["Publish to community", "Your GitHub repo…", "Save folder…", "Download"]);
    click(submenu!.querySelector('[data-menu-key="publish:community"]'));
    await vi.waitFor(() => expect(document.querySelector("[data-template-secret]")).not.toBeNull());
    await settle();
    expect(calls().map(([path]) => path)).toEqual(["/api/share/export"]);
    expect(sent()).toEqual([]);
  });

  it("doesn't publish where nobody is signed in, and says to sign in", async () => {
    fixture.api.mockResolvedValue({ ...card, fallback: "sign_in" });
    const menu = openMenu(bot);
    click(menu?.querySelector('[data-menu-key="publish"]'));
    click(document.querySelector('[data-sidebar-popover-submenu] [data-menu-key="publish:community"]'));
    await vi.waitFor(() => expect(document.body.textContent).toContain("Sign in to MausBot to publish"));
    await settle();
    expect(calls().map(([path]) => path)).toEqual(["/api/share/export"]);
  });

  it("says why the template couldn't be made, and Try again makes it and runs the choice", async () => {
    fixture.api.mockRejectedValueOnce(new Error("That bot no longer exists.")).mockResolvedValueOnce(card).mockResolvedValue({ ...card, status: "published", link: "x", prUrl: PR });
    const menu = openMenu(bot);
    click(menu?.querySelector('[data-menu-key="publish"]'));
    click(document.querySelector('[data-sidebar-popover-submenu] [data-menu-key="publish:community"]'));
    await vi.waitFor(() => expect(document.body.textContent).toContain("That bot no longer exists."));
    click([...document.querySelectorAll("button")].find((button) => button.textContent === "Try again"));
    await vi.waitFor(() => expect(calls().map(([path]) => path)).toEqual(["/api/share/export", "/api/share/export", "/api/share/tpl1/publish"]));
  });

  it("leaves Publish out for a bot this person may only view", () => {
    const menu = openMenu({ ...bot, yourAccess: "view" });
    expect(menu?.querySelector('[data-menu-key="publish"]')).toBeNull();
  });
});

describe("Publish in the sidebar row's menu", () => {
  const openRowMenu = () => {
    flushSync(() => root.render(createElement("div", null,
      createElement(BotContextMenu, { menu: { botId: bot.id, x: 10, y: 10 }, onClose: vi.fn(), onArchive: vi.fn(), onDelete: vi.fn(), onMoveToSection: vi.fn(), onNewFolder: vi.fn(), onNewTaskFolder: vi.fn() }),
      createElement(PublishTemplateHost))));
    click(document.querySelector("[data-bot-menu-publish]"));
    return document.querySelector('[data-bot-menu-flyout="publish"]');
  };

  for (const advanced of [false, true]) {
    it(`opens the same choices in ${advanced ? "Advanced" : "Simple"} mode, and Download makes the card and downloads it`, async () => {
      fixture.advanced = advanced;
      fixture.api.mockResolvedValue(card);
      const download = vi.fn(async () => new Response("zip"));
      vi.stubGlobal("fetch", download);
      const flyout = openRowMenu();
      expect(labels(flyout)).toEqual(["Publish to community", "Your GitHub repo…", "Download"]);
      click([...flyout!.querySelectorAll("button")].find((button) => button.textContent === "Download"));
      await vi.waitFor(() => expect(document.body.textContent).toContain("Downloaded Scout.zip"));
      expect(calls()).toEqual([["/api/share/export", JSON.stringify({ botId: "scout" })]]);
      expect(String((download.mock.calls[0] as unknown[])[0])).toContain("/api/share/tpl1/download");
      expect(sent()).toEqual([]);
      vi.unstubAllGlobals();
    });
  }
});
