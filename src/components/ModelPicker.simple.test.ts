import { Children, createElement, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bot, InstanceInfo } from "@/state/store";
import type { EffortLevel } from "../../shared/wire";

// Same hook-by-call-order harness as ModelPicker.interaction.test.ts: the
// picker's own state survives between renders, effects never run, and
// handlers are read off the returned element tree.
const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return {
    advanced: false,
    values: [] as unknown[],
    index: 0,
    own: 0,
    instances: [] as InstanceInfo[],
    dispatch: (() => {}) as (...args: unknown[]) => void,
  };
});
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = typeof initial === "function" ? initial() : initial;
    return [fixture.values[index], (next: unknown) => {
      fixture.values[index] = typeof next === "function" ? next(fixture.values[index]) : next;
    }];
  },
  useEffect: () => {},
}));
vi.mock("./MenuMotion", () => ({ useMenuMotion: (open: boolean) => ({ shown: open, closing: false, className: "" }) }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, setAdvancedMode: () => {} }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  useStore: () => ({
    state: { instances: fixture.instances, bots: [], modelVariantSessions: {} },
    dispatch: fixture.dispatch,
    refreshInstances: () => Promise.resolve(),
    refreshModels: () => Promise.resolve(),
  }),
}));

const { ModelEngineRail, ModelPicker } = await import("./ModelPicker");
const { SimpleModelPane } = await import("./SimpleModelPane");

afterAll(() => vi.unstubAllGlobals());

type Node = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
function nodes(value: ReactNode): Node[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as Node;
    return [node, ...nodes(node.props.children)];
  });
}

