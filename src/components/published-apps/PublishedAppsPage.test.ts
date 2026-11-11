// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PublishedApp } from "../../../shared/published-apps";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = vi.hoisted(() => ({
  state: {
    bots: [{ id: "mira", name: "Mira", threadId: "main", tasks: [{ threadId: "main" }, { threadId: "ada-chat" }] }],
    groups: [{ id: "launch", threadId: "room-thread", tasks: [] }],
  },
  dispatch: vi.fn(),
  api: vi.fn(),
  opened: [] as string[],
  previews: [] as unknown[],
}));
class FakeApiError extends Error {
  status: number; body?: Record<string, unknown>;
  constructor(message: string, status: number, body?: Record<string, unknown>) { super(message); this.status = status; this.body = body; }
}
vi.mock("@/state/store", () => ({ useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }) }));
vi.mock("@/state/api", () => ({ api: fixture.api, ApiError: FakeApiError }));
vi.mock("@/lib/app-links", () => ({ openExternalLink: async (url: string) => { fixture.opened.push(url); } }));
vi.mock("@/lib/app-preview", () => ({ openAppPreview: (preview: unknown) => { fixture.previews.push(preview); }, closeAppPreview: () => {}, useAppPreview: () => null }));

const { chatFor, PublishedAppsPage } = await import("./PublishedAppsPage");

const NOW = Date.parse("2026-11-11T12:00:00Z");
const SITE: PublishedApp = {
  id: "netlify-mira-s1", source: "netlify", title: "Bakery order page", url: "https://bright-bakery.netlify.app/", bot: { id: "mira", name: "Mira" }, threadId: "ada-chat",
  publishedAt: NOW - 2 * 3_600_000, access: "public", manageUrl: "https://app.netlify.com/projects/bright-bakery", canDelete: true,
};
const PAGE: PublishedApp = {
  id: "page-abcdefghijklmnopqrstuvwxyz", source: "page", title: "Sales report", url: "https://abcdefghijklmnopqrstuvwxyz.mausbot.page/", bot: { id: "mira", name: "Mira" }, threadId: "main",
  publishedAt: NOW - 3 * 86_400_000, access: "link", canDelete: true,
};
const TEAM_ONLY: PublishedApp = { ...SITE, id: "netlify-mira-s2", title: "Staff rota", url: "https://staff-rota.netlify.app/", access: "netlify-team", canDelete: false, threadId: "room-thread" };
const ORPHAN: PublishedApp = { ...PAGE, id: "page-orphan00000000000000000", title: "Old page", bot: { id: "gone", name: "" }, threadId: "gone-thread" };

let root: Root;
let host: HTMLElement;
let apps: PublishedApp[];
let deleteAnswer: () => Promise<unknown>;
const deletes: string[] = [];

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  apps = [SITE, PAGE, TEAM_ONLY, ORPHAN];
  deleteAnswer = async () => ({ ok: true });
  deletes.length = 0;
  fixture.opened.length = 0;
  fixture.previews.length = 0;
  fixture.dispatch.mockReset();
  fixture.api.mockReset();
  fixture.api.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
    if (path === "/api/published-apps") return { apps };
    if (path === "/api/published-apps/delete" && init?.method === "POST") {
      const { id } = JSON.parse(init.body!) as { id: string };
      deletes.push(id);
      const answer = await deleteAnswer();
      apps = apps.filter((app) => app.id !== id);
      return answer;
    }
    if (path.startsWith("/api/published-apps/framing")) return { framing: "allowed" };
    throw new Error(`unexpected ${path}`);
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

const show = () => act(async () => root.render(createElement(PublishedAppsPage)));
const card = (id: string) => host.querySelector<HTMLElement>(`[data-published-app="${id}"]`)!;
const button = (within: ParentNode, name: string) => [...within.querySelectorAll("button")].find((one) => (one.getAttribute("aria-label") ?? one.textContent) === name)!;
const dialog = () => document.body.querySelector<HTMLElement>('[role="alertdialog"]');

