import { Children, createElement, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bot, InstanceInfo } from "@/state/store";
import type { EffortLevel } from "../../shared/wire";
import type { MenuGroup, SimpleMenu } from "@/lib/simple-model-menu";
import type { SimpleThinking } from "./SimpleModelMenu";
import { Select } from "./Select";

// Hook-by-call-order harness: the picker's own state survives between renders, effects never run, and handlers are read
// off the element tree.
const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return {
    advanced: false,
    cloudHome: false,
    ownerOrAdmin: true as boolean | null,
    values: [] as unknown[],
    index: 0,
    own: 0,
    instances: [] as InstanceInfo[],
    bots: [] as Bot[],
    dispatch: (() => {}) as (...args: unknown[]) => void,
    refreshModels: (() => Promise.resolve()) as (instanceId: string) => Promise<void>,
    refreshInstances: (() => Promise.resolve()) as () => Promise<void>,
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
vi.mock("./MenuMotion", () => ({ useMenuMotion: (open: boolean) => ({ shown: open, closing: false, className: "", exitProps: {} }) }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, setAdvancedMode: () => {} }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.ownerOrAdmin }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  useStore: () => ({
    state: { instances: fixture.instances, bots: fixture.bots, modelVariantSessions: {}, config: { cloudHome: fixture.cloudHome } },
    dispatch: fixture.dispatch,
    refreshInstances: fixture.refreshInstances,
    refreshModels: fixture.refreshModels,
  }),
}));

const { ModelPicker, ModelVariantRow, SIMPLE_POPOVER_WIDTH } = await import("./ModelPicker");
const { FollowBotModelRow, ModelEngineRail, ModelRow } = await import("./ModelPickerFull");
const { SimpleModelMenu } = await import("./SimpleModelMenu");
const { EngineSetup } = await import("./EngineSetup");

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

function render(forBot: Bot, options: { contained?: boolean; thread?: boolean } = {}) {
  fixture.values.length = Math.min(fixture.values.length, fixture.own);
  let tree: ReactNode = null;
  function Capture() {
    fixture.index = 0;
    tree = options.contained
      ? ModelPicker({ bot: forBot, contained: true, label: "Default model", ...(options.thread ? { threadId: forBot.threadId } : {}) })
      : ModelPicker({ bot: forBot, threadId: forBot.threadId });
    fixture.own = fixture.index;
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, nodes: nodes(tree) };
}

function open(forBot: Bot, options: { contained?: boolean; thread?: boolean } = {}) {
  const trigger = render(forBot, options).nodes.find((node) => node.props["data-tour"] === "model")!;
  (trigger.props.onClick as () => void)();
  return render(forBot, options);
}

type Rendered = ReturnType<typeof render>;
const pane = (rendered: Rendered) =>
  rendered.nodes.find((node) => node.type === SimpleModelMenu) as ReactElement<ComponentProps<typeof SimpleModelMenu>> | undefined;
const list = (rendered: Rendered): SimpleMenu => pane(rendered)!.props.menu;
const menu = (html: string) => html.slice(html.indexOf("data-model-picker-content"));
const region = (html: string, marker: string, next?: string) =>
  html.slice(html.indexOf(marker), next ? html.indexOf(next) : undefined);
const group = (rendered: Rendered, instanceId: string): MenuGroup | undefined =>
  list(rendered).groups.find((entry) => entry.instance.instanceId === instanceId);
const labels = (rendered: Rendered, instanceId = "claude") => {
  const body = group(rendered, instanceId)?.body;
  return body?.kind === "models" ? body.rows.map((row) => row.label) : [];
};
const instance = (instanceId: string) => fixture.instances.find((entry) => entry.instanceId === instanceId)!;
const toggle = (rendered: Rendered, instanceId = "claude") => pane(rendered)!.props.onToggle(instance(instanceId));
const thinking = (rendered: Rendered) => pane(rendered)!.props.thinking as Extract<SimpleThinking, { levels: readonly EffortLevel[] }>;
const click = (node: Node | undefined) => (node!.props.onClick as (event: { detail: number }) => void)({ detail: 1 });

beforeEach(() => {
  fixture.advanced = false;
  fixture.cloudHome = false;
  fixture.ownerOrAdmin = true;
  fixture.values = [];
  fixture.index = 0;
  fixture.own = 0;
  fixture.instances = [claude()];
  fixture.bots = [];
  fixture.dispatch = vi.fn();
  fixture.refreshModels = vi.fn(() => Promise.resolve());
  fixture.refreshInstances = vi.fn(() => Promise.resolve());
});

