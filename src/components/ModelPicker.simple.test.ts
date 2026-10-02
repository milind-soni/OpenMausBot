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

const { ModelEngineRail, ModelPicker, ModelVariantRow, SIMPLE_POPOVER_WIDTH } = await import("./ModelPicker");
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

type Option = InstanceInfo["models"]["options"][number];
const levels: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
const claudeModels: Option[] = [
  { id: "claude-opus-5-5", label: "Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
];
const claude = (authenticated = true, options: Option[] = claudeModels): InstanceInfo => ({
  instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", access: "subscription",
  snapshot: { state: "available", version: "2.1.300", authenticated },
  models: { default: "claude-opus-5-5", options },
  capabilities: { effortLevels: levels },
  authentication: { method: "paste-code", signOut: true },
  install: { command: { darwin: "npm i -g @anthropic-ai/claude-code", linux: "npm i -g @anthropic-ai/claude-code", win32: "npm i -g @anthropic-ai/claude-code" }, signInCommand: "claude" },
});
const engine = (instanceId: string, driverKind: string, displayName: string, access: InstanceInfo["access"], options: Option[]): InstanceInfo => ({
  instanceId, driverKind, displayName, access,
  snapshot: { state: "available", version: "1.0.0", authenticated: true },
  models: { default: options.find((option) => !option.custom)?.id ?? "", options },
});
const codex = engine("codex", "codex", "Codex", "subscription", [{ id: "gpt-5.6", label: "GPT-5.6" }]);
const grok = engine("grok", "grokAgent", "Grok", "subscription", [{ id: "grok-5", label: "Grok 5" }]);
const cursor = engine("cursor", "cursorAgent", "Cursor", "subscription", [{ id: "auto", label: "Auto" }]);
const openaiKey = engine("openai", "openai-compat", "OpenAI", "api", [{ id: "gpt-5.6", label: "GPT-5.6" }]);
const claudeKey = engine("claudeApi", "claudeAgent", "Claude (API key)", "api", claudeModels);
/** A local engine: Llama and Gemma are loaded in memory right now. */
const local = engine("pi", "piAgent", "pi", "custom", [
  { id: "qwen", label: "Qwen 3", custom: true },
  { id: "mistral", label: "Mistral Small", custom: true },
  { id: "phi", label: "Phi 4", custom: true },
  { id: "llama", label: "Llama 4", custom: true, loaded: true },
  { id: "deepseek", label: "DeepSeek R2", custom: true },
  { id: "gemma", label: "Gemma 4", custom: true, loaded: true },
  { id: "granite", label: "Granite 4", custom: true },
]);
const many = (count: number): Option[] =>
  Array.from({ length: count }, (_, index) => ({ id: `model-${index + 1}`, label: `Model ${index + 1}` }));

function bot(effort?: EffortLevel, instanceId = "claude", model = "claude-opus-5-5"): Bot {
  return {
    id: "scout", threadId: "thread-scout", name: "Scout", title: "", description: "", notifications: true,
    color: "green", unread: false, messages: [],
    modelSelection: { instanceId, model, ...(effort ? { effort } : {}) },
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
const labels = (rendered: ReturnType<typeof render>) => pane(rendered)!.props.models.map((option) => option.label);
const click = (node: Node | undefined) => (node!.props.onClick as () => void)();

beforeEach(() => {
  fixture.advanced = false;
  fixture.values = [];
  fixture.index = 0;
  fixture.own = 0;
  fixture.instances = [claude()];
  fixture.dispatch = vi.fn();
});

describe("the model picker in Simple mode", () => {
  it("opens on providers, model names and plain effort steps instead of the rail", () => {
    const opened = open(bot("high"));
    const html = menu(opened.html);
    expect(pane(opened)).toBeDefined();
    expect(opened.nodes.some((node) => node.type === ModelEngineRail)).toBe(false);
    expect(html).toContain("Claude");
    expect(html).toContain("Opus 5.5");
    for (const step of ["Quick", "Balanced", "Deep", "Max"]) expect(html).toContain(`>${step}</button>`);
    expect(html).not.toContain(">Deeper</button>");
    expect(html).toContain("Use for Scout&#x27;s new chats too");
  });

  it("is a narrow popover, and the full picker keeps its own width", () => {
    expect(SIMPLE_POPOVER_WIDTH).toBe(380);
    fixture.instances = [claude(false)];
    const forBot = bot();
    const opened = open(forBot);
    expect(menu(opened.html)).toContain("width:380px");
    click(inside(opened).find((node) => node.props["data-simple-set-up"] !== undefined));
    expect(menu(render(forBot).html)).toContain("width:420px");
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
    expect(column).not.toContain("Opus 5.5");

    const list = region(html, "data-simple-models", "data-simple-effort-band");
    expect(list).toContain("Opus 5.5");
    expect(list).toContain("Sonnet 5.5");
    expect(list).not.toContain(">Deep</button>");

    const bottom = region(html, "data-simple-effort-band");
    expect(bottom).toContain(">Deep</button>");
    expect(bottom).toContain("Use for Scout&#x27;s new chats too");
    expect(bottom).toContain("Manage AI accounts");
  });

  it("lists every provider it knows: sign-ins, then API keys, then local engines", () => {
    fixture.instances = [claude(), codex, grok, cursor, openaiKey, claudeKey, local];
    const opened = open(bot());
    expect(pane(opened)!.props.providers.map((provider) => provider.label))
      .toEqual(["Claude", "OpenAI", "Grok", "Cursor", "OpenAI", "Claude (API key)", "pi"]);
    const column = region(menu(opened.html), "data-simple-providers", "data-simple-models");
    for (const name of ["Claude", "OpenAI", "Grok", "Cursor", "Claude (API key)", "pi"]) expect(column).toContain(`>${name}</span>`);
    expect(column.match(/data-simple-key/g)).toHaveLength(2);

    // The two OpenAI rows differ by the key alone.
    const rows = inside(opened).filter((node) => node.props["data-simple-provider"] !== undefined);
    const byId = (id: string) => rows.find((node) => node.props["data-simple-provider"] === id)!;
    expect(byId("openai").props["aria-label"]).toBe("OpenAI · API key");
    expect(byId("openai").props.title).toContain("Runs on your API key");
    expect(nodes(byId("openai").props.children).some((node) => node.props["data-simple-key"] !== undefined)).toBe(true);
    expect(byId("codex").props["aria-label"]).toBeUndefined();
    expect(nodes(byId("codex").props.children).some((node) => node.props["data-simple-key"] !== undefined)).toBe(false);
    expect(nodes(byId("pi").props.children).some((node) => node.props["data-simple-key"] !== undefined)).toBe(false);
  });

  it("has no More row: there is nothing past the providers and models", () => {
    fixture.instances = [claude(), codex, grok, cursor, openaiKey, local];
    const opened = open(bot());
    const html = menu(opened.html);
    expect(html).not.toContain("data-simple-model-more");
    expect(html).not.toMatch(/>More</);
    expect(html).not.toContain("All models, API keys, local models");
    expect(pane(opened)!.props).not.toHaveProperty("onMore");
  });

  it("names models without a second line; a blurb is only the row's tooltip", () => {
    const opened = open(bot());
    const blurb = "Smartest. Best for hard, long jobs.";
    expect(menu(opened.html)).not.toContain(`>${blurb}<`);
    expect(inside(opened).some((node) => node.props.children === blurb)).toBe(false);
    const opus = inside(opened).find((node) => node.type === "button" && node.props.title === `Opus 5.5 · ${blurb}`);
    expect(opus).toBeDefined();
    expect(nodes(opus!.props.children).map((node) => node.props.children)).toContain("Opus 5.5");
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

  it("opens a long list in place with Show all, and a search box once it is very long", () => {
    fixture.instances = [claude(true, many(15))];
    const forBot = bot(undefined, "claude", "model-1");
    const opened = open(forBot);
    const suggested = labels(opened);
    expect(suggested).toHaveLength(5);
    expect(pane(opened)!.props.showAll!.count).toBe(15);
    expect(pane(opened)!.props.search).toBeUndefined();
    expect(region(menu(opened.html), "data-simple-models", "data-simple-effort-band")).toContain("Show all 15 models");

    click(inside(opened).find((node) => node.props["data-simple-show-all"] !== undefined));
    const all = render(forBot);
    expect(labels(all)).toHaveLength(15);
    expect(labels(all).slice(0, 5)).toEqual(suggested);
    expect(pane(all)!.props.showAll).toBeNull();
    expect(menu(all.html)).not.toContain("Show all 15 models");
    const html = region(menu(all.html), "data-simple-models", "data-simple-effort-band");
    expect(html.indexOf("data-simple-model-search")).toBeLessThan(html.indexOf("Model 1<"));
    expect(html).toContain('aria-label="Search models"');

    const search = pane(all)!.props.search as ReactElement<{ onChange: (value: string) => void }>;
    search.props.onChange("model 1");
    expect(labels(render(forBot))).toEqual(["Model 1", "Model 10", "Model 11", "Model 12", "Model 13", "Model 14", "Model 15"]);
    search.props.onChange("zzz");
    const none = render(forBot);
    expect(labels(none)).toEqual([]);
    expect(menu(none.html)).toContain("Nothing matches “zzz”");
  });

  it("opens a shorter list in place without a search box", () => {
    fixture.instances = [claude(true, many(8))];
    const forBot = bot(undefined, "claude", "model-1");
    click(inside(open(forBot)).find((node) => node.props["data-simple-show-all"] !== undefined));
    const all = render(forBot);
    expect(labels(all)).toHaveLength(8);
    expect(pane(all)!.props.search).toBeUndefined();
    expect(menu(all.html)).not.toContain("data-simple-model-search");
  });

  it("lists a local engine's models the same way, loaded ones first", () => {
    fixture.instances = [claude(), local];
    const forBot = bot();
    pane(open(forBot))!.props.onProvider(local);
    const browsed = render(forBot);
    expect(pane(browsed)!.props.needsSetup).toBeNull();
    expect(labels(browsed)).toEqual(["Llama 4", "Gemma 4", "Qwen 3", "Mistral Small", "Phi 4"]);
    expect(pane(browsed)!.props.showAll!.count).toBe(7);
    pane(browsed)!.props.showAll!.onShow();
    expect(labels(render(forBot))).toEqual(["Llama 4", "Gemma 4", "Qwen 3", "Mistral Small", "Phi 4", "DeepSeek R2", "Granite 4"]);
    pane(render(forBot))!.props.onPick("granite");
    expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "setModel", selection: expect.objectContaining({ instanceId: "pi", model: "granite" }),
    }));
  });

  it("keeps a provider's local models reachable after its own", () => {
    const own = many(6);
    const onThisMac: Option[] = [{ id: "ollama::qwen3", label: "qwen3 (Ollama)", custom: true }, { id: "ollama::llama4", label: "llama4 (Ollama)", custom: true, loaded: true }];
    fixture.instances = [claude(true, [...own, ...onThisMac])];
    const forBot = bot(undefined, "claude", "model-1");
    const opened = open(forBot);
    expect(labels(opened)).toEqual(["Model 1", "Model 2", "Model 3", "Model 4", "Model 5"]);
    pane(opened)!.props.showAll!.onShow();
    expect(labels(render(forBot))).toEqual([...own.map((option) => option.label), "llama4 (Ollama)", "qwen3 (Ollama)"]);
  });

  it("lists only local models on a signed-out engine whose bot runs one", () => {
    fixture.instances = [claude(false, [...claudeModels, { id: "ollama::qwen3", label: "qwen3 (Ollama)", custom: true }])];
    const opened = open(bot(undefined, "claude", "ollama::qwen3"));
    expect(pane(opened)!.props.needsSetup).toBeNull();
    expect(labels(opened)).toEqual(["qwen3 (Ollama)"]);
  });

  it("spans the effort steps across the whole bottom band, with no question above them", () => {
    const opened = open(bot("high"));
    const tree = inside(opened);
    const band = tree.find((node) => node.props["data-simple-effort-band"] !== undefined)!;
    const steps = Children.toArray(band.props.children).filter(isValidElement) as Node[];
    const effort = steps.find((node) => node.props["data-simple-effort"] !== undefined)!;
    expect(effort).toBeDefined();
    expect(String(effort.props.className)).toContain("w-full");
    expect(effort.props.role).toBe("group");
    expect(effort.props["aria-label"]).toBe("Reasoning effort");
    const html = menu(opened.html);
    expect(html).not.toContain("How hard should");
    expect(region(html, "data-simple-effort-band")).toContain('aria-label="Reasoning effort"');
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

  it("opens the full picker in the same popover from Set up", () => {
    fixture.instances = [claude(false)];
    const forBot = bot();
    click(inside(open(forBot)).find((node) => node.props["data-simple-set-up"] !== undefined));
    const full = render(forBot);
    expect(pane(full)).toBeUndefined();
    expect(full.nodes.some((node) => node.type === ModelEngineRail)).toBe(true);
  });

  it("starts over in the Simple view the next time it opens", () => {
    fixture.instances = [claude(false)];
    const forBot = bot();
    pane(open(forBot))!.props.onSetUp();
    const trigger = render(forBot).nodes.find((node) => node.props["data-tour"] === "model")!;
    (trigger.props.onClick as () => void)(); // close
    expect(pane(open(forBot))).toBeDefined();
  });

  it("says so when the browsed provider has no models to list", () => {
    const html = renderToStaticMarkup(createElement(SimpleModelPane, { ...pane(open(bot()))!.props, models: [] }));
    const list = region(html, "data-simple-models", "data-simple-effort-band");
    expect(list).toContain("No models to show here yet.");
    expect(list).not.toContain("More");
  });

  it("says so when there is no provider at all", () => {
    fixture.instances = [];
    const html = menu(open(bot()).html);
    expect(region(html, "data-simple-models", "data-simple-effort-band")).toContain("No model providers are available.");
  });

  it("opens AI accounts from the bottom band", () => {
    const opened = open(bot());
    const manage = inside(opened).find((node) => node.props["data-simple-manage"] !== undefined)!;
    (manage.props.onClick as () => void)();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "toggleAppSettings", open: true, section: "engines" });
  });

  it("puts a full-width named-variants control in the band in place of the effort steps", () => {
    const variants = [{ id: "default", label: "Default" }, { id: "high", label: "High" }];
    fixture.instances = [{ ...claude(true, [{ id: "claude-opus-5-5", label: "Opus 5.5", variants }]), capabilities: { modelVariants: true } }];
    const opened = open(bot());
    const row = pane(opened)!.props.variantsRow as ReactElement<ComponentProps<typeof ModelVariantRow>>;
    expect(row.type).toBe(ModelVariantRow);
    expect(row.props).toMatchObject({ compact: true, wide: true });
    expect(row.props.label).toBeUndefined();
    const bottom = region(menu(opened.html), "data-simple-effort-band");
    const select = bottom.slice(bottom.indexOf("<select"), bottom.indexOf(">", bottom.indexOf("<select")));
    expect(select).toContain('aria-label="Reasoning variant"');
    expect(select).toContain("flex-1");
    expect(select).not.toContain("max-w-[65%]");
    expect(bottom).not.toContain(">Quick</button>");
    expect(bottom).not.toContain("How hard should");
  });

  it("leaves Advanced mode on the full picker", () => {
    fixture.advanced = true;
    const opened = open(bot());
    expect(pane(opened)).toBeUndefined();
    expect(opened.nodes.some((node) => node.type === ModelEngineRail)).toBe(true);
  });
});
