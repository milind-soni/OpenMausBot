// @vitest-environment happy-dom
// The Simple model menu in a real DOM, where effects run, focus moves and the menu floats in a portal.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";

const fixture = vi.hoisted(() => ({
  advanced: false,
  instances: [] as InstanceInfo[],
  bots: [] as Bot[],
  dispatch: vi.fn(),
  refreshModels: vi.fn(() => Promise.resolve()),
  refreshInstances: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  useStore: () => ({
    state: { instances: fixture.instances, bots: fixture.bots, modelVariantSessions: {}, config: {} },
    dispatch: fixture.dispatch,
    refreshInstances: fixture.refreshInstances,
    refreshModels: fixture.refreshModels,
  }),
}));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, setAdvancedMode: () => {} }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("./Avatar", () => ({ BotAvatar: () => null }));

const { ModelPicker } = await import("./ModelPicker");

type Option = InstanceInfo["models"]["options"][number];
const claude = (options: Option[], authenticated = true): InstanceInfo => ({
  instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", access: "subscription",
  snapshot: { state: "available", version: "2.1.300", authenticated },
  models: { default: options[0]!.id, options },
  capabilities: { effortLevels: ["low", "medium", "high"] },
});
const three: Option[] = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
];
const scout = (model = "claude-opus-5-5"): Bot => ({
  id: "scout", threadId: "thread-scout", name: "Scout", title: "", description: "", notifications: true,
  color: "green", unread: false, messages: [], modelSelection: { instanceId: "claude", model },
});
const numbered = (count: number): Option[] => Array.from({ length: count }, (_, index) => ({ id: `model-${index}`, label: `Model ${index}` }));
/** The thread runs `threadModel` on its own; the bot's own model is `botModel`; `others` threads keep their own models too. */
function ownModelThread(threadModel: string, botModel: string, others: Array<[string, string]> = []): Bot {
  const own = (threadId: string, model: string) => ({ threadId, title: threadId, createdAt: 1, modelSelection: { instanceId: "claude", model }, followsBotModel: false });
  fixture.bots = [{ ...scout(botModel), tasks: [own("thread-scout", threadModel), ...others.map(([threadId, model]) => own(threadId, model))] }];
  return scout(threadModel);
}

let host: HTMLDivElement;
let root: Root;
const parentKey = vi.fn();
const render = (bot = scout()) => flushSync(() => root.render(createElement("div", { onKeyDown: (event: { key: string }) => parentKey(event.key) },
  createElement(ModelPicker, { bot, threadId: bot.threadId }))));
const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const chip = () => host.querySelector<HTMLButtonElement>('[data-tour="model"]')!;
const menu = () => document.querySelector<HTMLElement>("[data-model-picker-content]");
const focused = () => document.activeElement as HTMLElement | null;
const press = (key: string, target: Element | null = focused(), init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  flushSync(() => target!.dispatchEvent(event));
  return event;
};
const type = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  flushSync(() => input.dispatchEvent(new Event("input", { bubbles: true })));
};
const openWith = async (key: "ArrowDown" | "click") => {
  chip().focus();
  if (key === "click") flushSync(() => chip().click());
  else press(key, chip());
  await settle();
};