describe("the model picker in Simple mode", () => {
  it("opens one calm list: the current model on top, its provider's other models below, then Thinking and a way to accounts", () => {
    const opened = open(bot("high"));
    const html = menu(opened.html);
    expect(opened.nodes.some((node) => node.type === ModelEngineRail)).toBe(false);
    const current = html.indexOf("data-current-model");
    const provider = html.indexOf('data-simple-provider="claude"');
    const band = html.indexOf("data-simple-effort-band");
    expect(current).toBeGreaterThan(-1);
    expect(provider).toBeGreaterThan(current);
    expect(band).toBeGreaterThan(provider);
    expect(region(html, "data-current-model", 'data-simple-provider="claude"')).toContain(">Opus 5.5</span>");
    expect(labels(opened)).toEqual(["Sonnet 5.5", "Haiku 4.5"]);
    const bottom = region(html, "data-simple-effort-band");
    for (const step of ["Low", "Medium", "High", "X-High", "Max"]) expect(bottom).toContain(`>${step}</button>`);
    expect(bottom).toContain(">Thinking</span>");
    expect(bottom).toContain("Manage AI accounts");
    expect(html).not.toContain(">Quick</button>");
    expect(html).not.toContain("new chats too");
  });

  it("is a 300px menu on the shared menu surface, and the full picker keeps its own 420px", () => {
    expect(SIMPLE_POPOVER_WIDTH).toBe(300);
    fixture.instances = [claude(false)];
    const forBot = bot();
    const opened = open(forBot);
    const content = opened.nodes.find((node) => node.props["data-model-picker-content"] !== undefined)!;
    expect(String(content.props.className)).toContain("menu-surface");
    expect(String(content.props.className)).not.toMatch(/\bborder\b|shadow-2xl|rounded-2xl/);
    expect(menu(opened.html)).toContain("width:300px");
    pane(opened)!.props.onSetUp(instance("claude"), false);
    expect(menu(render(forBot).html)).toContain("width:420px");
  });

  it("lists every ready provider at once: the current one first, then sign-ins, API keys and local engines", () => {
    fixture.instances = [codex, grok, cursor, openaiKey, claudeKey, local, claude()];
    const opened = open(bot());
    expect(list(opened).groups.map((entry) => entry.label))
      .toEqual(["Claude", "OpenAI", "Grok", "Cursor", "OpenAI · API key", "Claude · API key", "pi"]);
    const html = menu(opened.html);
    for (const name of ["OpenAI", "Grok", "Cursor", "OpenAI · API key", "Claude · API key", "pi"]) expect(html).toContain(`>${name}</span>`);
    expect(html).not.toContain("data-simple-key");
    expect(html).not.toContain("(API key)");
    expect(labels(opened, "codex")).toEqual(["GPT-5.6"]);
    expect(labels(opened, "pi")).toEqual(["Llama 4", "Gemma 4", "Qwen 3"]);
  });

  it("has no More row: the full picker opens only from a provider that needs setting up", () => {
    fixture.instances = [claude(), codex, grok, cursor, openaiKey, local];
    const opened = open(bot());
    const html = menu(opened.html);
    expect(html).not.toContain("data-simple-model-more");
    expect(html).not.toMatch(/>More( options)?</);
    expect(html).not.toContain("data-simple-set-up");
    expect(pane(opened)!.props).not.toHaveProperty("onMore");
  });

  it("names a model in short under its provider, and in full on the chip, in the tooltip and to a screen reader", () => {
    const named: Option[] = [{ id: "sonnet-5", label: "Claude Sonnet 5" }, { id: "opus-5-5", label: "Claude Opus 5.5" }];
    fixture.instances = [{ ...claude(true, named), models: { default: "sonnet-5", options: named } }];
    const forBot = bot(undefined, "claude", "sonnet-5");
    const opened = open(forBot);
    expect(labels(opened)).toEqual(["Opus 5.5"]);
    const html = menu(opened.html);
    expect(html).toContain('aria-label="Claude Opus 5.5"');
    expect(html).toContain(">Opus 5.5</span>");
    expect(region(html, "data-current-model", "data-simple-provider")).toContain(">Claude Sonnet 5</span>");
    const chip = render(forBot).nodes.find((node) => node.props["data-tour"] === "model")!;
    expect(String(chip.props.title)).toContain("Claude · Claude Sonnet 5");
    expect(renderToStaticMarkup(chip)).toContain(">Claude Sonnet 5</span>");
  });

  it("names models without a second line; a blurb is only the row's tooltip", () => {
    const html = menu(open(bot()).html);
    const blurb = "Fast and smart. Good for most work.";
    expect(html).not.toContain(`>${blurb}<`);
    expect(html).toContain(`title="Sonnet 5.5 · ${blurb}"`);
  });

  it("opens a provider's long list in place with Show all, and offers a search once the menu holds more than twelve models", () => {
    fixture.instances = [claude(true, many(15))];
    const forBot = bot(undefined, "claude", "model-1");
    const opened = open(forBot);
    const suggested = labels(opened);
    expect(suggested).toEqual(["Model 2", "Model 3", "Model 4", "Model 5"]);
    expect(group(opened, "claude")!.body).toMatchObject({ toggle: "more", total: 15 });
    expect(list(opened).search).toBe(true);
    const html = menu(opened.html);
    expect(html).toContain("Show all 15 models");
    expect(html).not.toContain("scroll-pt-8");
    expect(html.indexOf("data-simple-model-search")).toBeLessThan(html.indexOf("data-current-model"));
    expect(html).toContain('aria-label="Search models"');

    toggle(opened);
    const all = render(forBot);
    expect(labels(all)).toHaveLength(14);
    expect(labels(all).slice(0, 4)).toEqual(suggested);
    expect(menu(all.html)).toContain('aria-expanded="true"');
    expect(menu(all.html)).toContain("Show suggested only");
    expect(menu(all.html)).toContain("sticky bottom-0");
    expect(menu(all.html)).toMatch(/data-simple-models="true" class="[^"]*scroll-pt-8 scroll-pb-12/);
    expect(menu(all.html).match(/data-simple-models="true" class="([^"]*)"/)![1]).not.toMatch(/(^|\s)p[tbxy]?-/);
    expect(menu(all.html)).not.toContain("before:");

    pane(all)!.props.onQuery("model 1");
    const searched = render(forBot);
    expect(list(searched).current).toBeNull();
    expect(labels(searched)).toEqual(["Model 1", "Model 10", "Model 11", "Model 12", "Model 13", "Model 14", "Model 15"]);
    expect(menu(searched.html)).toContain("7 results");
    pane(searched)!.props.onQuery("zzz");
    const none = render(forBot);
    expect(list(none).groups).toEqual([]);
    expect(menu(none.html)).toContain("Nothing matches “zzz”");
  });

  it("folds an opened list back from the same row", () => {
    fixture.instances = [claude(true, many(8))];
    const forBot = bot(undefined, "claude", "model-1");
    toggle(open(forBot));
    const opened = render(forBot);
    expect(labels(opened)).toHaveLength(7);
    toggle(opened);
    const folded = render(forBot);
    expect(labels(folded)).toHaveLength(4);
    expect(group(folded, "claude")!.body).toMatchObject({ toggle: "more", total: 8 });
    expect(menu(folded.html)).toContain('aria-expanded="false"');
    expect(list(folded).search).toBe(false);
    expect(menu(folded.html)).not.toContain("data-simple-model-search");
  });

  it("lists a local engine's models the same way, loaded ones first, and picks one", () => {
    fixture.instances = [claude(), local];
    const forBot = bot();
    const opened = open(forBot);
    expect(labels(opened, "pi")).toEqual(["Llama 4", "Gemma 4", "Qwen 3"]);
    toggle(opened, "pi");
    expect(labels(render(forBot), "pi")).toEqual(["Llama 4", "Gemma 4", "Qwen 3", "Mistral Small", "Phi 4", "DeepSeek R2", "Granite 4"]);
    pane(render(forBot))!.props.onPick(local, "granite");
    expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "setModel", selection: expect.objectContaining({ instanceId: "pi", model: "granite" }),
    }));
  });

  it("keeps a provider's local models after its own, under a quiet Local models label", () => {
    const own = many(6);
    const onThisMac: Option[] = [{ id: "ollama::qwen3", label: "qwen3 (Ollama)", custom: true }, { id: "ollama::llama4", label: "llama4 (Ollama)", custom: true, loaded: true }];
    fixture.instances = [claude(true, [...own, ...onThisMac])];
    const forBot = bot(undefined, "claude", "model-1");
    toggle(open(forBot));
    const all = render(forBot);
    expect(labels(all)).toEqual(["Model 2", "Model 3", "Model 4", "Model 5", "Model 6", "llama4 (Ollama)", "qwen3 (Ollama)"]);
    expect(group(all, "claude")!.body).toMatchObject({ localFrom: 5 });
    const html = region(menu(all.html), 'data-simple-provider="claude"', "data-simple-effort-band");
    expect(html.indexOf(">Local models</div>")).toBeGreaterThan(html.indexOf(">Model 6</span>"));
    expect(html.indexOf(">Local models</div>")).toBeLessThan(html.indexOf(">llama4 (Ollama)</span>"));
  });

  it("keeps a signed-out engine's local model on top, with a way to sign in for its own", () => {
    fixture.instances = [claude(false, [...claudeModels, { id: "ollama::qwen3", label: "qwen3 (Ollama)", custom: true }])];
    const forBot = bot(undefined, "claude", "ollama::qwen3");
    const opened = open(forBot);
    expect(list(opened).current).toMatchObject({ label: "qwen3 (Ollama)", warning: false });
    expect(group(opened, "claude")!.body).toMatchObject({ kind: "models", rows: [], signInForOwn: true });
    const html = menu(opened.html);
    expect(html).toContain("Sign in for Claude&#x27;s own models");
    expect(html).not.toContain(">Opus 5.5<");

    pane(opened)!.props.onSetUp(instance("claude"), false);
    const full = render(forBot);
    expect(pane(full)).toBeUndefined();
    expect(full.nodes.find((node) => node.type === EngineSetup)?.props).toMatchObject({ intent: "cloud" });
  });

  it("offers no sign-in row on a signed-in engine", () => {
    expect(menu(open(bot()).html)).not.toContain("data-simple-sign-in");
  });

  it("offers every level the engine reports in the provider's own names, presses the chosen one, and goes back to Default", () => {
    const opened = open(bot("xhigh"));
    expect(thinking(opened).levels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    const bottom = region(menu(opened.html), "data-simple-effort-band");
    expect(bottom).toMatch(/aria-pressed="true"[^>]*>X-High<\/button>/);
    expect(bottom).toContain('role="group" aria-labelledby=');
    expect(bottom).toMatch(/data-simple-effort="true"[^>]*class="[^"]*rounded-full bg-ink\/\[0.05\] p-\[3px\]/);
    expect(bottom).toContain('title="High thinking. Higher is slower but more careful."');
    expect(bottom).toMatch(/title="The model decides how hard to think."[^>]*>Use default<\/button>/);
    thinking(opened).onReset();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({
      type: "setModel", botId: "scout", threadId: "thread-scout", updateBotDefault: true,
      selection: { instanceId: "claude", model: "claude-opus-5-5" },
    });
    fixture.values = [];
    const atDefault = region(menu(open(bot()).html), "data-simple-effort-band");
    expect(atDefault).not.toContain('aria-pressed="true"');
    expect(atDefault).not.toContain("Use default");
    expect(atDefault).toContain('title="The model decides how hard to think." class="text-[12px] leading-4 text-ink-tertiary">Default</span>');
  });

  it("names the model on the Simple chip, quiet until hovered; thinking and route stay in its tooltip and the menu", () => {
    const chip = render(bot("high")).nodes.find((node) => node.props["data-tour"] === "model")!;
    const markup = renderToStaticMarkup(chip);
    expect(markup).not.toContain("data-model-effort");
    expect(markup.replace(/title="[^"]*"/, "")).not.toContain("High");
    expect(String(chip.props.title)).toContain("High thinking");
    expect(String(chip.props.title)).not.toContain("effort");
    expect(String(chip.props.className)).toContain("h-8");
    expect(String(chip.props.className)).toContain("rounded-full");
    expect(String(chip.props.className)).not.toMatch(/\bborder\b|bg-control/);
    expect(markup).not.toContain("@max-4xl/chathead");
    expect(markup).toContain('<span class="min-w-0 max-w-[160px] truncate">Opus 5.5</span>');
    expect(markup).toContain("opacity-60");
    fixture.advanced = true;
    const advanced = render(bot("high")).nodes.find((node) => node.props["data-tour"] === "model")!;
    expect(renderToStaticMarkup(advanced)).toContain("· High");
    expect(String(advanced.props.title)).toContain("High effort");
  });

  it("puts the header chip on an opaque surface, so scrolled transcript text cannot read through it", () => {
    const classes = () => String(render(bot()).nodes.find((node) => node.props["data-tour"] === "model")!.props.className);
    expect(classes().split(" ")).toEqual(expect.arrayContaining(["bg-composer", "ring-[0.5px]", "shadow-(--shadow-float)"]));
    expect(classes()).not.toMatch(/hover:bg-ink|aria-expanded:bg-ink/);
    fixture.advanced = true;
    try {
      expect(classes().split(" ")).toEqual(expect.arrayContaining(["bg-composer", "shadow-(--shadow-float)"]));
      expect(classes()).not.toMatch(/hover:bg-ink|aria-expanded:bg-ink/);
    } finally {
      fixture.advanced = false;
    }
  });

  it("leaves a contained picker on its settings row unchanged, with no floating surface", () => {
    const chip = render(bot(), { contained: true }).nodes.find((node) => node.props["data-tour"] === "model")!;
    expect(String(chip.props.className)).not.toContain("bg-composer");
    expect(String(chip.props.className)).not.toContain("shadow-(--shadow-float)");
  });

  it("lets the contained trigger shrink inside the bot panel's Model row, and the loose one keep its size", () => {
    const contained = render(bot(), { contained: true }).nodes.find((node) => node.props["data-tour"] === "model")!;
    expect(String(contained.props.className)).toContain("min-w-0 max-w-[58%]");
    expect(String(contained.props.className)).not.toMatch(/\bshrink-0\b/);
    const loose = render(bot()).nodes.find((node) => node.props["data-tour"] === "model")!;
    expect(String(loose.props.className)).toContain("shrink-0");
    expect(String(loose.props.className)).not.toContain("max-w-[58%]");
  });

  it("puts the provider before a model the catalog names in one bare word, on the chip and the current row", () => {
    fixture.instances = [claude(), cursor];
    const forBot = bot(undefined, "cursor", "auto");
    const chip = render(forBot).nodes.find((node) => node.props["data-tour"] === "model")!;
    expect(renderToStaticMarkup(chip)).toContain(">Cursor Auto</span>");
    expect(String(chip.props.title)).toContain("Cursor · Auto");
    const opened = open(forBot);
    expect(list(opened).current).toMatchObject({ label: "Cursor Auto", title: "Cursor · Auto" });
    expect(region(menu(opened.html), "data-current-model", "data-simple-provider")).toContain(">Cursor Auto</span>");
  });

  it("marks the chip when its engine cannot run, and says why in its tooltip", () => {
    fixture.instances = [claude(false)];
    const chip = render(bot()).nodes.find((node) => node.props["data-tour"] === "model")!;
    expect(renderToStaticMarkup(chip)).toContain("data-model-attention");
    expect(String(chip.props.title).split("\n")).toContain("Sign-in required");
    fixture.instances = [claude()];
    expect(renderToStaticMarkup(render(bot()).nodes.find((node) => node.props["data-tour"] === "model")!)).not.toContain("data-model-attention");
  });

  it("makes every pick the bot's default too, so new threads start on it, with no checkbox", () => {
    const opened = open(bot());
    expect(opened.html).not.toContain('type="checkbox"');
    pane(opened)!.props.onPick(instance("claude"), "claude-sonnet-5-5");
    expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "setModel", botId: "scout", threadId: "thread-scout", updateBotDefault: true,
      selection: expect.objectContaining({ instanceId: "claude", model: "claude-sonnet-5-5" }),
    }));
  });

  it.each([[true, false], [true, null], [false, false], [false, null]] as const)(
    "keeps a guest's model and effort changes thread-only (Cloud: %s, owner status: %s)", (cloudHome, ownerOrAdmin) => {
    fixture.cloudHome = cloudHome;
    fixture.ownerOrAdmin = ownerOrAdmin;
    const opened = open(bot());
    pane(opened)!.props.onPick(instance("claude"), "claude-sonnet-5-5");
    expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "setModel", threadId: "thread-scout", updateBotDefault: false,
      selection: expect.objectContaining({ model: "claude-sonnet-5-5" }),
    }));
    thinking(opened).onPick("high");
    expect(fixture.dispatch).toHaveBeenLastCalledWith({
      type: "setModel", botId: "scout", threadId: "thread-scout",
      selection: { instanceId: "claude", model: "claude-opus-5-5", effort: "high" },
    });
  });

  it("still updates defaults for the Cloud owner", () => {
    fixture.cloudHome = true;
    const opened = open(bot());
    pane(opened)!.props.onPick(instance("claude"), "claude-sonnet-5-5");
    expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ updateBotDefault: true }));
    thinking(opened).onPick("high");
    expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ updateBotDefault: true }));
  });

  it("does not reuse the full picker's bot scope for a Cloud guest's Simple choice", () => {
    fixture.cloudHome = true;
    fixture.ownerOrAdmin = false;
    fixture.advanced = true;
    const forBot = bot();
    const full = open(forBot);
    click(full.nodes.find((node) => node.type === "button" && node.props.children === "Thread + bot default"));
    fixture.advanced = false;
    pane(render(forBot))!.props.onPick(instance("claude"), "claude-sonnet-5-5");
    expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ updateBotDefault: false }));
  });

  it.each([false, null, true])("uses the Cloud owner's actual authority for named-variant defaults (%s)", (ownerOrAdmin) => {
    fixture.cloudHome = true;
    fixture.ownerOrAdmin = ownerOrAdmin;
    const variants = [{ id: "default", label: "Default" }, { id: "high", label: "High" }];
    fixture.instances = [{ ...claude(true, [{ id: "claude-opus-5-5", label: "Opus 5.5", variants }]), capabilities: { modelVariants: true } }];
    const row = (pane(open(bot()))!.props.thinking as { variants: ReactElement<ComponentProps<typeof ModelVariantRow>> }).variants;
    const select = nodes(ModelVariantRow(row.props)).find((node) => node.type === Select)!;
    (select.props.onChange as (event: unknown) => void)({ target: { value: "1" } });
    expect(fixture.dispatch).toHaveBeenLastCalledWith({
      type: "setModel", botId: "scout", threadId: "thread-scout",
      ...(ownerOrAdmin === true ? { updateBotDefault: true } : {}),
      selection: { instanceId: "claude", model: "claude-opus-5-5", variant: "high" },
    });
  });

  it("keeps the Advanced picker's own scope choice (this thread unless asked)", () => {
    fixture.advanced = true;
    const opened = open(bot());
    expect(pane(opened)).toBeUndefined();
    expect(opened.html).toContain("Only this thread");
  });

  it("opens the same floating menu from bot settings' Default model, without a second Thinking control, and edits the bot's default", () => {
    const opened = open(bot(), { contained: true });
    const simple = pane(opened)!;
    expect(opened.html).toContain("Default model");
    expect(simple.props.thinking).toBeNull();
    expect(menu(opened.html)).not.toContain('data-simple-effort="true"');
    const content = opened.nodes.find((node) => node.props["data-model-picker-content"] !== undefined)!;
    expect(String(content.props.className)).toContain("menu-surface");
    expect(String(content.props.className)).not.toContain("relative");
    simple.props.onPick(instance("claude"), "claude-haiku-4-5-20251001");
    expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "setModel", botId: "scout", threadId: "thread-scout", updateBotDefault: true,
      selection: expect.objectContaining({ model: "claude-haiku-4-5-20251001" }),
    }));
  });

  it("lets a contained Antigravity picker return a named variant to the session setting", () => {
    const variants = [{ id: "low", label: "Low" }, { id: "high", label: "High" }];
    fixture.instances = [{ ...engine("antigravity", "antigravityAgent", "Google Gemini", "subscription", [
      { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", variants },
    ]), capabilities: { modelVariants: true } }];
    const forBot = { ...bot(undefined, "antigravity", "gemini-3.8-flash"), modelSelection: {
      instanceId: "antigravity", model: "gemini-3.8-flash", variant: "high",
    } };
    const opened = open(forBot, { contained: true });
    const simple = pane(opened)!;
    expect(opened.html).toContain("Use session setting");
    expect((simple.props as { onResetVariant?: () => void }).onResetVariant).toBeTypeOf("function");
    (simple.props as { onResetVariant: () => void }).onResetVariant();
    expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "setModel", selection: { instanceId: "antigravity", model: "gemini-3.8-flash" },
    }));
  });

  it.each([[true, true], [false, false], [null, false]] as const)(
    "lets the bot panel's picker, given the open thread, set the default only for the Cloud owner (owner: %s)",
    (ownerOrAdmin, updatesDefault) => {
      fixture.cloudHome = true;
      fixture.ownerOrAdmin = ownerOrAdmin;
      const simple = pane(open(bot(), { contained: true, thread: true }))!;
      expect(simple.props.thinking).toBeNull();
      simple.props.onPick(instance("claude"), "claude-haiku-4-5-20251001");
      expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({
        type: "setModel", botId: "scout", threadId: "thread-scout", updateBotDefault: updatesDefault,
      }));
    },
  );

  it("writes the picked effort level", () => {
    thinking(open(bot())).onPick("high");
    expect(fixture.dispatch).toHaveBeenLastCalledWith({
      type: "setModel", botId: "scout", threadId: "thread-scout", updateBotDefault: true,
      selection: { instanceId: "claude", model: "claude-opus-5-5", effort: "high" },
    });
  });

  it("sends a provider that needs sign-in to the full picker's setup, with a way back to the list", () => {
    fixture.instances = [claude(false)];
    const forBot = bot();
    const opened = open(forBot);
    expect(list(opened).current).toMatchObject({ label: "Opus 5.5", meta: "Sign-in required", warning: true });
    expect(group(opened, "claude")!.body).toEqual({ kind: "signIn" });
    const html = menu(opened.html);
    expect(html).toContain('title="Claude needs to be set up before you can use it."');
    expect(html).toContain(">Sign in</span>");
    expect(html).not.toContain(">Sonnet 5.5<");

    pane(opened)!.props.onSetUp(instance("claude"), false);
    const full = render(forBot);
    expect(pane(full)).toBeUndefined();
    expect(full.nodes.some((node) => node.type === ModelEngineRail)).toBe(true);
    const back = full.nodes.find((node) => node.props["data-model-back"] !== undefined)!;
    expect(menu(full.html)).toContain(">Back</span>");
    click(back);
    expect(pane(render(forBot))).toBeDefined();
  });

  it("sets up a missing engine from its row", () => {
    const missing: InstanceInfo = { ...cursor, snapshot: { state: "unavailable", reason: "`cursor-agent` isn't installed" } };
    fixture.instances = [claude(), missing];
    const forBot = bot(undefined, "cursor", "auto");
    const opened = open(forBot);
    expect(list(opened).current).toMatchObject({ meta: "Setup required", warning: true });
    expect(list(opened).groups.map((entry) => [entry.label, entry.body.kind])).toEqual([["Cursor", "setUp"], ["Claude", "models"]]);
    const html = region(menu(opened.html), 'data-simple-provider="cursor"', 'data-simple-provider="claude"');
    expect(html).toContain(">Set up</span>");
    expect(html).toContain("data-simple-set-up");
    pane(opened)!.props.onSetUp(missing, false);
    const full = render(forBot);
    expect(full.nodes.find((node) => node.type === EngineSetup)?.props).toMatchObject({ instance: missing, quiet: true });
  });

  it("opens setup from the checked row when its engine cannot run, and closes from it otherwise, writing nothing", () => {
    const missing: InstanceInfo = { ...cursor, snapshot: { state: "unavailable", reason: "`cursor-agent` isn't installed" } };
    fixture.instances = [claude(), missing];
    const forBot = bot(undefined, "cursor", "auto");
    const currentRow = (rendered: Rendered) =>
      nodes(SimpleModelMenu(pane(rendered)!.props)).find((node) => node.props["data-current-model"] !== undefined)!;
    click(currentRow(open(forBot)));
    const full = render(forBot);
    expect(pane(full)).toBeUndefined();
    expect(full.nodes.find((node) => node.type === EngineSetup)?.props).toMatchObject({ instance: missing });

    fixture.values = [];
    fixture.instances = [claude()];
    click(currentRow(open(bot())));
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(render(bot()).html).not.toContain("data-model-picker-content");
  });

  it.each([[true, true], [false, false], [null, false]] as const)(
    "keeps the list's rule for a pick in the full picker behind Set up (owner: %s)", (ownerOrAdmin, updatesDefault) => {
      fixture.ownerOrAdmin = ownerOrAdmin;
      const missing: InstanceInfo = { ...cursor, snapshot: { state: "unavailable", reason: "`cursor-agent` isn't installed" } };
      fixture.instances = [claude(), missing];
      const forBot = bot();
      pane(open(forBot))!.props.onSetUp(missing, false);
      fixture.instances = [claude(), cursor];
      const full = render(forBot);
      expect(menu(full.html)).toContain(updatesDefault ? "every thread that uses the bot&#x27;s model" : "This thread only.");
      (full.nodes.find((node) => node.type === ModelRow)!.props.onPick as () => void)();
      expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({
        type: "setModel", threadId: "thread-scout", updateBotDefault: updatesDefault,
        selection: expect.objectContaining({ instanceId: "cursor", model: "auto" }),
      }));
    },
  );

  it("starts over in the Simple view the next time it opens", () => {
    fixture.instances = [claude(false)];
    const forBot = bot();
    pane(open(forBot))!.props.onSetUp(instance("claude"), false);
    const trigger = render(forBot).nodes.find((node) => node.props["data-tour"] === "model")!;
    (trigger.props.onClick as () => void)();
    expect(pane(open(forBot))).toBeDefined();
  });

  it("says so when there is no provider at all, and still names the bot's model", () => {
    fixture.instances = [];
    const opened = open(bot());
    expect(list(opened).current).toMatchObject({ label: "claude-opus-5-5", meta: "Unavailable", warning: true });
    expect(menu(opened.html)).toContain("No model providers are available.");
    expect(menu(opened.html)).toContain("Manage AI accounts");
  });

  it("asks a provider with nothing to list to check again", async () => {
    const plan: InstanceInfo = {
      ...engine("chatgpt", "codex", "ChatGPT plan", "subscription", []),
      snapshot: { state: "available", version: "1.0.0", authenticated: true, chatgptPlan: true },
    };
    fixture.instances = [claude(), plan];
    const opened = open(bot());
    const html = region(menu(opened.html), 'data-simple-provider="chatgpt"', "data-simple-effort-band");
    expect(html).toContain("No models to show here yet.");
    expect(html).toContain(">Check again</span>");
    pane(opened)!.props.onCheckAgain(plan);
    await vi.waitFor(() => expect(fixture.refreshModels).toHaveBeenCalledWith("chatgpt"));
    expect(fixture.refreshInstances).toHaveBeenCalled();
  });

  it("says it is loading a provider's models while it asks for them, and holds every other Check again until then", async () => {
    let arrive!: () => void;
    fixture.refreshModels = vi.fn(() => new Promise<void>((resolve) => { arrive = resolve; }));
    const plan: InstanceInfo = {
      ...engine("chatgpt", "codex", "ChatGPT plan", "subscription", []),
      snapshot: { state: "available", version: "1.0.0", authenticated: true, chatgptPlan: true },
    };
    const work: InstanceInfo = { ...plan, instanceId: "chatgpt-work", displayName: "Work plan" };
    fixture.instances = [claude(), plan, work];
    const forBot = bot();
    const other = (html: string) => region(html, 'data-simple-provider="chatgpt-work"', "data-simple-effort-band");
    expect(other(menu(open(forBot).html))).not.toMatch(/data-simple-refresh="true"[^>]* disabled=""/);
    pane(render(forBot))!.props.onCheckAgain(plan);
    await vi.waitFor(() => expect(fixture.refreshModels).toHaveBeenCalledWith("chatgpt"));
    const reading = menu(render(forBot).html);
    const html = region(reading, 'data-simple-provider="chatgpt"', 'data-simple-provider="chatgpt-work"');
    expect(html).toContain("Loading OpenAI models…");
    expect(html).toContain('role="status"');
    expect(html).not.toContain("Check again");
    expect(other(reading)).toMatch(/data-simple-refresh="true"[^>]* disabled=""/);
    expect(other(reading)).toContain("animate-spin");
    arrive();
    await vi.waitFor(() => expect(region(menu(render(forBot).html), 'data-simple-provider="chatgpt"', 'data-simple-provider="chatgpt-work"')).toContain("Check again"));
    expect(other(menu(render(forBot).html))).not.toMatch(/data-simple-refresh="true"[^>]* disabled=""/);
  });

  it("lists each ready Claude account as its own provider, and a signed-out one as one to sign in", () => {
    const work: InstanceInfo = { ...claude(true, [{ id: "claude-sonnet-5-5", label: "Sonnet 5.5" }, { id: "claude-fable", label: "Fable 5" }]), instanceId: "claude-work", displayName: "Work" };
    const home: InstanceInfo = { ...claude(false), instanceId: "claude-home", displayName: "Home" };
    fixture.instances = [claude(), work, home];
    const forBot = bot();
    const opened = open(forBot);
    expect(list(opened).groups.map((entry) => [entry.label, entry.body.kind]))
      .toEqual([["Claude", "models"], ["Claude · Work", "models"], ["Claude · Home", "signIn"]]);
    expect(list(opened).current!.meta).toBe("Claude");
    pane(opened)!.props.onPick(work, "claude-sonnet-5-5");
    expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "setModel", selection: expect.objectContaining({ instanceId: "claude-work", model: "claude-sonnet-5-5" }),
    }));
    fixture.values = [];
    pane(open(forBot))!.props.onSetUp(home, false);
    const full = render(forBot);
    expect(full.html).toContain('<option value="claude-home" selected="">Home</option>');
  });

  it("lists Codex and the ChatGPT plan each under OpenAI", () => {
    const plan: InstanceInfo = {
      ...engine("chatgpt", "codex", "ChatGPT plan", "subscription", [{ id: "gpt-5.6-plan", label: "GPT-5.6 (plan)" }]),
      snapshot: { state: "available", version: "1.0.0", authenticated: true, chatgptPlan: true },
    };
    fixture.instances = [claude(), codex, plan];
    const opened = open(bot());
    expect(list(opened).groups.map((entry) => entry.label)).toEqual(["Claude", "OpenAI · Codex", "OpenAI · ChatGPT plan"]);
    expect(labels(opened, "chatgpt")).toEqual(["GPT-5.6 (plan)"]);
    pane(opened)!.props.onPick(plan, "gpt-5.6-plan");
    expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "setModel", selection: expect.objectContaining({ instanceId: "chatgpt", model: "gpt-5.6-plan" }),
    }));
  });

  it("says who manages a provider its organisation blocks, with nothing to pick or set up", () => {
    const blocked: InstanceInfo = { ...openaiKey, policy: { organizationName: "Acme", reason: "Acme allows only company models." } };
    fixture.instances = [claude(), blocked];
    const opened = open(bot());
    expect(group(opened, "openai")!.body).toEqual({ kind: "policy", organization: "Acme" });
    const html = region(menu(opened.html), 'data-simple-provider="openai"', "data-simple-effort-band");
    expect(html).toContain("Managed by Acme");
    expect(html).toContain("Bots cannot use this model provider while this computer is connected to Acme.");
    expect(html).not.toContain("data-simple-set-up");
    expect(html).not.toContain("GPT-5.6");
    pane(opened)!.props.onPick(blocked, "gpt-5.6");
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("tells same-named models apart by their route", () => {
    fixture.instances = [engine("pi", "piAgent", "pi", "custom", [
      { id: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5", custom: true, provider: "anthropic" },
      { id: "openai/gpt-5.6", label: "GPT-5.6", custom: true, provider: "openai" },
      { id: "openai/gpt-5.6-mini", label: "GPT-5.6 mini", custom: true, provider: "openai" },
      { id: "google/gemini-3", label: "Gemini 3", custom: true, provider: "google" },
      { id: "amazon-bedrock/claude-sonnet-4-5", label: "Claude Sonnet 4.5", custom: true, provider: "amazon-bedrock" },
    ])];
    const opened = open(bot(undefined, "pi", "openai/gpt-5.6"));
    const html = menu(opened.html);
    expect(html).toContain('aria-label="Claude Sonnet 4.5 · anthropic"');
    expect(html).toMatch(/data-simple-route="true"[^>]*>anthropic</);
    expect(html).toMatch(/data-simple-route="true"[^>]*>amazon-bedrock</);
    expect(html).not.toMatch(/data-simple-route="true"[^>]*>openai</);
  });

  it("renders a model's route on its own line in a row that may grow", () => {
    fixture.instances = [engine("pi", "piAgent", "pi", "custom", [
      { id: "amazon-bedrock/claude-sonnet-4-5", label: "Claude Sonnet 4.5", custom: true, provider: "amazon-bedrock" },
      { id: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5", custom: true, provider: "anthropic" },
    ])];
    const html = menu(open(bot(undefined, "pi", "amazon-bedrock/claude-sonnet-4-5")).html);
    const row = html.split("<button").find((part) => part.includes("data-simple-route") && part.includes("anthropic"));
    expect(row).toBeDefined();
    const lines = row!.slice(row!.indexOf("data-simple-model-text"));
    expect(lines).toMatch(/data-simple-model-text="true" class="[^"]*\bflex-col\b/);
    expect(lines).toMatch(/<span class="truncate">Claude Sonnet 4\.5<\/span>/);
    expect(lines).toMatch(/data-simple-route="true" class="[^"]*\btruncate\b[^"]*">anthropic</);
    expect(row).toContain("min-h-[30px]");
    expect(row).not.toMatch(/\sh-\[30px\]/);
    expect(row).not.toContain("max-w-[45%]");
  });

  it("looks for local models only when asked, on Show all where a provider offers them, never just for opening", () => {
    const codexMany = engine("codex", "codex", "Codex", "subscription", many(8));
    fixture.instances = [claude(true, many(8)), codexMany, grok, local];
    const forBot = bot(undefined, "claude", "model-1");
    const opened = open(forBot);
    expect(fixture.refreshModels).not.toHaveBeenCalled();
    toggle(opened, "codex");
    expect(fixture.refreshModels).not.toHaveBeenCalled();
    toggle(render(forBot));
    expect(fixture.refreshModels).toHaveBeenCalledExactlyOnceWith("claude");
    toggle(render(forBot), "pi");
    expect(fixture.refreshModels).toHaveBeenLastCalledWith("pi");
    expect(fixture.refreshModels).toHaveBeenCalledTimes(2);
  });

  it("opens AI accounts from the footer", () => {
    const manage = open(bot()).nodes.find((node) => node.type === SimpleModelMenu)!;
    (manage.props.onManage as () => void)();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "toggleAppSettings", open: true, section: "engines" });
  });

  it("puts a quiet named-variants select beside Thinking in place of the effort steps", () => {
    const variants = [{ id: "default", label: "Default" }, { id: "high", label: "High" }];
    fixture.instances = [{ ...claude(true, [{ id: "claude-opus-5-5", label: "Opus 5.5", variants }]), capabilities: { modelVariants: true } }];
    const opened = open(bot());
    const row = (pane(opened)!.props.thinking as { variants: ReactElement<ComponentProps<typeof ModelVariantRow>> }).variants;
    expect(row.type).toBe(ModelVariantRow);
    expect(row.props).toMatchObject({ compact: true, quiet: true });
    const bottom = region(menu(opened.html), "data-simple-effort-band");
    expect(bottom).toContain('aria-label="Reasoning variant"');
    expect(bottom.indexOf(">Thinking</span>")).toBeGreaterThan(-1);
    expect(bottom.indexOf(">Thinking</span>")).toBeLessThan(bottom.indexOf("<select"));
    expect(bottom).toContain("bg-ink/[0.05]");
    expect(bottom).not.toContain("data-simple-effort=");
  });

  it("offers an OpenCode Copilot model's efforts from its catalog, and nothing for a model without them", () => {
    // The catalog OpenCode 2.1.4 gave for a Copilot GPT model with an effort list, and for one without.
    const variants = ["Low", "Medium", "High", "Xhigh", "Default"].map((label) => ({ id: label.toLowerCase(), label }));
    fixture.instances = [{
      ...engine("opencodeGo", "opencodeGo", "OpenCode", "api", [
        { id: "github-copilot/gpt-5.3-codex", label: "Github Copilot · GPT-5.3 Codex", variants },
        { id: "github-copilot/gemini-3.8-flash", label: "Github Copilot · Gemini 3.8 Flash" },
      ]),
      capabilities: { modelVariants: true },
    }];
    const band = (model: string) => region(menu(open(bot(undefined, "opencodeGo", model)).html), "data-simple-effort-band");
    const offered = band("github-copilot/gpt-5.3-codex");
    expect([...offered.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((match) => match[1]))
      .toEqual(["Use session setting", "Low", "Medium", "High", "Xhigh", "OpenCode default"]);
    fixture.values = [];
    const plain = band("github-copilot/gemini-3.8-flash");
    expect(plain).toContain("data-simple-effort-band");
    expect(plain).not.toContain("<select");
    expect(plain).not.toContain("data-simple-thinking");
  });

  it("leaves Advanced mode on the full picker", () => {
    fixture.advanced = true;
    const opened = open(bot());
    expect(pane(opened)).toBeUndefined();
    expect(opened.nodes.some((node) => node.type === ModelEngineRail)).toBe(true);
    expect(opened.html).not.toContain("data-model-back");
  });
});

