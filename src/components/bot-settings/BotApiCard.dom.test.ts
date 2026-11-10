// @vitest-environment happy-dom
// The Bot API card in a real DOM against the harness's answers: the key rides in the command once and is gone after that.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { Bot } from "@/state/store";

const URL_ = "https://scout.example.test/hooks/api/bots/b1/messages";
const fixture = vi.hoisted(() => ({ view: null as Record<string, unknown> | null, sent: [] as Array<{ path: string; body?: unknown }>, read: [] as string[], dispatched: [] as unknown[], copied: [] as string[], minted: 0, starter: false, bridge: true, upgrades: 0 }));
vi.mock("../CloudUsageMeter", () => ({
  NoteLine: () => null,
  useCloudUsage: () => (fixture.bridge ? { usage: { tier: "starter" }, bridge: {} } : { usage: null, bridge: undefined }),
  useUpgrade: () => ({ busy: null, note: null, dialog: null, start: () => { fixture.upgrades += 1; } }),
}));
vi.mock("@/lib/copy-text", () => ({ copyText: async (text: string) => { fixture.copied.push(text); return "copied"; } }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({ state: { config: { cloudStarter: fixture.starter }, webhooks: [{ botId: "b1" }, { botId: "b1" }, { botId: "b2" }] }, dispatch: (action: unknown) => fixture.dispatched.push(action) }),
    api: async (path: string, init?: { method?: string; body?: string }) => {
      if (init?.method !== "POST") { fixture.read.push(path); return fixture.view; }
      fixture.sent.push({ path, body: init.body ? JSON.parse(init.body) : undefined });
      const wants = init.body ? (JSON.parse(init.body) as { enabled: boolean }).enabled : true;
      fixture.view = { ...fixture.view, enabled: wants };
      return wants ? { ...fixture.view, key: `bak_key${++fixture.minted}` } : fixture.view;
    },
  };
});

const { BotApiCard, callWords } = await import("./BotApiCard");

let host: HTMLDivElement;
let root: Root;
const bot = { id: "b1", name: "Scout" } as Bot;
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const mount = async (props: Record<string, unknown> = {}) => { flushSync(() => root.render(createElement(BotApiCard, { bot, ...props }))); await settle(); };
const unmount = () => { flushSync(() => root.unmount()); root = createRoot(host); };
const find = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = async (id: string) => { flushSync(() => find(id)!.click()); await settle(); };

