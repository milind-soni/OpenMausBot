// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  const state = { ...original.initialState, config: { ...original.initialState.config, team: { id: "acme", name: "Acme" } },
    bots: [{ id: "scout", name: "Scout", threadId: "t1", tasks: [] }] };
  return { ...original, useStore: () => ({ state, dispatch: vi.fn() }) };
});

const { ConversationShareDialogs } = await import("./ConversationShareDialogs");
const { closeConversationDialog, openConversationDialog, savesToTeamMemory, shareChoices } = await import("./conversation-share");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let sent: Array<{ method: string; path: string; body: unknown }> = [];
let answer: (method: string, path: string) => Response;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  sent = [];
  answer = (method) => (method === "GET" ? reply(200, { shared: null, people: [{ email: "ana@acme.test", name: "Ana" }, { email: "marta@acme.test", name: "Marta" }] }) : reply(200, { shared: "team" }));
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = new URL(input, "http://x").pathname;
    sent.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return answer(method, path);
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => closeConversationDialog());
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const settle = () => act(async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });
const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find((each) => each.textContent === label)!;
async function show(next: Parameters<typeof openConversationDialog>[0]) {
  await act(async () => root.render(createElement(ConversationShareDialogs)));
  await act(async () => openConversationDialog(next));
  await settle();
}

describe("which actions a conversation offers", () => {
  it("shares a private one either way, widens one shared with one person, and nothing else", () => {
    const bot = {};
    expect(shareChoices(bot, { private: true }, true)).toEqual({ team: true, person: true });
    expect(shareChoices(bot, { shared: true, sharedWith: { name: "Marta", byYou: true } }, true)).toEqual({ team: true, person: false });
    expect(shareChoices(bot, { shared: true, sharedWith: { name: "Rui" } }, true)).toEqual({ team: false, person: false });
    expect(shareChoices(bot, { shared: true }, true)).toEqual({ team: false, person: false });
    expect(shareChoices(bot, {}, true), "a team conversation").toEqual({ team: false, person: false });
    expect(shareChoices(bot, { private: true, sharedChat: true }, true)).toEqual({ team: false, person: false });
    expect(shareChoices({ defaultBot: { person: "rui@acme.test" } }, { private: true }, true), "their own MausBot").toEqual({ team: false, person: false });
    expect(shareChoices(bot, { private: true }, false), "off a team").toEqual({ team: false, person: false });
  });

  it("saves to team memory for a team bot the person can chat with, never their own MausBot", () => {
    expect(savesToTeamMemory({ yourAccess: "chat" }, true)).toBe(true);
    expect(savesToTeamMemory({ yourAccess: "view" }, true)).toBe(false);
    expect(savesToTeamMemory({ defaultBot: { person: "rui@acme.test" } }, true)).toBe(false);
    expect(savesToTeamMemory({ yourAccess: "chat" }, false)).toBe(false);
  });
});

describe("the confirm step", () => {
  it("says who will read the whole conversation when it goes to the team, and that it can't be made private again", async () => {
    await show({ kind: "team", botId: "scout", threadId: "t9" });
    expect(dialog()?.textContent).toContain("Share with the team?");
    expect(dialog()?.textContent).toContain("Everyone in Acme who can use Scout will be able to read this whole conversation, including everything already in it and its files, and write in it. It moves to the Team side. It can't be made private again.");
    expect(sent, "nothing is sent before the person confirms").toEqual([]);
    await act(async () => button("Share with the team").click());
    await settle();
    expect(sent).toEqual([{ method: "POST", path: "/api/bots/scout/tasks/t9/share", body: { with: "team" } }]);
    expect(dialog()).toBeNull();
  });

  it("names the one person who will read it, admins kept out, and shares with the one chosen", async () => {
    await show({ kind: "person", botId: "scout", threadId: "t9" });
    expect(sent).toEqual([{ method: "GET", path: "/api/bots/scout/tasks/t9/share", body: undefined }]);
    expect(dialog()?.textContent).toContain("Ana will be able to read this whole conversation, including everything already in it and its files, and carry it on with Scout. Nobody else can see it, admins included. It can't be made private again.");
    const select = dialog()!.querySelector("select")!;
    expect([...select.options].map((option) => option.textContent)).toEqual(["Ana", "Marta"]);
    await act(async () => { select.value = "marta@acme.test"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(dialog()?.textContent).toContain("Marta will be able to read this whole conversation");
    await act(async () => button("Share with Marta").click());
    await settle();
    expect(sent.at(-1)).toEqual({ method: "POST", path: "/api/bots/scout/tasks/t9/share", body: { with: { email: "marta@acme.test" } } });
    expect(dialog()).toBeNull();
  });

  it("says so when nobody else can chat with the bot, and has nothing to confirm", async () => {
    answer = () => reply(200, { shared: null, people: [] });
    await show({ kind: "person", botId: "scout", threadId: "t9" });
    expect(dialog()?.textContent).toContain("Nobody else on the team can chat with Scout yet.");
    expect(button("Share with…").disabled).toBe(true);
  });

  it("keeps the dialog open with the server's words when it refuses", async () => {
    answer = (method) => (method === "GET" ? reply(200, { shared: null, people: [] }) : reply(409, { error: "Scout is still working here. Share it once it's done.", errorKey: "serverError.share.busy", errorParams: { bot: "Scout" } }));
    await show({ kind: "team", botId: "scout", threadId: "t9" });
    await act(async () => button("Share with the team").click());
    await settle();
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe("Scout is still working here. Share it once it's done.");
  });

  it("saves a message to team memory in one click, with Undo taking it out again", async () => {
    answer = (method) => (method === "POST" ? reply(201, { entry: { id: "e1", text: "x", at: 1, yours: true } }) : reply(200, { ok: true, removed: true }));
    await show({ kind: "memory", botId: "scout", threadId: "t9", messageId: "m1", text: "We ship the launch\non 3 March" });
    expect(dialog(), "no dialog, no editing first").toBeNull();
    expect(sent).toEqual([{ method: "POST", path: "/api/bots/scout/memory/team", body: { threadId: "t9", messageId: "m1", text: "We ship the launch\non 3 March" } }]);
    const toast = document.querySelector<HTMLElement>("[data-access-toast]")!;
    expect(toast.textContent).toContain("Saved to Scout's team memory");
    await act(async () => [...toast.querySelectorAll("button")].find((each) => each.textContent === "Undo")!.click());
    await settle();
    expect(sent.at(-1)).toEqual({ method: "DELETE", path: "/api/bots/scout/memory/team/e1", body: undefined });
    expect(document.querySelector("[data-access-toast]")).toBeNull();
  });

  it("says why a save was refused and tries again when asked", async () => {
    let tries = 0;
    answer = () => (++tries === 1 ? reply(409, { error: "This conversation came in from outside the team, so nothing from it goes into team memory." }) : reply(201, { entry: { id: "e2", text: "x", at: 1 } }));
    await show({ kind: "memory", botId: "scout", threadId: "t9", messageId: "m1", text: "Launch: 3 March" });
    const toast = () => document.querySelector<HTMLElement>("[data-access-toast]");
    expect(toast()?.textContent).toContain("This conversation came in from outside the team");
    await act(async () => [...toast()!.querySelectorAll("button")].find((each) => each.textContent === "Try again")!.click());
    await settle();
    expect(sent.filter((each) => each.method === "POST").length).toBe(2);
    expect(toast()?.textContent).toContain("Saved to Scout's team memory");
  });
});