describe("a thread's picker and its bot's model", () => {
  const opus = { instanceId: "claude", model: "claude-opus-5-5" };
  const haiku = { instanceId: "claude", model: "claude-haiku-4-5-20251001" };
  function scout(threadModel: typeof opus | null, others: Array<{ threadId: string; model: typeof opus | null }> = []) {
    const profile: Bot = { ...bot(), tasks: [
      { threadId: "thread-scout", title: "This one", createdAt: 1, modelSelection: threadModel ?? opus, followsBotModel: threadModel === null },
      ...others.map(({ threadId, model }) => ({ threadId, title: threadId, createdAt: 1, modelSelection: model ?? opus, followsBotModel: model === null })),
    ] };
    fixture.bots = [profile];
    return { ...profile, modelSelection: threadModel ?? opus };
  }

  it("offers the bot's model to a thread on its own in one row, and picking it is a thread-only pick of the bot's model", () => {
    const opened = open(scout(haiku));
    expect(list(opened).follow).toBe(true);
    const html = menu(opened.html);
    expect(html).toContain("Use Scout&#x27;s model");
    expect(html).toContain('title="Claude · Opus 5.5"');
    expect(html).toContain('data-follow-bot-model="true" aria-pressed="false"');
    expect(region(html, "data-follow-bot-model", 'role="separator"')).toContain(">Opus 5.5</span>");
    expect(labels(opened)).toEqual(["Sonnet 5.5"]);
    expect(html).not.toContain("data-bot-model");
    pane(opened)!.props.onFollowBot();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({
      type: "setModel", botId: "scout", threadId: "thread-scout", updateBotDefault: false, selection: opus,
    });
  });

  it("says on the current model that a thread follows its bot, with no follow row to click", () => {
    const opened = open(scout(null));
    expect(list(opened).follow).toBe(false);
    expect(list(opened).current!.meta).toBe("Scout's model");
    expect(menu(opened.html)).not.toContain("data-follow-bot-model");
    expect(render(scout(null)).nodes.find((node) => node.props["data-tour"] === "model")!.props.title).toContain("Uses Scout's model");
  });

  it("keeps the full picker's follow row for Advanced", () => {
    fixture.advanced = true;
    const opened = open(scout(null));
    const row = opened.nodes.find((node) => node.type === FollowBotModelRow)!;
    expect(row.props.follows).toBe(true);
    (row.props.onPick as () => void)();
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("offers nothing a server too old to say whether a thread follows its bot could not do", () => {
    fixture.bots = [];
    const opened = open(bot());
    expect(list(opened).follow).toBe(false);
    expect(menu(opened.html)).not.toContain("data-follow-bot-model");
    expect(labels(opened)).toEqual(["Sonnet 5.5", "Haiku 4.5"]);
    expect(list(opened).current!.meta).toBeUndefined();
  });

  it("closes from the checked row without a write, so it never changes the bot's model or says threads keep their own", () => {
    const forBot = scout(null, [{ threadId: "kept", model: haiku }]);
    const simple = pane(open(forBot))!;
    const row = nodes(SimpleModelMenu(simple.props)).find((node) => node.props["data-current-model"] !== undefined)!;
    (row.props.onClick as (event: { detail: number }) => void)({ detail: 0 });
    expect(fixture.dispatch).not.toHaveBeenCalled();
    const closed = render(forBot).html;
    expect(closed).not.toContain("data-model-picker-content");
    expect(closed).not.toContain("data-thread-models-notice");
  });

  it("right after a pick changes the bot's model, says how many threads keep their own, until it opens again", () => {
    const forBot = scout(null, [{ threadId: "kept", model: haiku }, { threadId: "follows", model: null }]);
    const opened = open(forBot);
    pane(opened)!.props.onPick(instance("claude"), "claude-sonnet-5-5");
    expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ type: "setModel", updateBotDefault: true }));
    const closed = render(forBot);
    expect(closed.html).toContain("data-thread-models-notice");
    expect(closed.html).toContain("menu-surface");
    expect(closed.html).toContain("1 thread uses its own model.");
    expect(closed.html).toContain("Switch it too");
    open(forBot);
    expect(render(forBot).html).not.toContain("data-thread-models-notice");
  });

  it("says nothing after a bot model change when every thread follows the bot", () => {
    const forBot = scout(null, [{ threadId: "follows", model: null }]);
    pane(open(forBot))!.props.onPick(instance("claude"), "claude-sonnet-5-5");
    expect(render(forBot).html).not.toContain("data-thread-models-notice");
  });
});

