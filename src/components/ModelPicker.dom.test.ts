// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";

const fixture = vi.hoisted(() => ({
  instances: [] as InstanceInfo[],
  bots: [] as Bot[],
  owner: true,
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
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.owner }));
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
  fixture.owner = true;
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

it.each([true, false])("picks a phone model with the appropriate default-model permission (%s)", async (owner) => {
  fixture.owner = owner;
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("767.98px"), addEventListener() {}, removeEventListener() {},
  }));
  try {
    render(ownModelThread(three[2].id, three[0].id));
    await openWith("click");
    const sheet = document.querySelector<HTMLDialogElement>("[data-phone-model-sheet]")!;
    expect(sheet.open).toBe(true);
    expect(menu()).toBeNull();
    const rows = sheet.querySelectorAll<HTMLButtonElement>("[data-phone-model-list] button[aria-pressed]");
    expect(rows[owner ? 0 : 2].getAttribute("aria-pressed")).toBe("true");
    flushSync(() => rows[1].click());
    expect(fixture.dispatch).toHaveBeenCalledWith({
      type: "setModel", botId: "scout", threadId: "thread-scout", updateBotDefault: owner,
      selection: { instanceId: "claude", model: three[1].id },
    });
    expect(document.querySelector("[data-phone-model-sheet]")).toBeNull();
  } finally {
    vi.unstubAllGlobals();
  }
});

describe("the full picker's search and the rows around it", () => {
  it("goes from the search to its first result and back, and up to the row above it, so Enter picks what was searched", async () => {
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

describe("an OpenCode model typed by hand", () => {
  const typed = "venice/deepseek-v4-1-flash-uncensored";
  const opencode: InstanceInfo = {
    instanceId: "opencode", driverKind: "opencodeGo", displayName: "OpenCode", access: "subscription",
    snapshot: { state: "available", version: "1.19.4", authenticated: true },
    models: { default: "opencode/big-pickle", options: [
      { id: "opencode/big-pickle", label: "Zen · Big Pickle" }, { id: "venice/deepseek-v4-flash", label: "Venice · DeepSeek V4 Flash" },
    ] },
  };
  const onOpenCode = (model: string): Bot => ({ ...scout(), modelSelection: { instanceId: "opencode", model } });
  const typedRows = () => [...document.querySelectorAll<HTMLElement>("[data-menu-row]")].filter((candidate) => candidate.textContent?.includes("typed by hand"));

  it("is picked from the search box and named as typed by hand", async () => {
    fixture.instances = [opencode];
    render(onOpenCode("opencode/big-pickle"));
    await openWith("click");
    type(document.querySelector<HTMLInputElement>("[data-menu-search]")!, typed);
    const row = [...document.querySelectorAll<HTMLElement>("[data-menu-row]")].find((candidate) => candidate.textContent?.includes("typed by hand"))!;
    flushSync(() => row.click());
    await settle();
    expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ type: "setModel", selection: { instanceId: "opencode", model: `typed::${typed}` } }));
    render(onOpenCode(`typed::${typed}`));
    expect(chip().textContent).toContain(`${typed} · typed by hand`);
  });

  it("is never offered under a provider OpenCode lists no model of", async () => {
    fixture.instances = [opencode];
    render(onOpenCode("opencode/big-pickle"));
    await openWith("click");
    type(document.querySelector<HTMLInputElement>("[data-menu-search]")!, "chutes/deepseek-ai/DeepSeek-V4.1-Flash-1017");
    expect(typedRows()).toEqual([]);
  });
});

describe("picking a model that has reasoning levels", () => {
  it("keeps the menu open on the new model so its level can be set next, and Escape still closes it", async () => {
    render();
    await openWith("ArrowDown");
    press("ArrowDown");
    expect(focused()?.textContent).toContain("Sonnet 5.5");
    press("Enter");
    await settle();

    expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "setModel", selection: expect.objectContaining({ model: "claude-sonnet-5-5" }),
    }));
    expect(menu()).not.toBeNull();
    expect(chip().getAttribute("aria-expanded")).toBe("true");
    expect(menu()!.querySelector('select[aria-label="Reasoning effort"]')).not.toBeNull();

    // The store applies the pick; the picked row may be redrawn elsewhere, but focus stays in the menu.
    render(scout("claude-sonnet-5-5"));
    await settle();
    expect(menu()).not.toBeNull();
    expect(menu()!.contains(focused())).toBe(true);

    press("Escape");
    await settle();
    expect(menu()).toBeNull();
  });
});

