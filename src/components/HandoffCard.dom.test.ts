// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SignInRequestCardData } from "../../shared/wire";
import { initialState, StoreContext, type AppState, type Bot, type Message } from "@/state/store";
import { HandoffSuggestion } from "./HandoffSuggestion";
import { SignInRequestCard } from "./SignInRequestCard";
import { ViewerPill } from "./ViewerPill";

let container: HTMLDivElement, root: Root;
let calls: Array<{ url: string; body: unknown }>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const body = url.includes("/api/connectors/catalog") ? { cards: [{ slug: "github", label: "GitHub", blurb: "", logo: null, domain: null }], source: "api", configured: true, mode: "managed" }
      : url.includes("/api/connectors?") ? { services: { github: { connected: false } } } : url.includes("/saved-logins") ? { choices: [] } : { done: true };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

const handoff = (fields: Partial<SignInRequestCardData> = {}): SignInRequestCardData => ({
  url: "", site: "", place: "browser", instruction: "Solve the check on the page.", need: "captcha", expiresAt: Date.now() + 20 * 60_000, ...fields,
});
const row = (id: string, signIn: SignInRequestCardData): Message => ({ id, at: 1, role: "bot", kind: "signin", text: signIn.instruction ?? "", signIn } as Message);

async function show(messages: Message[], index = messages.length - 1, config?: unknown) {
  const dispatch = vi.fn();
  const bot = { id: "scout", name: "Scout", color: "teal", threadId: "t1", messages, tasks: [] } as unknown as Bot;
  const state = { ...initialState, bots: [bot], selectedId: bot.id, connected: true, ...(config ? { config } : {}) } as AppState;
  const value = { state, dispatch, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  await act(async () => root.render(createElement(StoreContext.Provider, { value },
    createElement(SignInRequestCard, { botId: "scout", botName: "Scout", threadId: "t1", message: messages[index]! }))));
  await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
  return dispatch;
}
const button = (name: string) => [...container.querySelectorAll("button")].find((one) => one.textContent?.trim() === name);

describe("a step the bot handed to the person", () => {
  it("shows the place, a title for its kind, the instruction, the live picture and three answers", async () => {
    await show([row("m1", handoff())]);
    const card = container.querySelector('[data-shell="kicker"]')!;
    expect(card.textContent).toContain("Browser");
    expect(card.textContent).toContain("Human check needed");
    expect(card.textContent).toContain("Solve the check on the page.");
    expect(container.querySelector("[data-preview-phase]")?.getAttribute("aria-label")).toBe("Take over Scout's Browser");
    expect([...card.querySelectorAll("button")].map((one) => one.textContent?.trim()).slice(-3)).toEqual(["Skip", "I'm done", "Take over"]);
    expect(button("Take over")!.className).toContain("ui-button-primary");
  });

  it("Take over opens the place full size, on its request", async () => {
    const dispatch = await show([row("m1", handoff({ place: "cloud" }))]);
    expect(container.textContent).toContain("Computer");
    await act(async () => button("Take over")!.click());
    expect(dispatch).toHaveBeenCalledWith({ type: "openSignIn", botId: "scout", messageId: "m1", url: "", site: "", place: "cloud", expand: true, threadId: "t1" });
  });

  it("I'm done sends the person's note with the answer", async () => {
    await show([row("m1", handoff())]);
    await act(async () => button("Add a note")!.click());
    const field = container.querySelector<HTMLInputElement>('input[aria-label="Note for Scout"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "Used the work account");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { button("I'm done")!.click(); await new Promise((done) => setTimeout(done, 0)); });
    expect(calls.find((call) => call.url.endsWith("/sign-in-cards/m1/done"))?.body).toEqual({ threadId: "t1", note: "Used the work account" });
  });

  it("Skip answers it as cancelled", async () => {
    await show([row("m1", handoff())]);
    await act(async () => { button("Skip")!.click(); await new Promise((done) => setTimeout(done, 0)); });
    expect(calls.some((call) => call.url.endsWith("/sign-in-cards/m1/cancel"))).toBe(true);
  });

  it("only the newest open request shows the picture", async () => {
    await show([row("m1", handoff()), row("m2", handoff())], 0);
    expect(container.querySelector("[data-preview-phase]")).toBeNull();
    await show([row("m1", handoff()), row("m2", handoff())], 1);
    expect(container.querySelector("[data-preview-phase]")).not.toBeNull();
  });

  it.each([
    [{ done: true, resumed: true }, "Done · Solve the check on the page."],
    [{ cancelled: true, resumed: true }, "Skipped · Solve the check on the page."],
    [{ expired: true, resumed: true }, "Expired · Solve the check on the page."],
    [{ answeredInChat: true }, "Answered in the chat · Solve the check on the page."],
  ])("folds to one row once answered: %o", async (fields, summary) => {
    await show([row("m1", handoff(fields))]);
    expect(container.querySelector('[data-ask-card="settled"]')).not.toBeNull();
    expect(container.querySelector("[data-handoff-summary]")?.textContent).toBe(summary);
    expect(button("Take over")).toBeUndefined();
  });

  it("offers the app a sign-in site belongs to, and not for other kinds", async () => {
    await show([row("m1", handoff({ need: "sign_in", site: "github.com", url: "https://github.com/" }))]);
    expect(container.querySelector("[data-handoff-suggestion]")?.textContent).toContain("Connect GitHub so Scout can work with it directly");
    await show([row("m2", handoff({ need: "captcha", site: "github.com", url: "https://github.com/" }))]);
    expect(container.querySelector("[data-handoff-suggestion]")).toBeNull();
  });

  it("offers the person's own sign-in from their browser when the app can import one for the site, and answers done once it did", async () => {
    const offer = vi.fn(async () => ({ offered: true }));
    const importIt = vi.fn(async () => ({ ok: true, site: "github.com", imported: 4, sessionOnly: 0, skipped: {} }));
    (window as unknown as { ogb: unknown }).ogb = { browserCookies: { offer, sources: async () => [{ id: "chrome", name: "Chrome", engine: "chromium", profiles: [{ id: "Default", name: "Person 1" }] }], import: importIt } };
    try {
      await show([row("m1", handoff({ need: "sign_in", site: "github.com", url: "https://github.com/" }))], 0, { browserEngine: { cookieImport: true } });
      expect(offer).toHaveBeenCalledWith({ botId: "scout", threadId: null, site: "github.com" });
      await act(async () => button("Use my sign-in from my own browser")!.click());
      // The dialog's code loads on its first open.
      await vi.waitFor(async () => { await act(async () => { await new Promise((done) => setTimeout(done, 0)); }); expect(container.querySelector("dialog form")).not.toBeNull(); });
      await act(async () => { container.querySelector<HTMLFormElement>('dialog form')!.requestSubmit(); await new Promise((done) => setTimeout(done, 0)); });
      expect(importIt).toHaveBeenCalledWith({ botId: "scout", threadId: null, site: "github.com", source: "chrome", profile: "Default" });
      expect(calls.find((call) => call.url.endsWith("/sign-in-cards/m1/done"))?.body).toEqual({ threadId: "t1", note: "imported the person's sign-in for github.com from their own Chrome" });
      offer.mockClear();
      await show([row("m2", handoff({ need: "captcha", site: "github.com", url: "https://github.com/" }))], 0, { browserEngine: { cookieImport: true } });
      expect(offer).not.toHaveBeenCalled();
      expect(button("Use my sign-in from my own browser")).toBeUndefined();
    } finally {
      delete (window as unknown as { ogb?: unknown }).ogb;
    }
  });

  it("leaves a site sign-in without an instruction on its own card", async () => {
    await show([row("m1", { url: "https://notion.so", site: "notion.so", place: "browser" })]);
    expect(container.querySelector('[data-shell="kicker"]')).toBeNull();
    expect(container.textContent).toContain("notion.so");
  });
});

describe("the connect suggestion", () => {
  it("answers the request as done with a note that the app was connected instead", async () => {
    const bot = { id: "scout", name: "Scout", color: "teal", threadId: "t1", messages: [], tasks: [] } as unknown as Bot;
    const value = { state: { ...initialState, bots: [bot] }, dispatch: vi.fn(), flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
    await act(async () => root.render(createElement(StoreContext.Provider, { value }, createElement(HandoffSuggestion, {
      app: { slug: "github", label: "GitHub", blurb: "", logo: null, domain: null }, status: { connected: true },
      request: { botId: "scout", threadId: "t1", messageId: "m1", place: "browser" }, botName: "Scout",
    }))));
    await act(async () => { button("Connect")!.click(); await new Promise((done) => setTimeout(done, 0)); });
    expect(calls.find((call) => call.url.endsWith("/sign-in-cards/m1/done"))?.body).toEqual({ threadId: "t1", note: "connected GitHub instead" });
    expect(container.querySelector("[data-handoff-suggestion]")?.getAttribute("data-handoff-suggestion")).toBe("connected");
  });

  it("can be dismissed", async () => {
    const value = { state: { ...initialState, bots: [] }, dispatch: vi.fn(), flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
    await act(async () => root.render(createElement(StoreContext.Provider, { value }, createElement(HandoffSuggestion, {
      app: { slug: "github", label: "GitHub", blurb: "", logo: null, domain: null }, status: { connected: false },
      request: { botId: "scout", threadId: "t1", messageId: "m9", place: "browser" }, botName: "Scout",
    }))));
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Not now"]')!.click());
    expect(container.querySelector("[data-handoff-suggestion]")).toBeNull();
  });
});

describe("the viewer pill", () => {
  it.each([
    ["watching", "Watching", "Take control"],
    ["control", "You're in control", "Stop"],
    ["control-request", "You're in control", "I'm done"],
  ] as const)("%s says %s and offers %s", async (state, status, action) => {
    const handlers = { onTake: vi.fn(), onStop: vi.fn(), onDone: vi.fn() };
    await act(async () => root.render(createElement(ViewerPill, { state, ...handlers })));
    expect(container.querySelector('[role="status"]')?.textContent).toBe(status);
    await act(async () => button(action)!.click());
    const pressed = state === "watching" ? handlers.onTake : state === "control" ? handlers.onStop : handlers.onDone;
    expect(pressed).toHaveBeenCalledOnce();
  });
});