beforeEach(() => {
  setLocale("en");
  Object.assign(fixture, { view: { enabled: false, url: URL_, canManage: true, callCount: 0, calls: [] }, sent: [], read: [], dispatched: [], copied: [], minted: 0, starter: false, bridge: true, upgrades: 0 });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { flushSync(() => root.unmount()); host.remove(); });

describe("the Bot API card", () => {
  it("on Starter is one line and the usual Upgrade: no switch, no key, no command, and nothing asked of the server", async () => {
    fixture.starter = true;
    Object.assign(fixture.view!, { enabled: true });
    await mount({ webhooksLink: true });
    expect(find("bot-api-starter")!.textContent).toBe("Bot API comes with a higher plan.");
    for (const gone of ["bot-api-switch", "bot-api-curl", "bot-api-copy", "bot-api-new-key", "bot-api-key-note", "bot-api-webhooks"]) expect(find(gone), gone).toBeNull();
    expect(fixture.read).toEqual([]);
    await click("bot-api-upgrade");
    expect(fixture.upgrades).toBe(1);
  });

  it("on Starter with no way to change the plan from this page, shows the line alone", async () => {
    fixture.starter = true;
    fixture.bridge = false;
    await mount();
    expect(find("bot-api-starter")).not.toBeNull();
    expect(find("bot-api-upgrade")).toBeNull();
  });

  it("comes back as soon as the plan is no longer Starter, and says a key is like a password", async () => {
    fixture.starter = true;
    Object.assign(fixture.view!, { enabled: true });
    await mount();
    expect(find("bot-api-switch")).toBeNull();
    fixture.starter = false;
    await mount({ className: "x" });
    expect(find("bot-api-switch")).not.toBeNull();
    expect(find("bot-api-password")!.textContent).toBe("A key is like a password: whoever holds it can read what this bot can read.");
  });

  it("says in one plain line when this bot's AI can't take calls", async () => {
    await mount();
    expect(find("bot-api-cant-take")).toBeNull();
    unmount();
    Object.assign(fixture.view!, { canTakeCalls: false });
    await mount();
    expect(find("bot-api-cant-take")!.textContent).toBe("This bot's AI can't take Bot API calls. Choose another AI to use them.");
  });

  it("keeps Copy off the command, so nothing in it is hidden", async () => {
    Object.assign(fixture.view!, { enabled: true });
    await mount();
    expect(find("bot-api-curl")!.contains(find("bot-api-copy"))).toBe(false);
    expect(find("bot-api-copy")!.className).not.toContain("absolute");
    expect(find("bot-api-curl")!.className).toContain("whitespace-pre-wrap");
  });

  it("is off with no command until switched on", async () => {
    await mount();
    expect(find("bot-api")!.textContent).toContain("Bot API");
    expect(find("bot-api-switch")!.getAttribute("aria-checked")).toBe("false");
    expect(find("bot-api-curl")).toBeNull();
  });

  it("shows the command with the real key once, copies it as is, and shows YOUR_KEY after leaving", async () => {
    await mount();
    await click("bot-api-switch");
    expect(fixture.sent).toEqual([{ path: "/api/bots/b1/bot-api", body: { enabled: true } }]);
    const curl = find("bot-api-curl")!.textContent!;
    expect(curl).toContain(URL_);
    expect(curl).toContain("Bearer bak_key1");
    expect(find("bot-api-key-note")!.textContent).toContain("shown this once");
    await click("bot-api-copy");
    expect(fixture.copied).toEqual([curl]);
    unmount();
    await mount();
    expect(find("bot-api-curl")!.textContent).toContain("Bearer YOUR_KEY");
    expect(host.innerHTML).not.toContain("bak_key1");
    expect(find("bot-api-new-key")).not.toBeNull();
  });

  it("New key asks first, then puts the new key in the command; switching off takes the command away", async () => {
    Object.assign(fixture.view!, { enabled: true });
    await mount();
    await click("bot-api-new-key");
    expect(fixture.sent).toEqual([]);
    expect(find("bot-api")!.textContent).toContain("replaces the old one");
    await click("bot-api-replace");
    expect(fixture.sent).toEqual([{ path: "/api/bots/b1/bot-api/new-key", body: undefined }]);
    expect(find("bot-api-curl")!.textContent).toContain("Bearer bak_key1");
    await click("bot-api-switch");
    expect(find("bot-api-curl")).toBeNull();
    expect(host.innerHTML).not.toContain("bak_key1");
  });

  it("shows someone who can't edit the bot no controls, and links to the bot's webhooks where they live", async () => {
    Object.assign(fixture.view!, { enabled: true, canManage: false });
    await mount({ webhooksLink: true });
    expect(find("bot-api-switch")!.hasAttribute("disabled")).toBe(true);
    expect(find("bot-api-new-key")).toBeNull();
    expect(find("bot-api-calls")).toBeNull();
    expect(find("bot-api-webhooks")!.textContent).toBe("Webhooks: 2 triggers");
    await click("bot-api-webhooks");
    expect(fixture.dispatched).toEqual([{ type: "showRoutines", view: "list" }]);
  });

  it("says when the address only works on this computer, and lists calls in plain words", async () => {
    Object.assign(fixture.view!, { enabled: true, url: "http://127.0.0.1:8800/hooks/api/bots/b1/messages", callCount: 1, lastCalledAt: Date.now(), calls: [{ id: "c1", receivedAt: Date.now(), outcome: "accepted", statusCode: 200, preview: "What is the pay date?" }] });
    await mount();
    expect(find("bot-api-local")).not.toBeNull();
    expect(find("bot-api-calls")!.textContent).toContain("What is the pay date?");
    expect(callWords({ outcome: "rejected", statusCode: 401, repeats: 3 })).toBe("Wrong key (3)");
  });
});