describe("DeepSeek thinking choices before a conversation starts", () => {
  it("offers catalog choices, saves the chosen variant, and restores it after remount without session events", async () => {
    const model = "deepseek-official/deepseek-v4-flash";
    const models = { default: model, options: [{ id: model, label: "DeepSeek V4 Flash",
      variants: ["off", "low", "high", "max"].map(id => ({ id, label: id })) }] };
    fixture.instances = [{ instanceId: "deepseek", driverKind: "deepseekAgent", displayName: "DeepSeek Harness",
      snapshot: { state: "available", authenticated: true }, capabilities: { modelVariants: true }, models }];
    const selected = { ...scout(), modelSelection: { instanceId: "deepseek", model } };
    render(selected);
    await openWith("click");
    const select = document.querySelector<HTMLSelectElement>('select[aria-label="Reasoning variant"]')!;
    expect(select).not.toBeNull();
    expect([...select.options].map(option => option.textContent)).toEqual(["Use session setting", "off", "low", "high", "max"]);
    select.value = "1";
    flushSync(() => select.dispatchEvent(new Event("change", { bubbles: true })));
    const saved = fixture.dispatch.mock.lastCall![0];
    expect(saved).toMatchObject({ type: "setModel", botId: selected.id, threadId: selected.threadId,
      selection: { instanceId: "deepseek", model, variant: "low" } });
    flushSync(() => root.unmount());
    root = createRoot(host);
    render({ ...selected, modelSelection: saved.selection });
    await openWith("click");
    const restored = document.querySelector<HTMLSelectElement>('select[aria-label="Reasoning variant"]')!;
    expect(restored.selectedOptions[0].textContent).toBe("low");
  });
});

