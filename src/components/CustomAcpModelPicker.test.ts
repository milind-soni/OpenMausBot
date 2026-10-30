import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Children, createElement, isValidElement, type ChangeEvent, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { AppState, Bot, InstanceInfo } from "@/state/store";
import { Select } from "./Select";
import { resolveCustomAcpModels } from "../../server/drivers/acp/custom-model-catalog";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return { instances: [] as InstanceInfo[], modelVariantSessions: {} as AppState["modelVariantSessions"], dispatch: vi.fn(),
    values: [] as unknown[], index: 0, own: 0, advanced: false };
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
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: { instances: fixture.instances, bots: [], modelVariantSessions: fixture.modelVariantSessions }, dispatch: fixture.dispatch,
    refreshInstances: vi.fn(() => Promise.resolve()), refreshModels: vi.fn(() => Promise.resolve()) }),
}));
const { ModelPicker, ModelVariantRow, modelSelectionForPick } = await import("./ModelPicker");
const { SimpleModelMenu } = await import("./SimpleModelMenu");
let nativeDirectory: string;
let discovered: InstanceInfo["models"];
beforeAll(async () => {
  nativeDirectory = await mkdtemp(join(tmpdir(), "omb-custom-picker-ui-"));
  const fakeCli = fileURLToPath(new URL("../../server/testing/fake-custom-acp-models.ts", import.meta.url));
  discovered = await resolveCustomAcpModels({ HOME: nativeDirectory, USERPROFILE: nativeDirectory,
    PATH: dirname(process.execPath), FAKE_CUSTOM_ACP_DIRECTORY: nativeDirectory },
  { cli: `${JSON.stringify(process.execPath)} --experimental-strip-types ${JSON.stringify(fakeCli)}` });
});
afterAll(async () => { vi.unstubAllGlobals(); if (nativeDirectory) await rm(nativeDirectory, { recursive: true, force: true }); });
beforeEach(() => {
  fixture.dispatch.mockClear(); fixture.modelVariantSessions = {};
  fixture.values = []; fixture.index = 0; fixture.own = 0; fixture.advanced = false;
});

const engine = (instanceId: string): InstanceInfo => ({
  instanceId, displayName: instanceId, driverKind: "customAcp", access: "custom", snapshot: { state: "available" },
  capabilities: { modelVariants: true },
  models: { default: "agent-default", options: [
    { id: "agent-default", label: "Agent default" },
    { id: "full", label: "Full model", variants: [{ id: "low", label: "Low" }, { id: "max", label: "Max" }] },
    { id: "flash", label: "Flash model", variants: [{ id: "medium", label: "Medium" }, { id: "high", label: "High" }] },
  ] },
});
const bot = (instanceId: string, model = "full", variant?: string): Bot => ({
  id: `bot-${instanceId}`, threadId: `thread-${instanceId}`, name: instanceId, title: "", description: "", notifications: true,
  color: "green", unread: false, messages: [], modelSelection: { instanceId, model, ...(variant ? { variant } : {}) },
});
type Element = ReactElement<Record<string, unknown> & { children?: ReactNode; value?: string; onChange?: (event: ChangeEvent<HTMLSelectElement>) => void }>;
function elements(value: ReactNode): Element[] {
  return Children.toArray(value).flatMap((child) => isValidElement(child) ? [child as Element, ...elements((child as Element).props.children)] : []);
}

function renderPicker(selected: Bot) {
  fixture.values.length = Math.min(fixture.values.length, fixture.own);
  let tree: ReactNode = null;
  function Capture() {
    fixture.index = 0;
    tree = ModelPicker({ bot: selected, threadId: selected.threadId });
    fixture.own = fixture.index;
    return tree;
  }
  return { html: renderToStaticMarkup(createElement(Capture)), nodes: elements(tree) };
}

function openPicker(selected: Bot) {
  const trigger = renderPicker(selected).nodes.find((entry) => entry.props["data-tour"] === "model")!;
  (trigger.props.onClick as () => void)();
  return renderPicker(selected);
}

