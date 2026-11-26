// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { Bot } from "@/state/store";

const fx = vi.hoisted(() => ({ config: null as unknown, request: vi.fn() }));
vi.mock("@/state/store-select", async (importOriginal) => (await import("@/testing/plain-store-select")).plainStoreSelect(await importOriginal()));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, config: fx.config }, dispatch: vi.fn() }) };
});
vi.mock("../DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: {} }) }));

const { VpsAliasField } = await import("./VpsAliasField");
const { BotEditorContext } = await import("./BotEditorContext");

let host: HTMLDivElement;
let root: Root;
const bot = (vpsAlias?: string): Bot => ({
  id: "bot-1", threadId: "thread-1", name: "Scout", title: "Scout", description: "", notifications: false, color: "green", unread: false,
  modelSelection: { instanceId: "local", model: "test-model" }, messages: [], computer: "cloud", cloudBackend: "vps", ...(vpsAlias ? { vpsAlias } : {}),
});
const render = (value: Bot) => flushSync(() => root.render(createElement(BotEditorContext.Provider, { value: { request: fx.request } }, createElement(VpsAliasField, { bot: value }))));
const picker = () => host.querySelector<HTMLSelectElement>('select[aria-label="Choose this bot\'s server"]');
const aliasBox = () => host.querySelector<HTMLInputElement>('input[aria-label="Server (SSH alias)"]');
const choose = (value: string) => flushSync(() => {
  picker()!.value = value;
  picker()!.dispatchEvent(new Event("change", { bubbles: true }));
});
const submit = () => flushSync(() => picker()!.form!.requestSubmit());
const patched = () => fx.request.mock.calls.map(([path, init]) => [path, JSON.parse((init as RequestInit).body as string)]);

beforeEach(() => {
  setLocale("en");
  fx.request.mockReset();
  fx.request.mockResolvedValue({});
  fx.config = { vps: { configured: true, sshAlias: "production-vps", servers: [{ name: "Home lab", sshAlias: "home-lab" }, { name: "Office", sshAlias: "office-vps" }] } };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

describe("a VPS bot's server picker", () => {
  it("lists the default and the named servers, and moves the bot only on Save", async () => {
    render(bot());
    expect([...picker()!.options].map((option) => option.text)).toEqual(["Default server (production-vps)", "Home lab (home-lab)", "Office (office-vps)", "Other SSH alias…"]);
    expect(picker()!.value).toBe("");
    expect(aliasBox()).toBeNull();
    choose("home-lab");
    await Promise.resolve();
    expect(fx.request).not.toHaveBeenCalled();
    expect(picker()!.value).toBe("home-lab");
    submit();
    await Promise.resolve();
    expect(patched()).toEqual([["/api/bots/bot-1", { vpsAlias: "home-lab" }]]);
  });

  it("does not list a named server that is the default again", () => {
    fx.config = { vps: { configured: true, sshAlias: "production-vps", servers: [{ name: "Prod", sshAlias: "production-vps" }, { name: "Office", sshAlias: "office-vps" }] } };
    render(bot());
    expect([...picker()!.options].map((option) => option.text)).toEqual(["Default server (production-vps)", "Office (office-vps)", "Other SSH alias…"]);
  });

  it("goes back to the default server as no alias of its own", async () => {
    render(bot("office-vps"));
    expect(picker()!.value).toBe("office-vps");
    choose("");
    submit();
    await Promise.resolve();
    expect(patched()).toEqual([["/api/bots/bot-1", { vpsAlias: null }]]);
  });

  it("keeps a typed alias that is not in the list, and opens the alias box for another", async () => {
    render(bot("custom-box"));
    expect(picker()!.value).toBe("custom-box");
    choose(" other");
    expect(fx.request).not.toHaveBeenCalled();
    const box = aliasBox()!;
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(box, "lab-2");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    flushSync(() => box.form!.requestSubmit());
    await Promise.resolve();
    expect(patched()).toEqual([["/api/bots/bot-1", { vpsAlias: "lab-2" }]]);
  });

  it("stays a plain alias box when no servers are named", () => {
    fx.config = { vps: { configured: true, sshAlias: "production-vps" } };
    render(bot());
    expect(picker()).toBeNull();
    expect(aliasBox()!.placeholder).toBe("production-vps");
    expect(host.textContent).toContain("Leave empty to use production-vps");
  });
});