describe("the floating menu and the pointer", () => {
  it("stays open for a click inside its portal and closes for one outside, without taking focus", async () => {
    await openWith("click");
    const row = document.querySelector<HTMLElement>("[data-model-picker-content] [data-menu-row]")!;
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
    expect(menu()!.style.left).toBe(`${980 - 420}px`);
    right = 952;
    flushSync(() => chip().parentElement!.dispatchEvent(new Event("animationend", { bubbles: true })));
    expect(menu()!.style.left).toBe(`${952 - 420}px`);
    right = 900;
    flushSync(() => menu()!.dispatchEvent(new Event("animationend", { bubbles: true })));
    expect(menu()!.style.left).toBe(`${952 - 420}px`);
  });

  it("moves the keyboard highlight to the row under the mouse once the keyboard is in the list", async () => {
    await openWith("click");
    const rows = [...document.querySelectorAll<HTMLElement>("[data-model-picker-content] [data-menu-row]")];
    flushSync(() => rows[1]!.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" })));
    expect(focused()).toBe(rows[1]);
  });
});

describe("a model the organization turned off", () => {
  const blockedThree: Option[] = three.map((option) => option.id === "claude-sonnet-5-5" ? { ...option, orgBlocked: true } : option);
  const row = () => document.querySelector<HTMLButtonElement>("[data-org-blocked]")!;

  it(`the model picker keeps it visible, disabled, with the reason, and it cannot be picked`, async () => {
    fixture.instances = [claude(blockedThree)];
    render();
    await openWith("click");
    expect(row().disabled).toBe(true);
    expect(row().textContent).toContain("Sonnet 5.5");
    expect(row().textContent).toContain("Turned off by your organization");
    flushSync(() => row().click());
    await settle();
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(menu()).not.toBeNull();
  });

  it(`the model picker: the arrows go past it`, async () => {
    fixture.instances = [claude(blockedThree)];
    render();
    await openWith("ArrowDown");
    press("ArrowDown");
    expect(focused()?.hasAttribute("data-org-blocked")).toBe(false);
    expect(focused()?.textContent).toContain("Haiku 5.5");
  });

  it("the full picker opens on a row it can focus when the selection is the blocked one", async () => {
    fixture.instances = [claude(blockedThree)];
    render(scout("claude-sonnet-5-5"));
    await openWith("ArrowDown");
    expect(focused()?.hasAttribute("data-menu-row")).toBe(true);
    expect((focused() as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("while the bot is working", () => {
  it("opens to the reasoning level only, saves a pick for the next message, and keeps the model locked", async () => {
    const busy = { ...scout(), busy: true };
    fixture.bots = [busy];
    render(busy);
    expect(chip().disabled).toBe(false);
    await openWith("click");
    const panel = menu()!.querySelector<HTMLElement>("[data-model-busy]")!;
    expect(panel.textContent).toContain("Reasoning level applies from the next message");
    expect(panel.textContent).toContain("Stop this thread's turn before changing its model");
    for (const option of three) expect(menu()!.textContent).not.toContain(option.label);
    const effort = panel.querySelector<HTMLSelectElement>("select")!;
    effort.value = "high";
    flushSync(() => effort.dispatchEvent(new Event("change", { bubbles: true })));
    expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "setModel", botId: "scout", threadId: "thread-scout",
      selection: { instanceId: "claude", model: "claude-opus-5-5", effort: "high" },
    }));
  });

  it("keeps a reasoning pick on a thread with its own model to that thread, so the bot's model is not overwritten", async () => {
    const busy = { ...ownModelThread("claude-sonnet-5-5", "claude-opus-5-5"), busy: true };
    fixture.bots = fixture.bots.map((bot) => ({ ...bot, busy: true }));
    render(busy);
    await openWith("click");
    const panel = menu()!.querySelector<HTMLElement>("[data-model-busy]")!;
    expect(panel.textContent).toContain("This thread only. It keeps this model when the bot's model changes.");
    const effort = panel.querySelector<HTMLSelectElement>("select")!;
    effort.value = "high";
    flushSync(() => effort.dispatchEvent(new Event("change", { bubbles: true })));
    const sent = fixture.dispatch.mock.lastCall![0];
    expect(sent).toMatchObject({ type: "setModel", botId: "scout", threadId: "thread-scout",
      selection: { instanceId: "claude", model: "claude-sonnet-5-5", effort: "high" } });
    expect(sent.updateBotDefault).toBeUndefined();
  });

  it("stays locked when the engine has no reasoning level to change", () => {
    fixture.instances = [{ ...claude(three), capabilities: {} }];
    const busy = { ...scout(), busy: true };
    fixture.bots = [busy];
    render(busy);
    expect(chip().disabled).toBe(true);
  });
});

it("keeps the reasoning menu in the same modal layer and accepts a pointer selection", async () => {
  const dialog = document.createElement("dialog");
  document.body.append(dialog);
  dialog.showModal();
  dialog.append(host);
  try {
    await openWith("click");
    const picker = menu()!;
    expect(dialog.contains(picker)).toBe(true);
    const trigger = picker.querySelector<HTMLButtonElement>('button[aria-label="Reasoning effort"]')!;
    flushSync(() => trigger.click());
    await settle();
    const choices = dialog.querySelector<HTMLElement>('[role="menu"][aria-label="Reasoning effort"]')!;
    expect(choices.parentElement).toBe(picker.parentElement);
    expect(choices.classList.contains("z-[81]")).toBe(true);
    const high = [...choices.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(row => row.textContent === "High")!;
    flushSync(() => high.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(menu()).toBe(picker);
    flushSync(() => high.click());
    expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: "setModel", selection: { ...scout().modelSelection, effort: "high" },
    }));
    expect(menu()).toBe(picker);
  } finally {
    dialog.close();
    document.body.append(host);
    dialog.remove();
  }
});