describe("the Published apps page", () => {
  it("says what it is for and how to get the first app when nothing is published", async () => {
    apps = [];
    await show();
    expect(host.querySelector("h1")?.textContent).toBe("Published apps");
    expect(host.textContent).toContain("Nothing published yet");
    expect(host.textContent).toContain("Ask a bot to build a site or app and publish it.");
    expect(host.querySelector("[data-published-app]")).toBeNull();
  });

  it("shows one card for each app from both sources, with its name, bot, when it was published and who can see it", async () => {
    await show();
    expect([...host.querySelectorAll("[data-published-app]")].map((one) => `${one.getAttribute("data-source")}:${one.querySelector("h2")?.textContent}`))
      .toEqual(["netlify:Bakery order page", "page:Sales report", "netlify:Staff rota", "page:Old page"]);
    expect(card(SITE.id).textContent).toContain("Mira · 2 hr ago");
    expect(card(SITE.id).querySelector("[data-app-access]")?.textContent).toBe("Public");
    expect(card(TEAM_ONLY.id).querySelector("[data-app-access]")?.textContent).toBe("Only your Netlify team");
    expect(card(PAGE.id).querySelector("[data-app-access]")?.textContent).toBe("Anyone with the link");
    expect(card(PAGE.id).textContent).toContain("Mira · 3 days ago");
  });

  it("offers Manage on Netlify only for a Netlify site, Delete only where the viewer may, and no chat for a bot that is gone", async () => {
    await show();
    const labels = (id: string) => [...card(id).querySelectorAll("button")].map((one) => one.getAttribute("aria-label") ?? one.textContent);
    expect(labels(SITE.id)).toEqual(["Preview Bakery order page", "Preview", "Open", "Copy link", "Ask Mira to change it", "Manage on Netlify", "Delete Bakery order page"]);
    expect(labels(PAGE.id)).toEqual(["Preview Sales report", "Preview", "Open", "Copy link", "Ask Mira to change it", "Delete Sales report"]);
    expect(labels(TEAM_ONLY.id)).toEqual(["Preview Staff rota", "Preview", "Open", "Copy link", "Ask Mira to change it", "Manage on Netlify"]);
    expect(labels(ORPHAN.id)).toEqual(["Preview Old page", "Preview", "Open", "Copy link", "Delete Old page"]);
  });

  it("opens the app and its Netlify page outside the app, and copies its link", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    await show();
    act(() => button(card(SITE.id), "Open").click());
    act(() => button(card(SITE.id), "Manage on Netlify").click());
    expect(fixture.opened).toEqual([SITE.url, SITE.manageUrl]);
    await act(async () => button(card(SITE.id), "Copy link").click());
    expect(writeText).toHaveBeenCalledWith(SITE.url);
    vi.unstubAllGlobals();
  });

  it("opens the bot's conversation about the app from Ask, and the room for one published in a room", async () => {
    await show();
    act(() => button(card(SITE.id), "Ask Mira to change it").click());
    act(() => button(card(TEAM_ONLY.id), "Ask Mira to change it").click());
    expect(fixture.dispatch.mock.calls.map(([action]) => action)).toEqual([{ type: "switchTask", botId: "mira", threadId: "ada-chat" }, { type: "select", id: "launch" }]);
    expect(chatFor({ ...SITE, threadId: undefined }, fixture.state as never)).toEqual({ type: "select", id: "mira" });
    expect(chatFor({ ...SITE, threadId: "someone-elses" }, fixture.state as never)).toEqual({ type: "select", id: "mira" });
    expect(chatFor(ORPHAN, fixture.state as never)).toBeNull();
  });

  it("opens the preview beside that bot's conversation, in place of any other side panel", async () => {
    await show();
    act(() => button(card(SITE.id), "Preview").click());
    expect(fixture.dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "switchTask", botId: "mira", threadId: "ada-chat" },
      { type: "toggleComputer", open: false }, { type: "toggleSettings", open: false }, { type: "toggleInspector", open: false }, { type: "toggleActivity", open: false },
    ]);
    expect(fixture.previews).toEqual([{ url: SITE.url, title: "Bakery order page" }]);
    act(() => button(card(TEAM_ONLY.id), "Preview Staff rota").click());
    expect(fixture.previews[1]).toEqual({ url: TEAM_ONLY.url, title: "Staff rota", loginOnly: true });
    fixture.dispatch.mockReset();
    act(() => button(card(ORPHAN.id), "Preview").click());
    expect(fixture.dispatch.mock.calls[0]![0]).toEqual({ type: "showChat" });
  });

  it("deletes only after a confirmation that names the app and says the link stops working for everyone for good", async () => {
    await show();
    act(() => button(card(SITE.id), "Delete Bakery order page").click());
    expect(dialog()?.textContent).toContain("Delete “Bakery order page”?");
    expect(dialog()?.textContent).toContain("Its link will stop working for everyone. This can't be undone.");
    expect(document.activeElement?.textContent).toBe("Cancel");
    act(() => button(dialog()!, "Cancel").click());
    expect(dialog()).toBeNull();
    expect(deletes).toEqual([]);

    act(() => button(card(SITE.id), "Delete Bakery order page").click());
    await act(async () => button(dialog()!, "Delete").click());
    expect(deletes).toEqual([SITE.id]);
    expect(dialog()).toBeNull();
    expect(host.querySelector(`[data-published-app="${SITE.id}"]`)).toBeNull();
    expect(host.querySelectorAll("[data-published-app]")).toHaveLength(3);
  });

  it("says why a Netlify site could not be deleted from here and offers Manage on Netlify, keeping the card", async () => {
    deleteAnswer = async () => { throw new FakeApiError("No saved Netlify token", 409, { error: "No saved Netlify token", code: "no_token", manageUrl: SITE.manageUrl }); };
    await show();
    act(() => button(card(SITE.id), "Delete Bakery order page").click());
    await act(async () => button(dialog()!, "Delete").click());
    const alert = card(SITE.id).querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("This app can't be deleted from here: there is no saved Netlify token to use. Delete it on Netlify instead.");
    act(() => button(alert, "Manage on Netlify").click());
    expect(fixture.opened).toEqual([SITE.manageUrl]);
    expect(host.querySelectorAll("[data-published-app]")).toHaveLength(4);
  });

  it("never offers a Manage link the list did not give, and says plainly when a delete is refused or fails", async () => {
    await show();
    for (const [code, text] of [["token_refused", "Netlify refused the saved token"], ["forbidden", "This app isn't yours to delete."], ["failed", "This app couldn't be deleted. Try again."], ["surprise", "This app couldn't be deleted. Try again."]] as const) {
      deleteAnswer = async () => { throw new FakeApiError("x", 409, { code, manageUrl: "https://evil.test/login" }); };
      act(() => button(card(SITE.id), "Delete Bakery order page").click());
      await act(async () => button(dialog()!, "Delete").click());
      const alert = card(SITE.id).querySelector('[role="alert"]')!;
      expect(alert.textContent, code).toContain(text);
      expect(alert.querySelector("button"), code).toBeNull();
    }
  });

  it("drops a card whose app was already gone", async () => {
    deleteAnswer = async () => { apps = apps.filter((app) => app.id !== PAGE.id); throw new FakeApiError("No such published app.", 404, { code: "gone" }); };
    await show();
    act(() => button(card(PAGE.id), "Delete Sales report").click());
    await act(async () => button(dialog()!, "Delete").click());
    expect(host.querySelector(`[data-published-app="${PAGE.id}"]`)).toBeNull();
  });

  it("says the list could not be loaded and loads it on Try again", async () => {
    fixture.api.mockRejectedValueOnce(new Error("offline"));
    await show();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Your published apps couldn't be loaded.");
    await act(async () => button(host, "Try again").click());
    expect(host.querySelectorAll("[data-published-app]")).toHaveLength(4);
  });

  it("goes back to the chat from the header's Back", async () => {
    await show();
    act(() => button(host, "Back").click());
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "showChat" });
  });
});