describe("every capability of the picker stays reachable", () => {
  const withLocal = claude(true, [...claudeModels, { id: "ollama::qwen3", label: "qwen3 (Ollama)", custom: true }]);
  const updated: InstanceInfo = { ...withLocal, snapshot: { ...withLocal.snapshot, update: { title: "Update Claude", message: "A newer CLI is out.", command: "claude update" } } };
  const missing: InstanceInfo = { ...cursor, snapshot: { state: "unavailable", reason: "`cursor-agent` isn't installed" } };
  const managed: InstanceInfo = { ...openaiKey, policy: { organizationName: "Acme", reason: "Company models only." } };
  const signedOutWork: InstanceInfo = { ...claude(false), instanceId: "claude-work", displayName: "Work" };
  const plan: InstanceInfo = { ...engine("chatgpt", "codex", "ChatGPT plan", "subscription", []), snapshot: { state: "available", version: "1.0.0", authenticated: true, chatgptPlan: true } };
  const rich = () => [updated, signedOutWork, missing, managed, plan, local];
  function followed(): Bot {
    const profile: Bot = { ...bot("high"), tasks: [{ threadId: "thread-scout", title: "This one", createdAt: 1,
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5-5" }, followsBotModel: false }] };
    fixture.bots = [profile];
    return { ...profile, modelSelection: { instanceId: "claude", model: "claude-sonnet-5-5", effort: "high" } };
  }
  const missingFrom = (checks: Record<string, boolean>) => Object.entries(checks).filter(([, reached]) => !reached).map(([name]) => name);

  it("in Simple mode, from the chip, its menu and the full picker behind Set up", () => {
    fixture.instances = rich();
    const forBot = followed();
    const chip = render(forBot).nodes.find((node) => node.props["data-tour"] === "model")!;
    const opened = open(forBot);
    const html = menu(opened.html);
    const simple = list(opened);
    const body = (id: string) => group(opened, id)?.body.kind;
    const props = pane(opened)!.props;
    const before = {
      "chip names the model, says it opens a dialog, and carries model, effort and follow in its tooltip":
        chip.props["aria-haspopup"] === "dialog" && String(chip.props.title).includes("High thinking") && String(chip.props.title).includes("This thread's own model"),
      "current model with its check": html.includes("data-current-model") && simple.current?.label === "Sonnet 5.5",
      "use the bot's model": simple.follow && html.includes("Use Scout&#x27;s model"),
      "the follow row carries the bot's model, once": region(html, "data-follow-bot-model", 'role="separator"').includes(">Opus 5.5</span>") && !labels(opened, "claude").includes("Opus 5.5"),
      "every ready provider's models at once": labels(opened, "claude").length > 0 && labels(opened, "pi").length > 0,
      "local models beside a provider's own": html.includes(">Local models</div>") && labels(opened, "claude").includes("qwen3 (Ollama)"),
      "show every model of a provider": html.includes("data-simple-show-all"),
      "a signed-out account signs in": body("claude-work") === "signIn",
      "a managed provider says who manages it": body("openai") === "policy" && html.includes("Managed by Acme"),
      "a provider with nothing listed checks again": body("chatgpt") === "empty" && html.includes("data-simple-refresh"),
      "thinking levels in the provider's own names, and back to Default": html.includes(">X-High</button>") && html.includes(">Use default</button>"),
      "AI accounts in Settings": html.includes("data-simple-manage"),
    };
    expect(missingFrom(before)).toEqual([]);

    props.onToggle(local);
    expect(labels(render(forBot), "pi").length).toBeGreaterThan(labels(opened, "pi").length);
    props.onSetUp(signedOutWork, false);
    const full = render(forBot);
    const fullHtml = menu(full.html);
    const behind = {
      "the full picker opens in place, with a way back": pane(full) === undefined && fullHtml.includes("data-model-back"),
      "engine rail with API keys": full.nodes.some((node) => node.type === ModelEngineRail) && fullHtml.includes(">API keys<"),
      "this thread or the bot's default": fullHtml.includes("Only this thread") && fullHtml.includes("Thread + bot default"),
      "engine status and refresh": fullHtml.includes("Sign-in required") && fullHtml.includes("data-model-refresh"),
      "the account select": fullHtml.includes('<option value="claude-work" selected="">Work</option>'),
      "install and sign-in help": full.nodes.some((node) => node.type === EngineSetup),
      "providers and accounts, and API keys": fullHtml.includes("Model providers and accounts") && fullHtml.includes("data-model-add-api-keys"),
    };
    expect(missingFrom(behind)).toEqual([]);

    fixture.values = [];
    const onMissing = open({ ...forBot, modelSelection: { instanceId: "cursor", model: "auto" } });
    expect(group(onMissing, "cursor")?.body.kind).toBe("setUp");
    expect(list(onMissing).current).toMatchObject({ meta: "Setup required", warning: true });
  });

  it("in Advanced mode, from the chip and the full picker", () => {
    fixture.advanced = true;
    fixture.instances = [updated, signedOutWork, codex, plan, managed, local];
    const forBot = followed();
    const chipHtml = renderToStaticMarkup(render(forBot).nodes.find((node) => node.props["data-tour"] === "model")!);
    const opened = open(forBot);
    const html = menu(opened.html);
    const checks = {
      "chip shows account, model and effort": chipHtml.includes("data-model-account") && chipHtml.includes("data-model-effort"),
      "use the bot's model, checked while following": opened.nodes.some((node) => node.type === FollowBotModelRow),
      "engine rail with Cloud, API keys and Local, and a way to add keys": html.includes(">Cloud<") && html.includes(">API keys<") && html.includes(">Local<") && html.includes("data-rail-add-api-key"),
      "a managed engine stays on the rail, dimmed": html.includes("Managed by Acme") && html.includes("opacity-40"),
      "this thread or the bot's default": html.includes("Only this thread"),
      "engine name, refresh and version": html.includes("data-model-refresh") && html.includes("2.1.300"),
      "the Claude account select": html.includes('aria-label="Account"'),
      "the engine's update notice": html.includes("Update Claude"),
      "suggested models, the default and the bot's model tagged": html.includes(">Suggested<") && html.includes("(bot&#x27;s model)"),
      "effort select": html.includes('aria-label="Reasoning effort"'),
      "local models": html.includes("data-model-local-entry") && html.includes("1 available"),
      "providers and accounts, and API keys": html.includes("Model providers and accounts") && html.includes("data-model-add-api-keys"),
    };
    expect(missingFrom(checks)).toEqual([]);
  });
});