beforeEach(() => {
  fixture.advanced = false;
  fixture.bots = [];
  fixture.instances = [claude(three)];
  fixture.dispatch.mockReset();
  parentKey.mockReset();
  document.documentElement.dataset.reducedMotion = "true";
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  render();
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

describe("choosing a model with the keyboard", () => {
  it("opens from the chip, starts on the current model, moves with the arrows and picks with Enter", async () => {
    await openWith("ArrowDown");
    expect(menu()).not.toBeNull();
    expect(host.contains(menu())).toBe(false);
    expect(focused()?.hasAttribute("data-current-model")).toBe(true);
    expect(chip().getAttribute("aria-expanded")).toBe("true");

    press("ArrowDown");
    expect(focused()?.textContent).toBe("Sonnet 5.5");
    press("ArrowDown");
    expect(focused()?.textContent).toBe("Haiku 5.5");
    press("ArrowUp");
    press("Enter");
    await settle();

    expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "setModel", selection: expect.objectContaining({ model: "claude-sonnet-5-5" }),
    }));
    expect(menu()).toBeNull();
    expect(focused()).toBe(chip());
  });

  it("closes on Enter right after opening, from the checked row it starts on, changing nothing", async () => {
    render(ownModelThread("claude-sonnet-5-5", "claude-opus-5-5", [["kept", "claude-haiku-5-5"]]));
    await openWith("ArrowDown");
    expect(focused()?.hasAttribute("data-current-model")).toBe(true);
    press("Enter");
    await settle();
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(menu()).toBeNull();
    expect(focused()).toBe(chip());
    expect(document.querySelector("[data-thread-models-notice]")).toBeNull();
  });

  it("keeps a Space inside a name being typed, instead of pressing the row it has reached", async () => {
    render(scout("claude-sonnet-5-5"));
    await openWith("click");
    press("o");
    expect(focused()?.textContent).toBe("Opus 5.5");
    press("p");
    expect(press(" ").defaultPrevented).toBe(true);
    expect(focused()?.textContent).toBe("Opus 5.5");
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(menu()).not.toBeNull();
  });

  it("wraps around the rows, and jumps to a row by the letters typed", async () => {
    await openWith("click");
    press("ArrowUp");
    expect(focused()?.hasAttribute("data-simple-manage")).toBe(true);
    press("ArrowDown");
    expect(focused()?.hasAttribute("data-current-model")).toBe(true);
    press("h");
    expect(focused()?.textContent).toBe("Haiku 5.5");
    press("End");
    expect(focused()?.hasAttribute("data-simple-manage")).toBe(true);
    press("Home");
    expect(focused()?.hasAttribute("data-current-model")).toBe(true);
  });

  it("moves through the Thinking steps with the arrow keys and applies one only on Enter, staying open", async () => {
    await openWith("click");
    const low = document.querySelector<HTMLElement>("[data-effort-pill]")!;
    low.focus();
    press("ArrowRight");
    expect(focused()?.textContent).toBe("Medium");
    expect(fixture.dispatch).not.toHaveBeenCalled();
    flushSync(() => focused()!.click());
    expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ selection: expect.objectContaining({ effort: "medium" }) }));
    expect(menu()).not.toBeNull();
  });

  it("clears a search with Escape before closing, keeps every Escape from the panel around it, and returns focus to the chip", async () => {
    fixture.instances = [claude(numbered(14))];
    render(scout("model-0"));
    await openWith("click");
    const search = document.querySelector<HTMLInputElement>("[data-menu-search]")!;
    expect(focused()).toBe(search);
    expect(press("Enter", search).defaultPrevented).toBe(true);
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(menu()).not.toBeNull();
    type(search, "model 1");
    expect(document.querySelectorAll('[data-simple-provider] [data-menu-row]')).toHaveLength(5);
    press("Enter", search);
    expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ selection: expect.objectContaining({ model: "model-1" }) }));
    await openWith("click");
    type(document.querySelector<HTMLInputElement>("[data-menu-search]")!, "model 1");
    expect(press("Escape").defaultPrevented).toBe(true);
    expect(document.querySelector<HTMLInputElement>("[data-menu-search]")!.value).toBe("");
    expect(menu()).not.toBeNull();
    press("Escape");
    await settle();
    expect(menu()).toBeNull();
    expect(focused()).toBe(chip());
    expect(parentKey).not.toHaveBeenCalledWith("Escape");
  });

  it("closes when Tab leaves its last stop, and hands focus back to the chip", async () => {
    await openWith("click");
    document.querySelector<HTMLElement>("[data-simple-manage]")!.focus();
    expect(press("Tab").defaultPrevented).toBe(true);
    await settle();
    expect(menu()).toBeNull();
    expect(focused()).toBe(chip());
  });

  it("opens the full picker from a provider that needs signing in, and Escape brings the list back on that row", async () => {
    fixture.instances = [claude(three, false)];
    render();
    await openWith("click");
    const signIn = document.querySelector<HTMLElement>("[data-simple-set-up]")!;
    signIn.focus();
    press("ArrowRight");
    await settle();
    expect(document.querySelector("[data-simple-model-menu]")).toBeNull();
    expect(focused()?.hasAttribute("data-model-back")).toBe(true);
    press("Escape");
    await settle();
    expect(document.querySelector("[data-simple-model-menu]")).not.toBeNull();
    expect(focused()?.hasAttribute("data-simple-set-up")).toBe(true);

    flushSync(() => focused()!.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
    await settle();
    expect(document.querySelector("[data-model-back]")).not.toBeNull();
    expect(focused()).toBe(menu());
  });
});

describe("the full picker's search and the rows around it", () => {
  it("goes from the search to its first result and back, and up to the row above it, so Enter picks what was searched", async () => {
    fixture.advanced = true;
    fixture.instances = [claude(numbered(14))];
    render(ownModelThread("model-1", "model-0"));
    await openWith("click");
    const search = document.querySelector<HTMLInputElement>("[data-menu-search]")!;
    expect(focused()).toBe(search);
    type(search, "model 5");
    press("ArrowDown", search);
    expect(focused()?.textContent).toContain("Model 5");
    press("ArrowUp");
    expect(focused()).toBe(search);
    press("ArrowUp", search);
    expect(focused()?.hasAttribute("data-follow-bot-model")).toBe(true);
    press("ArrowDown");
    expect(focused()).toBe(search);
    press("ArrowDown", search);
    press("Enter");
    await settle();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({
      type: "setModel", botId: "scout", threadId: "thread-scout", updateBotDefault: false,
      selection: { instanceId: "claude", model: "model-5" },
    });
  });
});

describe("the floating menu and the pointer", () => {
  it("stays open for a click inside its portal and closes for one outside, without taking focus", async () => {
    await openWith("click");
    const row = document.querySelector<HTMLElement>("[data-simple-provider] [data-menu-row]")!;
    flushSync(() => row.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    expect(menu()).not.toBeNull();
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    flushSync(() => outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    await settle();
    expect(menu()).toBeNull();
    expect(focused()).toBe(outside);
    outside.remove();
  });

  it("follows its chip to where it settles once the panel around it finishes sliding in", async () => {
    let right = 980;
    vi.spyOn(chip(), "getBoundingClientRect").mockImplementation(() =>
      ({ left: right - 80, right, top: 40, bottom: 72, width: 80, height: 32, x: right - 80, y: 40, toJSON: () => ({}) }) as DOMRect);
    await openWith("click");
    expect(menu()!.style.left).toBe(`${980 - 300}px`);
    right = 952;
    flushSync(() => chip().parentElement!.dispatchEvent(new Event("animationend", { bubbles: true })));
    expect(menu()!.style.left).toBe(`${952 - 300}px`);
    right = 900;
    flushSync(() => menu()!.dispatchEvent(new Event("animationend", { bubbles: true })));
    expect(menu()!.style.left).toBe(`${952 - 300}px`);
  });

  it("moves the keyboard highlight to the row under the mouse once the keyboard is in the list", async () => {
    await openWith("click");
    const rows = [...document.querySelectorAll<HTMLElement>("[data-simple-provider] [data-menu-row]")];
    flushSync(() => rows[1]!.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" })));
    expect(focused()).toBe(rows[1]);
  });
});
