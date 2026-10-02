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

  it("opens the full picker in the same popover from More", () => {
    const forBot = bot();
    pane(open(forBot))!.props.onMore();
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
    const simple = pane(open(bot()))!;
    expect(simple.props.needsSetup).toEqual({ name: "Claude" });
  });

  it("leaves Advanced mode on the full picker", () => {
    fixture.advanced = true;
    const opened = open(bot());
    expect(pane(opened)).toBeUndefined();
    expect(opened.nodes.some((node) => node.type === ModelEngineRail)).toBe(true);
  });
});
