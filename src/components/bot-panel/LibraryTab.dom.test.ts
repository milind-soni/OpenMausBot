// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { BotLibrary } from "../../../shared/bot-library";
import type { Bot, Message } from "@/state/store";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), opened: [] as string[], skills: [] as unknown[], skillBurger: true }));
vi.mock("@/state/store-select", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store-select")>(),
  useStoreDispatch: () => fixture.dispatch,
}));
vi.mock("./use-memory-doc", () => ({ useMemoryDoc: () => ({ docs: null, error: false }) }));
vi.mock("../bot-settings/SkillsSection", async (importOriginal) => ({
  ...await importOriginal<typeof import("../bot-settings/SkillsSection")>(),
  useManagedSkills: () => ({ skills: fixture.skills, loading: false }),
}));
vi.mock("@/lib/use-feature", () => ({ useFeature: () => fixture.skillBurger }));
vi.mock("@/lib/page-open", () => ({ usePageOpener: () => (url: string) => fixture.opened.push(url) }));

const { LibraryTab, LIBRARY_SHOWN } = await import("./LibraryTab");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const page = (id: string, at: number, url: string, state: "live" | "unpublished" = "live"): Message =>
  ({ id, role: "bot", kind: "text", text: "Published", at, publishedPage: { state, title: `Page ${id}`, url } }) as Message;
const app = (id: string, at: number): Message =>
  ({ id, role: "bot", kind: "app", text: "", at, app: { v: 1, source: { kind: "html" }, title: `App ${id}`, doc: `doc-${id}`, rev: 0 } }) as unknown as Message;
const makeBot = (over: Partial<Bot> = {}): Bot => ({
  id: "scout", threadId: "t1", name: "Scout", title: "", description: "", notifications: true, color: "green", unread: false,
  modelSelection: { instanceId: "x", model: "x" },
  tasks: [
    { threadId: "t1", title: "Launch plan", createdAt: 1 },
    { threadId: "t2", title: "Pricing", createdAt: 2 },
    { threadId: "t3", title: "Old notes", createdAt: 3, archivedAt: 9 },
  ],
  messages: [page("m1", 50, "https://aaaaaaaaaaaaaaaaaaaa.mausbot.page/"), app("m2", 60), page("m3", 70, "https://cccccccccccccccccccc.mausbot.page/", "unpublished")],
  ...over,
}) as Bot;

let library: BotLibrary;
const requests: string[] = [];
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  fixture.dispatch.mockReset();
  fixture.opened.length = 0;
  fixture.skills = [];
  fixture.skillBurger = true;
  requests.length = 0;
  library = {
    pages: [
      { threadId: "t2", messageId: "p2", at: 90, title: "Price sheet", url: "https://bbbbbbbbbbbbbbbbbbbb.mausbot.page/" },
      // Unpublished in the open conversation since the server answered: the loaded message wins.
      { threadId: "t1", messageId: "m3", at: 70, title: "Page m3", url: "https://cccccccccccccccccccc.mausbot.page/" },
      { threadId: "t3", messageId: "p3", at: 10, title: "Old page", url: "https://dddddddddddddddddddd.mausbot.page/" },
      // From a conversation deleted since: the panel no longer knows it.
      { threadId: "t9", messageId: "p9", at: 99, title: "Gone page", url: "https://eeeeeeeeeeeeeeeeeeee.mausbot.page/" },
    ],
    apps: [{ threadId: "t2", messageId: "a2", at: 80, title: "Quote calculator" }, { threadId: "t1", messageId: "m2", at: 60, title: "App m2" }],
    files: [{ threadId: "t3", messageId: "f3", at: 5, attachments: [{ path: "/work/report.pdf", kind: "file", name: "report.pdf" }], links: ["/work/notes.md"] }],
  };
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = new URL(input, "http://x");
    requests.push(url.pathname);
    const body = url.pathname === "/api/bots/scout/library" ? library : { error: "not here" };
    return new Response(JSON.stringify(body), { status: url.pathname === "/api/bots/scout/library" ? 200 : 404, headers: { "content-type": "application/json" } });
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const settle = () => act(async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });
const rows = (kind: string) => [...host.querySelectorAll<HTMLElement>(`[data-panel-row="${kind}"]`)];
const render = async (bot: Bot) => {
  await act(async () => root.render(createElement(LibraryTab, { bot, onOpen: () => {} })));
  await settle();
};

