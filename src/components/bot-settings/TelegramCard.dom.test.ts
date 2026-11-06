// @vitest-environment happy-dom
// The Telegram card in a real DOM against the harness's answers: a token typed and sent once, the t.me link shown until
// the chat links, then the linked chat, and Disconnect back to the start.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({ view: {} as Record<string, unknown>, sent: [] as Array<{ path: string; method?: string; body?: unknown }>, copied: [] as string[], refuse: null as string | null }));
vi.mock("@/lib/copy-text", () => ({ copyText: async (text: string) => { fixture.copied.push(text); return "copied"; } }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    api: async (path: string, init?: { method?: string; body?: string }) => {
      if (!init?.method) return fixture.view;
      fixture.sent.push({ path, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
      if (fixture.refuse) throw new Error(fixture.refuse);
      if (init.method === "DELETE") fixture.view = { available: true, connected: false, chats: [] };
      else if (path.endsWith("/link")) { fixture.view = { ...fixture.view, linkExpiresAt: Date.now() + 600_000 }; return { ...fixture.view, code: "123456", url: "https://t.me/scout_bot?start=123456", expiresAt: Date.now() + 600_000 }; }
      else fixture.view = { available: true, connected: true, username: "scout_bot", chats: [] };
      return fixture.view;
    },
  };
});

const { TelegramCard } = await import("./TelegramCard");

let host: HTMLDivElement;
let root: Root;
const bot = { id: "b1", name: "Scout" } as Bot;
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const mount = async () => { flushSync(() => root.render(createElement(TelegramCard, { bot }))); await settle(); };
const find = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = async (id: string) => { flushSync(() => find(id)!.click()); await settle(); };
const type = async (id: string, value: string) => {
  const input = find(id) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  flushSync(() => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await settle();
};

beforeEach(() => {
  setLocale("en");
  Object.assign(fixture, { view: { available: true, connected: false, chats: [] }, sent: [], copied: [], refuse: null });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { flushSync(() => root.unmount()); host.remove(); });

describe("the Telegram card", () => {
  it("takes a token once, shows the bot's name, links by t.me link, then lists the chat and disconnects", async () => {
    await mount();
    expect((find("telegram-connect") as HTMLButtonElement).disabled).toBe(true);
    await type("telegram-token", "123456789:AAE-token");
    expect((find("telegram-token") as HTMLInputElement).type).toBe("password");
    await click("telegram-connect");
    expect(fixture.sent).toEqual([{ path: "/api/bots/b1/telegram", method: "POST", body: { token: "123456789:AAE-token" } }]);
    expect(find("telegram-connected")!.textContent).toBe("Connected as @scout_bot");
    expect(find("telegram-token")).toBeNull();

    await click("telegram-start-link");
    expect(find("telegram-link-url")!.getAttribute("href")).toBe("https://t.me/scout_bot?start=123456");
    expect(find("telegram-waiting")).not.toBeNull();
    expect(find("telegram-start-link")).toBeNull();
    await click("telegram-copy");
    expect(fixture.copied).toEqual(["https://t.me/scout_bot?start=123456"]);

    fixture.view = { available: true, connected: true, username: "scout_bot", chats: [{ id: "4242", name: "Ada" }] };
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    await settle();
    expect(find("telegram-chats")!.textContent).toBe("Linked: Ada");
    expect(find("telegram-link")).toBeNull();
    expect(find("telegram-start-link")!.textContent).toBe("Link another Telegram");

    await click("telegram-disconnect");
    expect(fixture.sent.at(-1)).toEqual({ path: "/api/bots/b1/telegram", method: "DELETE", body: undefined });
    expect(find("telegram-token")).not.toBeNull();
  }, 10_000);

  it("shows the server's refusal and keeps the token field", async () => {
    await mount();
    fixture.refuse = "Telegram doesn't know that token. Copy it again from BotFather.";
    await type("telegram-token", "nope");
    await click("telegram-connect");
    expect(host.querySelector('[role="alert"]')!.textContent).toBe("Telegram doesn't know that token. Copy it again from BotFather.");
    expect(find("telegram-token")).not.toBeNull();
  });

  it("is one line on a team server", async () => {
    fixture.view = { available: false, connected: false, chats: [] };
    await mount();
    expect(find("telegram-unavailable")!.textContent).toBe("Telegram isn't available on a team server yet.");
    expect(find("telegram-token")).toBeNull();
  });
});
