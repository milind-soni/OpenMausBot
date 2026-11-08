// @vitest-environment happy-dom
// The iMessage card in a real DOM against the harness's answers: a key, secret and number typed and sent once, the
// command shown until the phone links, then the linked phone, and Disconnect back to the start.
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
      else if (path.endsWith("/link")) { fixture.view = { ...fixture.view, linkExpiresAt: Date.now() + 600_000 }; return { ...fixture.view, code: "123456", command: "link 123456", url: "sms:+14155550100&body=link%20123456", expiresAt: Date.now() + 600_000 }; }
      else fixture.view = { available: true, connected: true, number: "+14155550100", chats: [] };
      return fixture.view;
    },
  };
});

const { IMessageCard } = await import("./IMessageCard");

let host: HTMLDivElement;
let root: Root;
const bot = { id: "b1", name: "Scout" } as Bot;
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const mount = async () => { flushSync(() => root.render(createElement(IMessageCard, { bot }))); await settle(); };
const find = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = async (id: string) => { flushSync(() => find(id)!.click()); await settle(); };
const type = async (id: string, value: string) => {
  const input = find(id) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  flushSync(() => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await settle();
};
const fill = async () => { await type("imessage-key-id", "key-scout-0001"); await type("imessage-secret", "secret-scout-aaaa"); await type("imessage-number", "+14155550100"); };

beforeEach(() => {
  setLocale("en");
  Object.assign(fixture, { view: { available: true, connected: false, chats: [] }, sent: [], copied: [], refuse: null });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { flushSync(() => root.unmount()); host.remove(); });

describe("the iMessage card", () => {
  it("takes a key, secret and number once, shows the command, then lists the phone and disconnects", async () => {
    await mount();
    expect((find("imessage-connect") as HTMLButtonElement).disabled).toBe(true);
    await fill();
    expect((find("imessage-key-id") as HTMLInputElement).type).toBe("password");
    expect((find("imessage-secret") as HTMLInputElement).type).toBe("password");
    await click("imessage-connect");
    expect(fixture.sent).toEqual([{ path: "/api/bots/b1/imessage", method: "POST", body: { keyId: "key-scout-0001", secret: "secret-scout-aaaa", number: "+14155550100" } }]);
    expect(find("imessage-connected")!.textContent).toBe("Connected to +14155550100");
    expect(find("imessage-secret")).toBeNull();

    await click("imessage-start-link");
    expect(find("imessage-command")!.textContent).toBe("link 123456");
    expect(find("imessage-link")!.textContent).toContain("text this to +14155550100");
    expect(find("imessage-link-url")!.getAttribute("href")).toBe("sms:+14155550100&body=link%20123456");
    expect(find("imessage-waiting")).not.toBeNull();
    expect(find("imessage-start-link")).toBeNull();
    await click("imessage-copy");
    expect(fixture.copied).toEqual(["link 123456"]);

    fixture.view = { available: true, connected: true, number: "+14155550100", chats: [{ id: "+14155550123" }] };
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    await settle();
    expect(find("imessage-chats")!.textContent).toBe("Linked: +14155550123");
    expect(find("imessage-link")).toBeNull();
    expect(find("imessage-start-link")!.textContent).toBe("Link another iPhone");

    await click("imessage-disconnect");
    expect(fixture.sent.at(-1)).toEqual({ path: "/api/bots/b1/imessage", method: "DELETE", body: undefined });
    expect(find("imessage-secret")).not.toBeNull();
  }, 10_000);

  it("says what Sendblue's free plan allows before asking for anything", async () => {
    await mount();
    expect(find("imessage-plans")!.textContent).toContain("free plan");
    expect(find("imessage-plans")!.textContent).toContain("verified");
  });

  it("shows the server's refusal and keeps the fields", async () => {
    await mount();
    fixture.refuse = "Sendblue doesn't know that API key ID and secret. Copy both again from the Sendblue dashboard.";
    await fill();
    await click("imessage-connect");
    expect(host.querySelector('[role="alert"]')!.textContent).toBe(fixture.refuse);
    expect((find("imessage-secret") as HTMLInputElement).value).toBe("secret-scout-aaaa");
  });

  it("is one line on a team server", async () => {
    fixture.view = { available: false, connected: false, chats: [] };
    await mount();
    expect(find("imessage-unavailable")!.textContent).toBe("iMessage isn't available on a team server yet.");
    expect(find("imessage-secret")).toBeNull();
  });
});