const levels: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
const claude = (authenticated = true): InstanceInfo => ({
  instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", access: "subscription",
  snapshot: { state: "available", version: "2.1.300", authenticated },
  models: { default: "claude-opus-5-5", options: [
    { id: "claude-opus-5-5", label: "Opus 5.5" },
    { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
    { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
  ] },
  capabilities: { effortLevels: levels },
  authentication: { method: "paste-code", signOut: true },
  install: { command: { darwin: "npm i -g @anthropic-ai/claude-code", linux: "npm i -g @anthropic-ai/claude-code", win32: "npm i -g @anthropic-ai/claude-code" }, signInCommand: "claude" },
});

function bot(effort?: EffortLevel): Bot {
  return {
    id: "scout", threadId: "thread-scout", name: "Scout", title: "", description: "", notifications: true,
    color: "green", unread: false, messages: [],
    modelSelection: { instanceId: "claude", model: "claude-opus-5-5", ...(effort ? { effort } : {}) },
  };
}

function render(forBot: Bot) {
  fixture.values.length = Math.min(fixture.values.length, fixture.own);
  let tree: ReactNode = null;
  function Capture() {
    fixture.index = 0;
    tree = ModelPicker({ bot: forBot, threadId: forBot.threadId });
    fixture.own = fixture.index;
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, nodes: nodes(tree) };
}

function open(forBot: Bot) {
  const trigger = render(forBot).nodes.find((node) => node.props["data-tour"] === "model")!;
  (trigger.props.onClick as () => void)();
  return render(forBot);
}

const pane = (rendered: ReturnType<typeof render>) =>
  rendered.nodes.find((node) => node.type === SimpleModelPane) as ReactElement<ComponentProps<typeof SimpleModelPane>> | undefined;
const menu = (html: string) => html.slice(html.indexOf("data-model-picker-content"));
// The pane itself uses no hooks, so its own element tree can be walked too.
const inside = (rendered: ReturnType<typeof render>) => nodes(SimpleModelPane(pane(rendered)!.props));
const region = (html: string, marker: string, next?: string) =>
  html.slice(html.indexOf(marker), next ? html.indexOf(next) : undefined);

beforeEach(() => {
  fixture.advanced = false;
  fixture.values = [];
  fixture.index = 0;
  fixture.own = 0;
  fixture.instances = [claude()];
  fixture.dispatch = vi.fn();
});

describe("the model picker in Simple mode", () => {
  it("opens on providers, named models and plain effort steps instead of the rail", () => {
    const opened = open(bot("high"));
    const html = menu(opened.html);
    expect(pane(opened)).toBeDefined();
    expect(opened.nodes.some((node) => node.type === ModelEngineRail)).toBe(false);
    expect(html).toContain("Claude");
    expect(html).toContain("Opus 5.5");
    expect(html).toContain("Smartest. Best for hard, long jobs.");
    expect(html).toContain("How hard should Scout think?");
    for (const step of ["Quick", "Balanced", "Deep", "Max"]) expect(html).toContain(`>${step}</button>`);
    expect(html).not.toContain(">Deeper</button>");
    expect(html).toContain("Use for Scout&#x27;s new chats too");
  });

  it("lays providers out in a column, models beside them, and effort along the bottom", () => {
    const html = menu(open(bot("high")).html);
    const providers = html.indexOf("data-simple-providers");
    const models = html.indexOf("data-simple-models");
    const band = html.indexOf("data-simple-effort-band");
    expect(providers).toBeGreaterThan(-1);
    expect(models).toBeGreaterThan(providers);
    expect(band).toBeGreaterThan(models);

    const column = region(html, "data-simple-providers", "data-simple-models");
    expect(column).toContain(">Claude</span>");
    expect(column).toContain("data-simple-model-more");
    expect(column).not.toContain("Opus 5.5");
    expect(column.indexOf("data-simple-model-more")).toBeGreaterThan(column.indexOf(">Claude</span>"));

    const list = region(html, "data-simple-models", "data-simple-effort-band");
    expect(list).toContain("Opus 5.5");
    expect(list).toContain("Sonnet 5.5");
    expect(list).not.toContain("How hard should Scout think?");

    const bottom = region(html, "data-simple-effort-band");
    expect(bottom).toContain("How hard should Scout think?");
    expect(bottom).toContain(">Deep</button>");
    expect(bottom).toContain("Use for Scout&#x27;s new chats too");
    expect(bottom).toContain("Manage AI accounts");
  });

  it("keeps the old footer's words only as More's label", () => {
    const opened = open(bot());
    expect(menu(opened.html)).not.toContain(">All models, API keys, local models<");
    const more = inside(opened).find((node) => node.props["data-simple-model-more"] !== undefined)!;
    expect(more.props.title).toBe("All models, API keys, local models");
    expect(more.props["aria-label"]).toContain("All models, API keys, local models");
  });

  it("marks the browsed provider and switches provider from its row", () => {
    const opened = open(bot());
    const rows = inside(opened).filter((node) => node.type === "button" && node.props["aria-pressed"] !== undefined);
    const claudeRow = rows.find((node) => nodes(node.props.children).some((child) => child.props.children === "Claude"))!;
    expect(claudeRow.props["aria-pressed"]).toBe(true);
    const onProvider = vi.fn();
    const own = SimpleModelPane({ ...pane(opened)!.props, onProvider });
    const row = nodes(own).find((node) => node.props["aria-pressed"] === true && nodes(node.props.children).some((child) => child.props.children === "Claude"))!;
    (row.props.onClick as () => void)();
    expect(onProvider).toHaveBeenCalledWith(expect.objectContaining({ instanceId: "claude" }));
  });

  it("names the effort in plain words on the header chip", () => {
    expect(render(bot("high")).html).toContain("· Deep");
    fixture.advanced = true;
    expect(render(bot("high")).html).toContain("· High");
  });

  it("changes only this chat by default, and the bot's default when asked", () => {
    const forBot = bot();
    pane(open(forBot))!.props.onPick("claude-sonnet-5-5");
    expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "setModel", botId: "scout", threadId: "thread-scout", updateBotDefault: false,
      selection: expect.objectContaining({ instanceId: "claude", model: "claude-sonnet-5-5" }),
    }));

    const reopened = open(forBot);
    pane(reopened)!.props.newChats!.onChange(true);
    pane(render(forBot))!.props.onPick("claude-haiku-4-5-20251001");
    expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ updateBotDefault: true }));
  });

  it("writes the real effort level behind a friendly step", () => {
    pane(open(bot()))!.props.effort!.onPick("high");
    expect(fixture.dispatch).toHaveBeenLastCalledWith({
      type: "setModel", botId: "scout", threadId: "thread-scout",
      selection: { instanceId: "claude", model: "claude-opus-5-5", effort: "high" },
    });
  });

  it("keeps an unusual level the bot already uses visible", () => {
    expect(pane(open(bot("xhigh")))!.props.effort!.levels).toContain("xhigh");
  });

  it("opens the full picker in the same popover from the More row", () => {
    const forBot = bot();
    const more = inside(open(forBot)).find((node) => node.props["data-simple-model-more"] !== undefined)!;
    (more.props.onClick as () => void)();
    const full = render(forBot);
    expect(pane(full)).toBeUndefined();
    expect(full.nodes.some((node) => node.type === ModelEngineRail)).toBe(true);
  });

  it("starts over in the Simple view the next time it opens", () => {
    const forBot = bot();
    pane(open(forBot))!.props.onMore();
    const trigger = render(forBot).nodes.find((node) => node.props["data-tour"] === "model")!;
    (trigger.props.onClick as () => void)(); // close
    expect(pane(open(forBot))).toBeDefined();
  });

  it("sends a provider that needs sign-in to the full picker's setup", () => {
    fixture.instances = [claude(false)];
    const opened = open(bot());
    const simple = pane(opened)!;
    expect(simple.props.needsSetup).toEqual({ name: "Claude" });
    const html = menu(opened.html);
    const list = region(html, "data-simple-models", "data-simple-effort-band");
    expect(list).toContain("Claude needs to be set up before you can use it.");
    expect(list).toContain(">Set up</button>");
    expect(list).not.toContain("Opus 5.5");
    expect(region(html, "data-simple-providers", "data-simple-models")).toContain(">Claude</span>");
  });

  it("says so when the browsed provider has no models to list", () => {
    const html = renderToStaticMarkup(createElement(SimpleModelPane, { ...pane(open(bot()))!.props, models: [] }));
    expect(region(html, "data-simple-models", "data-simple-effort-band")).toContain("No models to show here yet.");
  });

  it("opens AI accounts from the bottom band", () => {
    const opened = open(bot());
    const manage = inside(opened).find((node) => node.props["data-simple-manage"] !== undefined)!;
    (manage.props.onClick as () => void)();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "toggleAppSettings", open: true, section: "engines" });
  });

  it("puts a named-variants control in the band in place of the effort steps", () => {
    const opened = open(bot());
    const variants = createElement("span", { "data-variants": "" }, "Reasoning");
    const html = renderToStaticMarkup(createElement(SimpleModelPane, { ...pane(opened)!.props, variantsRow: variants }));
    const bottom = region(html, "data-simple-effort-band");
    expect(bottom).toContain("Reasoning");
    expect(bottom).not.toContain("How hard should Scout think?");
  });

  it("leaves Advanced mode on the full picker", () => {
    fixture.advanced = true;
    const opened = open(bot());
    expect(pane(opened)).toBeUndefined();
    expect(opened.nodes.some((node) => node.type === ModelEngineRail)).toBe(true);
  });
});
