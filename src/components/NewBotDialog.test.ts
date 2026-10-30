import { Children, createElement, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ effects: [] as EffectCallback[], dispatch: vi.fn(), api: vi.fn(), create: vi.fn(), setDraft: vi.fn(), ready: false, hook: 0, admin: false,
  profile: {} as Record<string, unknown>, track: vi.fn(), advanced: true, appSettingsOpen: false, openBot: vi.fn(), close: vi.fn() }));
vi.mock("@/state/thread-navigation", async importOriginal => ({
  ...await importOriginal<typeof import("@/state/thread-navigation")>(), openBot: fixture.openBot,
}));
vi.mock("@/lib/analytics", () => ({ track: fixture.track }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.admin }));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: {} }) }));
vi.mock("react", async importOriginal => {
  const react = await importOriginal<typeof import("react")>();
  return { ...react, useEffect: (effect: EffectCallback) => { fixture.effects.push(effect); }, useState: (initial: unknown) => {
    const state = react.useState(initial);
    const index = fixture.hook++;
    if (fixture.ready && index === 1) {
      const draft = state[0] as { bot: { name: string }; patch: (patch: { name: string }) => void };
      if (draft.bot.name !== "Fixture") draft.patch({ name: "Fixture", ...fixture.profile });
    }
    if (index === 1) return [state[0], fixture.setDraft];
    return fixture.ready && index === 3 ? [true, state[1]] : state;
  } };
});
vi.mock("@/lib/create-configured-bot", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/create-configured-bot")>(), createConfiguredBot: fixture.create,
}));
vi.mock("@/state/store", async importOriginal => {
  const store = await importOriginal<typeof import("@/state/store")>();
  return { ...store, api: fixture.api, BotEditorStore: () => null, useStore: () => ({ state: { ...store.initialState, appSettingsOpen: fixture.appSettingsOpen }, dispatch: fixture.dispatch }) };
});
import { NewBotDialog } from "./NewBotDialog";
import { setTeamChats } from "@/state/team-chats";
import { Select } from "./Select";
import type { BotCreationDraft } from "@/lib/bot-creation-draft";

type Node = ReactElement<{ children?: ReactNode; role?: string; "aria-label"?: string; onClick?: () => void; disabled?: boolean }>;
function nodes(value: ReactNode): Node[] {
  if (!isValidElement(value)) return [];
  const node = value as Node;
  return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
}
// One component's own output, without rendering the components inside it.
function output(element: Node): Node[] {
  let tree: ReactNode = null;
  function Capture() { tree = (element.type as (props: unknown) => ReactNode)(element.props); return null; }
  renderToStaticMarkup(createElement(Capture));
  return nodes(tree);
}
const named = (name: string) => (node: Node) => typeof node.type === "function" && node.type.name === name;
function chooseStartingRole(dialog: Node[], value: string) {
  const role = output(dialog.find(named("DraftSection"))!).find(named("StartingRole"))!;
  const select = output(role).find(node => node.type === Select)!;
  (select.props as unknown as { onChange: (event: { target: { value: string } }) => void }).onChange({ target: { value } });
}
function render(defaultsMode = false, onCreated?: () => void | Promise<void>) {
  let tree!: ReturnType<typeof NewBotDialog>;
  function Capture() { fixture.hook = 0; tree = NewBotDialog({ defaultsMode, onCreated, onClose: fixture.close }); return tree; }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, nodes: nodes(tree) };
}
beforeEach(() => {
  fixture.advanced = true;
  fixture.effects = []; fixture.dispatch.mockReset(); fixture.api.mockReset();
  fixture.ready = false; fixture.admin = false; fixture.create.mockReset(); fixture.setDraft.mockReset(); fixture.profile = {};
  fixture.track.mockReset();
  fixture.appSettingsOpen = false;
  fixture.openBot.mockReset();
  fixture.close.mockReset();
  fixture.api.mockReturnValue(new Promise(() => {}));
});
afterEach(() => { vi.unstubAllGlobals(); setTeamChats(null); });