it.each(["zcode", "codebuddy", "qoder", "qodercn"])("offers discovered models in the complete %s picker and saves model then thinking for that bot", (instanceId) => {
  fixture.instances = [{ ...engine(instanceId), models: discovered }];
  const selected = bot(instanceId, "agent-default");
  const opened = openPicker(selected);
  const pane = opened.nodes.find((entry) => entry.type === SimpleModelMenu) as unknown as ReactElement<ComponentProps<typeof SimpleModelMenu>>;
  const listed = pane.props.menu.groups.flatMap((group) => group.body.kind === "models" ? group.body.rows.map((row) => row.option.id) : []);
  expect(pane.props.menu.current?.label).toBe("Agent default");
  expect(listed).toEqual(expect.arrayContaining(["glm-5.3", "glm-5.3-flash"]));
  expect(opened.html).toContain(">GLM-5.3-Flash</span>");
  expect(opened.html).toContain(">GLM-5.3</span>");
  pane.props.onPick(fixture.instances[0]!, "glm-5.3-flash");
  expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "setModel", botId: selected.id, threadId: selected.threadId,
    updateBotDefault: true, selection: { instanceId, model: "glm-5.3-flash" } });
  const saved = { ...selected, modelSelection: { instanceId, model: "glm-5.3-flash" } };
  const reopened = openPicker(saved);
  const savedPane = reopened.nodes.find((entry) => entry.type === SimpleModelMenu) as unknown as ReactElement<ComponentProps<typeof SimpleModelMenu>>;
  const variants = (savedPane.props.thinking as { variants: ReactElement<ComponentProps<typeof ModelVariantRow>> }).variants;
  expect(variants.type).toBe(ModelVariantRow);
  const nativeRow = ModelVariantRow(variants.props);
  const thinking = elements(nativeRow).find((entry) => entry.type === Select)!;
  expect(reopened.html).toContain(">high</option>");
  expect(reopened.html).not.toContain(">Max</option>");
  thinking.props.onChange!({ target: { value: "1" } } as ChangeEvent<HTMLSelectElement>);
  expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "setModel", botId: selected.id, threadId: selected.threadId,
    updateBotDefault: true, selection: { instanceId, model: "glm-5.3-flash", variant: "high" } });
  fixture.values = []; fixture.index = 0; fixture.own = 0;
  expect(openPicker({ ...saved, modelSelection: { ...saved.modelSelection, variant: "high" } }).html).toContain('selected="">high</option>');
});

it.each(["zcode", "codebuddy", "qoder", "qodercn"])("uses model-specific thinking choices and saves only the selected %s bot", (instanceId) => {
  fixture.instances = [engine(instanceId), engine("other-custom")];
  const selected = bot(instanceId, "full", "low");
  const row = ModelVariantRow({ bot: selected, threadId: selected.threadId, updateBotDefault: true, compact: true });
  const picker = elements(row).find((entry) => entry.type === Select)!;
  const markup = renderToStaticMarkup(createElement(ModelVariantRow, { bot: selected, threadId: selected.threadId, compact: true }));
  expect(markup).toContain('aria-label="Reasoning variant"');
  expect(markup).toContain(">Low</option>");
  expect(markup).toContain(">Max</option>");
  expect(markup).not.toContain(">High</option>");
  picker.props.onChange!({ target: { value: "1" } } as ChangeEvent<HTMLSelectElement>);
  expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "setModel", botId: selected.id, threadId: selected.threadId,
    updateBotDefault: true, selection: { instanceId, model: "full", variant: "max" } });
});

it("drops the previous model's thinking choice and displays the new model's supported choices", () => {
  const provider = engine("zcode");
  fixture.instances = [provider];
  const selection = modelSelectionForPick(bot("zcode", "full", "max").modelSelection, provider, "flash");
  expect(selection).toEqual({ instanceId: "zcode", model: "flash" });
  const markup = renderToStaticMarkup(createElement(ModelVariantRow, { bot: { ...bot("zcode"), modelSelection: selection }, compact: true }));
  expect(markup).toContain(">Medium</option>");
  expect(markup).toContain(">High</option>");
  expect(markup).not.toContain(">Max</option>");
});

it("does not borrow another custom instance's session options, and hides thinking when unadvertised", () => {
  fixture.instances = [engine("qoder")];
  fixture.modelVariantSessions["thread-qoder"] = { instanceId: "codebuddy", model: "full", turnId: "other-turn",
    startedAt: new Date().toISOString(), acceptingUpdates: false, variants: { options: [{ id: "alien", label: "Alien" }] } };
  const markup = renderToStaticMarkup(createElement(ModelVariantRow, { bot: bot("qoder"), compact: true }));
  expect(markup).toContain(">Max</option>");
  expect(markup).not.toContain("Alien");
  fixture.instances[0] = { ...fixture.instances[0], capabilities: { modelVariants: false } };
  expect(renderToStaticMarkup(createElement(ModelVariantRow, { bot: bot("qoder"), compact: true }))).toBe("");
});

it("keeps an agent's native default label and uses a provider-neutral clear hint", () => {
  const provider = engine("zcode");
  provider.models.options[1].variants = [{ id: "default", label: "Agent decides" }];
  fixture.instances = [provider];
  const selected = bot("zcode", "full", "default");
  const row = renderToStaticMarkup(createElement(ModelVariantRow, { bot: selected }));
  expect(row).toContain("Agent decides");
  expect(row).not.toContain("OpenCode");
  expect(row).toContain("the agent keeps its session or configured setting");
  expect(renderPicker(selected).html).toContain("Agent decides");
  expect(renderPicker(selected).html).not.toContain("OpenCode default");
});