it("lists what the bot made in every conversation, newest first, each with the conversation it came from", async () => {
  await render(makeBot());
  expect(requests).toContain("/api/bots/scout/library");
  expect(rows("page").map((row) => row.textContent)).toEqual(["Price sheetPricing", "Page m1Launch plan", "Old pageOld notes"]);
  expect(rows("app").map((row) => row.textContent)).toEqual(["Quote calculatorPricing", "App m2Launch plan"]);
  const files = host.querySelector('[data-panel-card="files"]')!.textContent;
  expect(files).toContain("report.pdf");
  expect(files).toContain("notes.md");
  expect(files).toContain("Old notes");
  expect(host.textContent).not.toContain("Gone page");
  expect(host.textContent).not.toContain("From this conversation");
  expect(host.querySelector('[data-panel-page="memory"]')).not.toBeNull();
});

it("opens a page by its link, and an app from another conversation at its message there", async () => {
  await render(makeBot());
  await act(async () => rows("page")[0]!.querySelector("button")?.click() ?? rows("page")[0]!.click());
  expect(fixture.opened).toEqual(["https://bbbbbbbbbbbbbbbbbbbb.mausbot.page/"]);
  await act(async () => (rows("app")[0]!.querySelector("button") ?? rows("app")[0]!).click());
  expect(fixture.dispatch).toHaveBeenCalledWith({ type: "switchTask", botId: "scout", threadId: "t2" });
  expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "focusMessage", threadId: "t2", messageId: "a2" });
  fixture.dispatch.mockClear();
  await act(async () => (rows("app")[1]!.querySelector("button") ?? rows("app")[1]!).click());
  expect(fixture.dispatch.mock.calls).toEqual([[{ type: "focusMessage", threadId: "t1", messageId: "m2" }]]);
});

it("names no conversation while the bot has only one, and shows what is loaded when the server cannot answer", async () => {
  library = { pages: [], apps: [], files: [] };
  await render(makeBot({ tasks: [{ threadId: "t1", title: "Launch plan", createdAt: 1 }] }));
  expect(rows("page").map((row) => row.textContent)).toEqual(["Page m1https://aaaaaaaaaaaaaaaaaaaa.mausbot.page/"]);
  expect(rows("app").map((row) => row.textContent)).toEqual(["App m2"]);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
  await render(makeBot({ id: "other" }));
  expect(rows("app").map((row) => row.textContent)).toEqual(["App m2Launch plan"]);
});

it("shows the newest few of a long group, then Show all opens the rest in place", async () => {
  library = { pages: [], files: [], apps: Array.from({ length: 30 }, (_, index) => ({ threadId: "t2", messageId: `a${index}`, at: 1_000 - index, title: `App ${index}` })) };
  await render(makeBot({ messages: [] }));
  expect(rows("app")).toHaveLength(LIBRARY_SHOWN);
  expect(rows("app")[0]!.textContent).toContain("App 0");
  const more = host.querySelector<HTMLButtonElement>('[data-library-more="apps"]')!;
  expect(more.textContent).toBe("Show all");
  await act(async () => more.click());
  expect(rows("app")).toHaveLength(30);
  expect(host.querySelector('[data-library-more="apps"]')).toBeNull();
  expect(host.querySelector('[data-library-more="pages"]')).toBeNull();
});

it("counts a saved Skill Burger among the bot's skills only while Skill Burger is on", async () => {
  fixture.skills = [
    { name: "weekly-report", source: "skill-burger:scout", enabled: true },
    { name: "tidy-notes", source: "conversation", enabled: true },
  ];
  await render(makeBot());
  expect(host.querySelector('[data-panel-page="skills"]')!.textContent).toContain("2");
  fixture.skillBurger = false;
  await render(makeBot());
  expect(host.querySelector('[data-panel-page="skills"]')!.textContent).toContain("1");
  expect(host.querySelector('[data-panel-page="skills"]')!.textContent).not.toContain("2");
});
