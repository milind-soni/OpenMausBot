// @vitest-environment happy-dom
// Simple's Bot settings card for a bot's backup AIs, in a real DOM: the same model menu as Model, the bot's own list.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";

const fixture = vi.hoisted(() => ({ instances: [] as InstanceInfo[], dispatch: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({
      state: { ...original.initialState, instances: fixture.instances },
      dispatch: fixture.dispatch,
      refreshInstances: () => Promise.resolve(),
      refreshModels: () => Promise.resolve(),
    }),
  };
});
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => false, readAdvancedMode: () => false, setAdvancedMode: vi.fn() }));
vi.mock("../Avatar", () => ({ BotAvatar: () => null, MausAvatar: () => null }));

const { BackupAis, MAX_BACKUPS } = await import("./BackupAis");

const engine = (instanceId: string, displayName: string, driverKind: string, models: Array<[string, string]>): InstanceInfo => ({
  instanceId, displayName, driverKind, access: "subscription", enabled: true,
  snapshot: { state: "available", version: "1", authenticated: true },
  models: { default: models[0]![0], options: models.map(([id, label]) => ({ id, label })) },
}) as unknown as InstanceInfo;

const claude = engine("claude", "Claude", "claudeAgent", [["claude-sonnet-5", "Claude Sonnet 5"]]);
const codex = engine("codex", "Codex", "codex", [["gpt-5.5", "GPT-5.5"], ["gpt-5.5-mini", "GPT-5.5 mini"]]);
const gemini = engine("gemini", "Gemini", "geminiAgent", [["gemini-3-pro", "Gemini 3 Pro"]]);

const bot = (fallback?: Bot["fallback"]): Bot => ({
  id: "scout", threadId: "thread-scout", name: "Scout", title: "", description: "", soul: "",
  notifications: true, color: "green", unread: false, messages: [],
  modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
  ...(fallback ? { fallback } : {}),
});

let host: HTMLDivElement;
let root: Root;
const onChange = vi.fn();
const render = (fallback?: Bot["fallback"]) => flushSync(() => root.render(createElement(BackupAis, { bot: bot(fallback), onChange })));
const settle = async () => {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const click = (element: Element | null | undefined) => {
  if (!element) throw new Error("nothing to click");
  flushSync(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
};
const menu = () => document.querySelector<HTMLElement>("[data-backup-menu]");
const providers = () => [...(menu()?.querySelectorAll("[data-simple-provider]") ?? [])].map((group) => group.getAttribute("data-simple-provider"));
const modelRow = (label: string) => [...(menu()?.querySelectorAll<HTMLElement>("[data-menu-row]") ?? [])]
  .find((row) => row.getAttribute("aria-label")?.startsWith(label));

beforeEach(() => {
  fixture.instances.splice(0, fixture.instances.length, claude, codex, gemini);
  fixture.dispatch.mockReset();
  onChange.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

describe("a bot's backup AIs in Simple", () => {
  it("say when they are used, with no switch to turn them on", () => {
    render();
    const card = host.querySelector("[data-panel-row=backups]")!;
    expect(card.textContent).toContain("Backup AIs");
    expect(card.textContent).toContain("Used only when Scout's AI is at its usage limit or can't start on a message.");
    expect(card.textContent).toContain("After a usage limit resets, the conversation goes back.");
    expect(card.querySelector('[role="switch"], input[type="checkbox"]')).toBeNull();
    expect(host.querySelectorAll("[data-backup]")).toHaveLength(0);
  });

  it("adds one from the same model menu, never offering the bot's own AI", async () => {
    render();
    click(host.querySelector("[data-panel-action=backup-add]"));
    await settle();
    expect(menu()?.getAttribute("aria-label")).toBe("Choose a backup AI");
    expect(providers()).toEqual(["codex", "gemini"]);
    expect(menu()?.querySelector("[data-current-model]")).toBeNull();
    click(modelRow("GPT-5.5 mini"));
    expect(onChange).toHaveBeenCalledWith([{ instanceId: "codex", model: "gpt-5.5-mini" }]);
    expect(host.querySelector("[data-panel-action=backup-add]")?.getAttribute("aria-expanded")).toBe("false");
  });

  it("changes one in place, offering only AIs no other backup uses", async () => {
    render([{ instanceId: "codex", model: "gpt-5.5" }, { instanceId: "gemini", model: "gemini-3-pro" }]);
    const rows = host.querySelectorAll("[data-backup]");
    expect([...rows].map((row) => row.querySelector("[data-panel-action=backup-change]")?.getAttribute("aria-label")))
      .toEqual(["Backup 1: GPT-5.5", "Backup 2: Gemini 3 Pro"]);
    click(rows[0]!.querySelector("[data-panel-action=backup-change]"));
    await settle();
    expect(providers()).toEqual(["codex"]);
    expect(menu()?.querySelector("[data-current-model]")?.textContent).toContain("GPT-5.5");
    click(modelRow("GPT-5.5 mini"));
    expect(onChange).toHaveBeenCalledWith([{ instanceId: "codex", model: "gpt-5.5-mini" }, { instanceId: "gemini", model: "gemini-3-pro" }]);
  });

  it("removes one and keeps the rest in order", () => {
    render([{ instanceId: "codex", model: "gpt-5.5" }, { instanceId: "gemini", model: "gemini-3-pro" }]);
    const remove = host.querySelector('[data-backup="codex"] [data-panel-action=backup-remove]');
    expect(remove?.getAttribute("aria-label")).toBe("Remove GPT-5.5 from backups");
    click(remove);
    expect(onChange).toHaveBeenCalledWith([{ instanceId: "gemini", model: "gemini-3-pro" }]);
  });

  it("stops offering Add at the most the bot can keep", () => {
    const full = Array.from({ length: MAX_BACKUPS }, (_, index) => ({ instanceId: `engine-${index}`, model: "m" }));
    render(full);
    expect(host.querySelectorAll("[data-backup]")).toHaveLength(MAX_BACKUPS);
    expect(host.querySelector("[data-panel-action=backup-add]")).toBeNull();
    expect(host.querySelector("[data-backup]")?.textContent).toContain("Unavailable");
  });

  it("closes its menu on Escape without letting the key close the panel", async () => {
    render();
    click(host.querySelector("[data-panel-action=backup-add]"));
    await settle();
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    flushSync(() => (document.activeElement ?? menu())!.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(menu()).toBeNull();
    expect(document.activeElement?.getAttribute("data-panel-action")).toBe("backup-add");
  });
});