describe("bot draft dialog", () => {
  it("preserves upstream audience selection for browser admins before creation", () => {
    fixture.admin = true;
    vi.stubGlobal("window", {});
    expect(render().html).toContain("Who can see it");
    expect(render().html).toContain("Admins only");
    expect(render(true).html).not.toContain("Who can see it");
    fixture.admin = false;
    expect(render().html).not.toContain("Who can see it");
    fixture.admin = true;
    vi.stubGlobal("window", { ogb: {} });
    expect(render().html).not.toContain("Who can see it");
  });
  it.each([false, true])("closes after a successful creation when its caller fails (async=%s)", async asyncFailure => {
    fixture.ready = true;
    const bot = { id: "created", name: "Fixture" };
    fixture.create.mockResolvedValue({ bot, warnings: [] });
    const failed = () => { throw new Error("Caller failed"); };
    const result = render(false, asyncFailure ? async () => failed() : failed);
    result.nodes.filter(node => node.type === "button").at(-1)!.props.onClick!();
    await vi.waitFor(() => expect(fixture.close).toHaveBeenCalledOnce());
    expect(fixture.create).toHaveBeenCalledTimes(1);
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "botAdded", bot, preserveSelection: false });
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "error", message: "Caller failed" });
  });
  it("creates a Full access bot at once, with no confirmation dialog", async () => {
    fixture.ready = true;
    fixture.profile = { approvalMode: "full" };
    const bot = { id: "created", name: "Fixture", approvalMode: "full" };
    fixture.create.mockResolvedValue({ bot, warnings: [] });
    const result = render();
    expect(result.html).not.toContain('role="alertdialog"');
    result.nodes.filter(node => node.type === "button").at(-1)!.props.onClick!();
    await vi.waitFor(() => expect(fixture.create).toHaveBeenCalledTimes(1));
    expect(fixture.create.mock.calls[0][0].bot).toMatchObject({ name: "Fixture", approvalMode: "full" });
    expect(fixture.create.mock.calls[0][0].consent).toEqual({});
    await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledWith({ type: "botAdded", bot, preserveSelection: false }));
  });

  it("steps aside while App settings, opened from inside it, is on top", () => {
    expect(render().html).not.toMatch(/^<div[^>]* hidden/);
    fixture.appSettingsOpen = true;
    expect(render().html).toMatch(/^<div[^>]* hidden/);
    expect(render(true).html).not.toMatch(/^<div[^>]* hidden/);
  });
  it("opens immediately with all sections and no creation request", () => {
    const result = render();
    expect(result.html).toContain('role="dialog"');
    for (const section of ["Identity", "Soul", "Skills", "Memory", "Routines", "Access", "Model", "Permissions", "Voice &amp; alerts"]) {
      expect(result.html).toContain(section);
    }
    fixture.advanced = false;
    const simple = render().html;
    expect(simple, "Simple mode picks no model: new bots use the default").not.toContain(">Model<");
    expect(simple).toContain(">Permissions<");
    fixture.effects[0]();
    expect(fixture.api).toHaveBeenCalledExactlyOnceWith("/api/bot-defaults");
    expect(fixture.dispatch).not.toHaveBeenCalled();
    const submit = result.nodes.find(node => node.type === "button" && node.props.disabled)!;
    expect(submit.props.disabled).toBe(true);
  });

  it.each([undefined, null, { instanceId: "", model: "" }])("fills an unselected saved default from the available model (%j)", async selection => {
    const available = { instanceId: "openrouter", model: "fixture-model" };
    fixture.api.mockResolvedValue({ defaults: { profile: { modelSelection: selection }, memory: {}, skills: [], routines: [] }, modelSelection: available, suggestedName: "Fixture" });
    render();
    fixture.effects[0]();
    await vi.waitFor(() => expect(fixture.setDraft).toHaveBeenCalledOnce());
    expect(fixture.setDraft.mock.calls[0]![0].bot.modelSelection).toEqual(available);
  });

  it.each([
    { instanceId: "claude", model: "chosen-model" },
    { instanceId: "claude", model: "" },
    { instanceId: "", model: "chosen-model" },
  ])("preserves an intentional saved model choice (%j)", async selection => {
    fixture.api.mockResolvedValue({ defaults: { profile: { modelSelection: selection }, memory: {}, skills: [], routines: [] }, modelSelection: { instanceId: "openrouter", model: "fixture-model" }, suggestedName: "Fixture" });
    render();
    fixture.effects[0]();
    await vi.waitFor(() => expect(fixture.setDraft).toHaveBeenCalledOnce());
    expect(fixture.setDraft.mock.calls[0]![0].bot.modelSelection).toEqual(selection);
  });

  it("can cancel a loading draft without creating or deleting a bot", () => {
    const result = render();
    result.nodes.find(node => node.type === "button" && node.props["aria-label"] === "Close")!.props.onClick!();
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(fixture.api).not.toHaveBeenCalled();
  });

  it.each([
    [["research"], { source: "template", template: "research" }],
    [["coder", ""], { source: "blank" }],
    [[], { source: "blank" }],
  ])("reports the starting role chosen in the dialog (%j) once the bot is created", async (choices, props) => {
    vi.stubGlobal("window", {});
    fixture.ready = true;
    fixture.create.mockResolvedValue({ bot: { id: "created", name: "Fixture" }, warnings: [] });
    const dialog = render().nodes;
    for (const value of choices) chooseStartingRole(dialog, value);
    dialog.filter(node => node.type === "button").at(-1)!.props.onClick!();
    await vi.waitFor(() => expect(fixture.close).toHaveBeenCalledOnce());
    expect(fixture.track.mock.calls).toEqual([["bot_created", props]]);
  });

  it("on a team's Cloud, opens the creator's own private chat with the new bot, never the team's shared main chat", async () => {
    setTeamChats({ teamId: "acme", member: false, opened: [] });
    fixture.ready = true;
    const bot = { id: "created", name: "Fixture" };
    fixture.create.mockResolvedValue({ bot, warnings: [] });
    render().nodes.filter(node => node.type === "button").at(-1)!.props.onClick!();
    await vi.waitFor(() => expect(fixture.openBot).toHaveBeenCalledTimes(1));
    expect(fixture.openBot.mock.calls[0].slice(0, 2)).toEqual([fixture.dispatch, bot]);
    const added = fixture.dispatch.mock.calls.findIndex(([action]) => action.type === "botAdded");
    expect(added).toBeGreaterThanOrEqual(0);
    expect(fixture.openBot.mock.invocationCallOrder[0]).toBeGreaterThan(fixture.dispatch.mock.invocationCallOrder[added]);
  });

  it("anywhere but a team's Cloud, leaves the new bot selected as it always was", async () => {
    fixture.ready = true;
    fixture.create.mockResolvedValue({ bot: { id: "created", name: "Fixture" }, warnings: [] });
    render().nodes.filter(node => node.type === "button").at(-1)!.props.onClick!();
    await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "botAdded" })));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fixture.openBot).not.toHaveBeenCalled();
  });

  it("reports a preset chosen after a starting role as the start, never naming the preset", async () => {
    vi.stubGlobal("window", {});
    fixture.ready = true;
    fixture.create.mockResolvedValue({ bot: { id: "created", name: "Fixture" }, warnings: [] });
    const dialog = render().nodes;
    chooseStartingRole(dialog, "coder");
    (dialog.find(named("DraftSection"))!.props as unknown as { draft: BotCreationDraft }).draft.choosePreset({ id: "My secret preset", skills: [], notes: [] });
    dialog.filter(node => node.type === "button").at(-1)!.props.onClick!();
    await vi.waitFor(() => expect(fixture.close).toHaveBeenCalledOnce());
    expect(fixture.track.mock.calls).toEqual([["bot_created", { source: "preset" }]]);
  });

  it("reports nothing when saving the defaults for new bots, or when creating fails", async () => {
    fixture.ready = true;
    fixture.api.mockResolvedValue({});
    render(true).nodes.filter(node => node.type === "button").at(-1)!.props.onClick!();
    await vi.waitFor(() => expect(fixture.api).toHaveBeenCalledWith("/api/config", expect.objectContaining({ method: "PATCH" })));
    fixture.create.mockRejectedValue(new Error("no engine"));
    render().nodes.filter(node => node.type === "button").at(-1)!.props.onClick!();
    await vi.waitFor(() => expect(fixture.create).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fixture.track).not.toHaveBeenCalled();
  });

  it("uses the same section editor for default templates", () => {
    const result = render(true);
    expect(result.html).toContain("Defaults for new bots");
    expect(result.html).toContain("Save defaults");
    expect(result.html).not.toContain(">Create bot<");
  });
});
