import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Routine } from "@/lib/routines";
import type { MemoryDoc } from "@/lib/memory";
import type { Bot, BotSettingsSection, InstanceInfo } from "@/state/store";
import { AVATAR_FOCUS_CENTER, AVATAR_ZOOM_MIN } from "../../shared/bot-avatar";
import type { ManagedSkill } from "./bot-settings/SkillsSection";
import type { BotApps } from "./bot-settings/useBotApps";

// Hook-by-call-order harness: component state survives between renders, effects never run, and handlers are read off
// the element tree.
const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", { confirm: () => true });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return {
    advanced: false,
    setAdvanced: (() => {}) as (enabled: boolean) => void,
    ownerOrAdmin: false as boolean | null,
    values: [] as unknown[],
    index: 0,
    own: 0,
    dispatch: (() => {}) as (...args: unknown[]) => void,
    api: (() => Promise.resolve({})) as (...args: unknown[]) => Promise<unknown>,
    storeState: {} as Record<string, unknown>,
    skills: {
      skills: [] as ManagedSkill[],
      loading: false,
      working: "",
      error: "",
      reviewing: null as null | { skill: ManagedSkill; text: string },
      toggle: (() => Promise.resolve()) as (skill: ManagedSkill) => Promise<void>,
      setWorking: (() => {}) as (name: string) => void,
      setError: (() => {}) as (error: string) => void,
      refresh: (() => Promise.resolve()) as () => Promise<void>,
      putAssignments: (() => Promise.resolve()) as (name: string, remove?: boolean) => Promise<void>,
    },
    memory: { docs: null as MemoryDoc[] | null, error: false, mine: false, setDoc: (() => {}) as (doc: MemoryDoc) => void, reload: () => Promise.resolve() },
    saveMemory: (() => Promise.resolve({ ok: true })) as (...args: unknown[]) => Promise<unknown>,
    openExternal: (() => Promise.resolve()) as (url: string) => Promise<void>,
    derived: {} as Record<string, unknown>,
    apps: { phase: "ready", apps: [], connectedSlugs: [] } as BotApps,
    places: {} as Record<string, [boolean, boolean, string]>,
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
vi.mock("@/lib/interface-mode", () => ({
  useAdvancedMode: () => fixture.advanced,
  setAdvancedMode: (enabled: boolean) => fixture.setAdvanced(enabled),
}));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.ownerOrAdmin }));
vi.mock("@/lib/app-links", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/app-links")>()),
  openExternalLink: (url: string) => fixture.openExternal(url),
}));
vi.mock("@/lib/memory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/memory")>()),
  saveMemoryDoc: (...args: unknown[]) => fixture.saveMemory(...args),
}));
// The server renderer cannot portal; the dialog's props are what these tests read.
vi.mock("./ConfirmDialog", () => ({ ConfirmDialog: () => null }));
vi.mock("./bot-settings/useSlackManagement", () => ({ useSlackManagementUrl: () => null }));
vi.mock("./bot-settings/useBotSettingsDerived", () => ({ useBotSettingsDerived: () => fixture.derived }));
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./DesktopCapabilities")>()),
  useCaptionChrome: () => ({ padClass: "" }),
}));
vi.mock("./Avatar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./Avatar")>()),
  BotAvatar: () => null,
}));
vi.mock("./ModelPicker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ModelPicker")>()),
  ModelPicker: (props: Record<string, unknown>) => createElement("div", { "data-stub-model-picker": true, "data-thread": props.threadId, "data-contained": props.contained }),
  ModelVariantRow: () => createElement("div", { "data-stub-variants": true }),
}));
vi.mock("./bot-settings/SkillsSection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bot-settings/SkillsSection")>()),
  useManagedSkills: () => ({ ...fixture.skills, setReviewing: () => {}, enableReviewed: () => Promise.resolve() }),
}));
vi.mock("./bot-panel/use-memory-doc", () => ({ useMemoryDoc: () => fixture.memory }));
vi.mock("./PlaceChip", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./PlaceChip")>()),
  usePlaceViews: () => Object.fromEntries(Object.entries(fixture.places).map(([place, [policy, reachable, short]]) =>
    [place, { policy, reachable, view: { state: reachable ? "ready" : "blocked", params: {}, short, line: `${short}.`, action: null } }])),
}));
vi.mock("./bot-settings/useBotApps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bot-settings/useBotApps")>()),
  useBotApps: () => fixture.apps,
}));
vi.mock("@/state/store", async (importOriginal) => {
  const store = await importOriginal<typeof import("@/state/store")>();
  return {
    ...store,
    api: (...args: unknown[]) => fixture.api(...args),
    useStore: () => ({
      state: { ...store.initialState, ...fixture.storeState },
      dispatch: fixture.dispatch,
      flushBotPatches: () => Promise.resolve(),
    }),
  };
});

const { BotSettingsDialog } = await import("./BotSettingsDialog");
const { BotPanel } = await import("./bot-panel/PanelShell");
const { PanelHero } = await import("./bot-panel/PanelHero");
const { AvatarEditorCard } = await import("./bot-panel/AvatarEditorCard");
const { DetailsTab } = await import("./bot-panel/DetailsTab");
const { BotConversations } = await import("./bot-panel/Conversations");
const { SettingsPage } = await import("./bot-panel/SettingsPage");
const { LibraryTab } = await import("./bot-panel/LibraryTab");
const { ApprovalChip } = await import("./ComposerPlusMenu");
const { callMode, setCallMode } = await import("@/lib/call-mode");
const { ComputerTab, WherePage } = await import("./bot-panel/ComputerTab");
const { PageBody, AppsPage, RoutinesPage, MemoryPage, SkillsPage, FolderPage, BrowserPage } = await import("./bot-panel/pages");
const { BrowserLogins } = await import("./bot-panel/browser-logins");
const { PAGES, sectionTarget } = await import("./bot-panel/page-registry");
const { openBotSettings } = await import("./bot-panel/panel-link");
const { PageHeader } = await import("./bot-panel/rows");
const { ChatShareMenu } = await import("./ChatMoreMenu");
const { SoulField } = await import("./SoulField");
const { LocalComputerAutoWarning } = await import("./LocalComputerAutoWarning");
const { ModelPicker } = await import("./ModelPicker");
const { ThreadModelsLine } = await import("./ThreadModelsLine");
const { ModelSection } = await import("./bot-settings/ModelSection");
const { RoutineList } = await import("./routines/RoutineList");
const { RoutineEditor } = await import("./RoutinesPage");
const { SignedInSites } = await import("./SignedInSites");
const { AvatarImageGenerator } = await import("./AvatarImageGenerator");
const { AvatarFraming } = await import("./avatar-editing");
const { MascotFaceColorPicker } = await import("./MascotFaceColorPicker");
const { Switch } = await import("./SettingsPrimitives");

afterAll(() => vi.unstubAllGlobals());

type Node = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
type Rendered = { html: string; nodes: Node[] };
function nodes(value: ReactNode): Node[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as Node;
    return [node, ...nodes(node.props.children), ...nodes(node.props.action as ReactNode), ...nodes(node.props.extra as ReactNode), ...nodes(node.props.label as ReactNode), ...nodes(node.props.hint as ReactNode)];
  });
}

function makeBot(extra: Partial<Bot> = {}): Bot {
  return {
    id: "scout", threadId: "thread-scout", name: "Scout", title: "Researcher", description: "", soul: "Be brief.",
    notifications: true, color: "green", unread: false, messages: [],
    modelSelection: { instanceId: "claude", model: "claude-opus-5-5" },
    ...extra,
  };
}

function capture(component: () => ReactNode): Rendered {
  fixture.values.length = Math.min(fixture.values.length, fixture.own);
  let tree: ReactNode = null;
  function Capture() {
    fixture.index = 0;
    tree = component();
    fixture.own = fixture.index;
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, nodes: nodes(tree) };
}

const fresh = () => {
  fixture.values = [];
  fixture.own = 0;
};
const patch = vi.fn();
const onOpen = vi.fn();
const onClose = vi.fn();
const onEditInstructions = vi.fn();
const derived = () => fixture.derived as never;
const panel = (bot: Bot, linkedSection: BotSettingsSection | null = null) =>
  capture(() => BotPanel({ bot, derived: derived(), linkedSection, onClose }));
const dialog = (bot: Bot) => capture(() => BotSettingsDialog({ bot }));
const botTab = (bot: Bot) => capture(() => DetailsTab({ bot, derived: derived(), onOpen }));
const settingsPage = (bot: Bot, editingInstructions = false) =>
  capture(() => SettingsPage({ bot, derived: derived(), onOpen, editingInstructions, onEditInstructions }));
const library = (bot: Bot) => capture(() => LibraryTab({ bot, onOpen }));
const computer = (bot: Bot) => capture(() => ComputerTab({ bot, derived: derived(), onOpen }));
const find = (rendered: { nodes: Node[] }, attr: string, value: unknown = true) => {
  const found = rendered.nodes.find((node) => node.props[attr] === value);
  if (!found) throw new Error(`no node with ${attr}=${String(value)}`);
  return found;
};
const segment = (rendered: { nodes: Node[] }, attr: string) => {
  const found = rendered.nodes.find((node) => node.props.attr === attr);
  if (!found) throw new Error(`no segmented control ${attr}`);
  return found.props as { value: unknown; onChange: (value: string) => void; options: Array<{ value: string; label: unknown; disabled?: boolean }> };
};
const has = (rendered: { nodes: Node[] }, attr: string, value: unknown = true) => rendered.nodes.some((node) => node.props[attr] === value);
const ofType = (rendered: { nodes: Node[] }, type: unknown) => rendered.nodes.find((node) => node.type === type);
const click = (node: Node) => (node.props.onClick as () => void)();
const change = (node: Node, value: string) => (node.props.onChange as (event: unknown) => void)({ target: { value } });
const submit = (node: Node) => (node.props.onSubmit as (event: unknown) => void)({ preventDefault: () => {} });
const key = (node: Node, name: string) => {
  const event = { key: name, defaultPrevented: false, target: null, preventDefault: vi.fn(), stopPropagation: vi.fn() };
  (node.props.onKeyDown as (event: unknown) => void)(event);
  return event;
};
const shown = (rendered: Rendered) => ({
  tab: rendered.nodes.find((node) => node.props["data-panel-tab"] !== undefined && node.props["aria-selected"] === true)?.props["data-panel-tab"],
  page: rendered.nodes.find((node) => node.type === PageBody)?.props.page,
});
const rowValue = (rendered: Rendered, page: string) => find(rendered, "data-panel-page", page).props.value;
const skill = (name: string, enabled: boolean, origin?: ManagedSkill["origin"]): ManagedSkill =>
  ({ name, description: `${name} helper`, enabled, source: "github:x/y", warnings: [], ...(origin ? { origin } : {}) });
const routine = (extra: Partial<Routine> = {}): Routine => ({
  id: "r1", name: "Morning brief", prompt: "Brief me", target: "bot", botId: "scout", runOn: "maus", enabled: true,
  schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] }, durationMinutes: 15,
  nextRunAt: Date.UTC(2099, 0, 5, 9), createdAt: 1, updatedAt: 1, ...extra,
});
const app = (slug: string, scope: "read" | "write" | null) => ({
  slug, label: slug[0]!.toUpperCase() + slug.slice(1), blurb: `${slug} things`, card: { logo: null, domain: null, label: slug }, scope,
});
const engine = (extra: Partial<InstanceInfo> & { capabilities?: Record<string, unknown> } = {}) => ({
  instanceId: "claude", driverKind: "claudeAgent", snapshot: { state: "available", authenticated: true },
  capabilities: { effortLevels: ["low", "medium", "high", "max"] }, ...extra,
});
const memoryDoc = (text: string): MemoryDoc => ({ path: "MEMORY.md", text, hash: "h1", exists: true });
const switches = (html: string) => html.match(/role="switch"/g)?.length ?? 0;
const pressed = (html: string, attr: string) => [...html.matchAll(new RegExp(`${attr}="([\\w-]+)" aria-pressed="true"`, "g"))].map((match) => match[1]);

beforeEach(() => {
  fixture.advanced = false;
  fixture.setAdvanced = vi.fn();
  fixture.ownerOrAdmin = false;
  fresh();
  fixture.index = 0;
  fixture.dispatch = vi.fn();
  fixture.api = vi.fn(() => Promise.resolve({}));
  fixture.saveMemory = vi.fn((_bot: unknown, path: unknown, text: unknown) => Promise.resolve({ ok: true, doc: { path, text, hash: "h2", exists: true } }));
  fixture.openExternal = vi.fn(() => Promise.resolve());
  fixture.storeState = { settingsOpen: true, botSettingsSection: "overview", botSettingsExpandAccordion: false };
  fixture.skills = {
    skills: [], loading: false, working: "", error: "", reviewing: null, toggle: vi.fn(() => Promise.resolve()),
    setWorking: vi.fn(), setError: vi.fn(), refresh: vi.fn(() => Promise.resolve()), putAssignments: vi.fn(() => Promise.resolve()),
  };
  fixture.memory = { docs: null, error: false, mine: false, setDoc: vi.fn(), reload: vi.fn(() => Promise.resolve()) };
  patch.mockReset();
  onOpen.mockReset();
  onClose.mockReset();
  onEditInstructions.mockReset();
  fixture.derived = {
    patch, approvalMode: "ask", engine: engine(), trustedModesAvailable: false, activeState: "idle",
    botRoutines: [], canCoordinate: true, sectionName: "General", mascotMotion: null,
    canUseConnectedApps: true, connectedAppsConfigured: true, connectedAppsEnabled: true, browserEnabled: true,
  };
  fixture.apps = { phase: "ready", apps: [], connectedSlugs: [] };
  fixture.places = {
    cloud: [true, true, "Cloud desktop"], vm: [true, true, "Private desktop"], local: [true, true, "Your screen"], browser: [true, true, "Web pages only"],
  };
  (window as unknown as { ogb?: unknown }).ogb = undefined;
});

describe("the bot panel in Simple mode", () => {
  it("has Share, a gear for Bot settings and a close button on top, the hero, and three tabs: Details, Library, Computer", () => {
    const bot = makeBot();
    const rendered = panel(bot);
    expect(ofType(rendered, ChatShareMenu)!.props.bot).toBe(bot);
    const gear = find(rendered, "data-panel-gear");
    expect([gear.props["aria-label"], gear.props.title]).toEqual(["Bot settings", "Bot settings"]);
    click(find(rendered, "aria-label", "Close settings"));
    expect(onClose).toHaveBeenCalled();
    const hero = ofType(rendered, PanelHero)!;
    expect(hero.props.bot).toBe(bot);
    expect(hero.props.patch).toBe(patch);
    const tabs = [...rendered.html.matchAll(/data-panel-tab="(\w+)"[^>]*>([^<]+)<\/button>/g)].map((match) => [match[1], match[2]]);
    expect(tabs).toEqual([["details", "Details"], ["library", "Library"], ["computer", "Computer"]]);
    expect(shown(rendered)).toEqual({ tab: "details", page: undefined });
    expect(ofType(rendered, DetailsTab)!.props.bot).toBe(bot);
    expect(rendered.html).toContain('id="bot-settings-title"');
  });

  it("switches tabs", () => {
    const bot = makeBot();
    for (const [tab, type] of [["computer", ComputerTab], ["library", LibraryTab], ["details", DetailsTab]] as const) {
      click(find(panel(bot), "data-panel-tab", tab));
      const rendered = panel(bot);
      expect(shown(rendered).tab).toBe(tab);
      expect(ofType(rendered, type)).toBeDefined();
    }
  });

  it("opens Bot settings from the gear on any tab, with Back to Details, and its apps with Back to Bot settings", () => {
    const bot = makeBot();
    click(find(panel(bot), "data-panel-tab", "library"));
    click(find(panel(bot), "data-panel-gear"));
    const settings = panel(bot);
    expect(shown(settings)).toEqual({ tab: undefined, page: "settings" });
    expect(ofType(settings, PageHeader)!.props).toMatchObject({ back: "Details", title: "Bot settings" });
    (ofType(settings, PageBody)!.props.onOpen as (page: string) => void)("apps");
    const apps = panel(bot);
    expect(ofType(apps, PageHeader)!.props).toMatchObject({ back: "Bot settings", title: "Apps it can use", intro: "Switch on the apps Scout may use. Everything else stays off." });
    (ofType(apps, PageHeader)!.props.onBack as () => void)();
    expect(shown(panel(bot)).page).toBe("settings");
    (ofType(panel(bot), PageHeader)!.props.onBack as () => void)();
    expect(shown(panel(bot))).toEqual({ tab: "details", page: undefined });
  });

  it("drills into a page with its intro and back, naming where Back goes", () => {
    const bot = makeBot();
    (ofType(panel(bot), DetailsTab)!.props.onOpen as (page: string) => void)("routines");
    const page = panel(bot);
    expect(shown(page)).toEqual({ tab: undefined, page: "routines" });
    expect(has(page, "role", "tablist")).toBe(false);
    expect(ofType(page, PageHeader)!.props).toMatchObject({ back: "Details", title: "Routines" });
    expect(page.html).toContain('id="bot-settings-title"');
    (ofType(page, PageHeader)!.props.onBack as () => void)();
    expect(shown(panel(bot))).toEqual({ tab: "details", page: undefined });

    click(find(panel(bot), "data-panel-tab", "library"));
    (ofType(panel(bot), LibraryTab)!.props.onOpen as (page: string) => void)("memory");
    expect(ofType(panel(bot), PageHeader)!.props).toMatchObject({ back: "Library", title: "What it remembers" });
    (ofType(panel(bot), PageHeader)!.props.onBack as () => void)();

    click(find(panel(bot), "data-panel-tab", "computer"));
    (ofType(panel(bot), ComputerTab)!.props.onOpen as (page: string) => void)("browser");
    expect(ofType(panel(bot), PageHeader)!.props).toMatchObject({ back: "Computer", title: "Signed-in sites", intro: undefined });
  });

  it("goes back on Escape from a page, and leaves Escape to the dialog on a tab", () => {
    const bot = makeBot();
    (ofType(panel(bot), DetailsTab)!.props.onOpen as (page: string) => void)("routines");
    const event = key(panel(bot).nodes[0]!, "Escape");
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(shown(panel(bot)).page).toBeUndefined();
    const onTab = key(panel(bot).nodes[0]!, "Escape");
    expect(onTab.stopPropagation).not.toHaveBeenCalled();
  });

  it("holds the Instructions editor open on Bot settings, and closes it when the panel moves on", () => {
    const bot = makeBot();
    click(find(panel(bot), "data-panel-gear"));
    expect(ofType(panel(bot), PageBody)!.props.editingInstructions).toBe(false);
    (ofType(panel(bot), PageBody)!.props.onEditInstructions as (open: boolean) => void)(true);
    expect(ofType(panel(bot), PageBody)!.props.editingInstructions).toBe(true);
    (ofType(panel(bot), PageHeader)!.props.onBack as () => void)();
    click(find(panel(bot), "data-panel-gear"));
    expect(ofType(panel(bot), PageBody)!.props.editingInstructions).toBe(false);
  });

  it("opens the avatar editor from the avatar and closes it with Escape", () => {
    const bot = makeBot();
    expect(ofType(panel(bot), AvatarEditorCard)).toBeUndefined();
    (ofType(panel(bot), PanelHero)!.props.onToggleEditor as () => void)();
    const open = panel(bot);
    const editor = ofType(open, AvatarEditorCard)!;
    expect(editor.props.onPatch).toBe(patch);
    expect(editor.props.bot).toBe(bot);
    key(open.nodes[0]!, "Escape");
    expect(ofType(panel(bot), AvatarEditorCard)).toBeUndefined();
  });

  it.each([
    ["overview", "details", undefined], ["identity", "details", undefined], ["slack", "details", undefined],
    ["soul", "details", "settings"], ["skills", "library", "skills"], ["memory", "library", "memory"],
    ["routines", "details", "routines"], ["access", "computer", undefined], ["model", "details", undefined],
    ["permissions", "details", "settings"], ["voice", "details", undefined], ["visibility", "details", undefined],
    ["history", "details", undefined], ["usage", "details", undefined],
  ] as const)("lands a deep link to %s on %s › %s", (section, tab, page) => {
    expect([sectionTarget(section).tab, sectionTarget(section).page]).toEqual([tab, page]);
    const rendered = panel(makeBot(), section);
    if (page) expect(shown(rendered).page).toBe(page);
    else expect(shown(rendered)).toEqual({ tab, page: undefined });
    if (page) expect(PAGES[page].home).toBe(tab);
  });

  it("opens Bot settings with the Instructions editor for a soul link, and scrolls Model and Before it acts into view", () => {
    expect(ofType(panel(makeBot(), "soul"), PageBody)!.props).toMatchObject({ page: "settings", editingInstructions: true });
    expect(sectionTarget("model").anchor).toBe("model");
    expect(sectionTarget("permissions")).toMatchObject({ page: "settings", anchor: "approval" });
    expect(sectionTarget("soul")).toMatchObject({ page: "settings", anchor: "instructions" });
  });

  // App tool grants (PluginsPanel) and the working folder (the files pane) name a Simple page; MCP and tool
  // selection name none, so they land where Access does.
  it.each([["apps", "apps"], ["folder", "folder"], ["mcp", undefined], ["tools", undefined]] as const)("lands an Access link naming %s on %s", (page, landing) => {
    try {
      openBotSettings(fixture.dispatch, "access", { page });
      const rendered = panel(makeBot(), "access");
      if (landing) expect(shown(rendered)).toEqual({ tab: undefined, page: landing });
      else expect(shown(rendered)).toEqual({ tab: "computer", page: undefined });
    } finally {
      // A link without a page lands where the section does: later tests see no trace of this one.
      openBotSettings(vi.fn(), "access");
    }
    fresh();
    expect(shown(panel(makeBot(), "access"))).toEqual({ tab: "computer", page: undefined });
  });

  it("shows no switch on any tab or on Bot settings: memory, upkeep, browser, record steps and Work until done live elsewhere", () => {
    const bot = makeBot();
    expect(switches(panel(bot).html)).toBe(0);
    expect(panel(bot).html).not.toContain('aria-label="Work until done"');
    for (const tab of ["library", "computer"]) {
      click(find(panel(bot), "data-panel-tab", tab));
      const rendered = panel(bot);
      expect(switches(rendered.html), tab).toBe(0);
      for (const text of ["Memory", "Upkeep", "Record"]) expect(rendered.html).not.toContain(`>${text}<`);
    }
    click(find(panel(bot), "data-panel-gear"));
    expect(switches(panel(bot).html)).toBe(0);
  });
});

describe("the hero", () => {
  const hero = (bot: Bot, editorOpen = false) =>
    capture(() => PanelHero({ bot, activeState: "idle", patch, editorOpen, onToggleEditor: vi.fn() }));

  it("labels the avatar Edit avatar and shows whether the editor is open", () => {
    const rendered = hero(makeBot(), true);
    expect(find(rendered, "data-panel-avatar").props["aria-label"]).toBe("Edit avatar");
    expect(find(rendered, "data-panel-avatar").props["aria-expanded"]).toBe(true);
    expect(rendered.html).toContain("Edit avatar");
  });

  it("renames inline: Enter saves the trimmed name, a blank name saves nothing", () => {
    const bot = makeBot();
    click(find(hero(bot), "data-panel-rename"));
    const editing = hero(bot);
    const input = find(editing, "data-panel-rename-input");
    expect(input.props.value).toBe("Scout");
    change(input, "  Nova ");
    key(find(hero(bot), "data-panel-rename-input"), "Enter");
    expect(patch).toHaveBeenLastCalledWith({ name: "Nova" });
    expect(has(hero(bot), "data-panel-rename-input")).toBe(false);

    patch.mockReset();
    click(find(hero(bot), "data-panel-rename"));
    change(find(hero(bot), "data-panel-rename-input"), "   ");
    (find(hero(bot), "data-panel-rename-input").props.onBlur as () => void)();
    expect(patch).not.toHaveBeenCalled();
  });

  it("saves a rename on blur and puts the old name back on Escape", () => {
    const bot = makeBot();
    click(find(hero(bot), "data-panel-rename"));
    change(find(hero(bot), "data-panel-rename-input"), "Atlas");
    (find(hero(bot), "data-panel-rename-input").props.onBlur as () => void)();
    expect(patch).toHaveBeenLastCalledWith({ name: "Atlas" });

    patch.mockReset();
    click(find(hero(bot), "data-panel-rename"));
    change(find(hero(bot), "data-panel-rename-input"), "Atlas");
    const input = find(hero(bot), "data-panel-rename-input");
    const event = key(input, "Escape");
    expect(event.stopPropagation).toHaveBeenCalled();
    (input.props.onBlur as () => void)();
    expect(patch).not.toHaveBeenCalled();
    expect(has(hero(bot), "data-panel-rename")).toBe(true);
  });

  it("sets the name at 17px, and shows the title line only once one is set", () => {
    expect(find(hero(makeBot()), "data-panel-rename").props.className).toContain("text-[17px]");
    const untitled = hero(makeBot({ title: "" }));
    expect(has(untitled, "data-panel-label")).toBe(false);
    expect(untitled.html).not.toContain("Add a label");
  });

  it("edits the title inline", () => {
    const bot = makeBot();
    expect(find(hero(bot), "data-panel-label").props.children).toBe("Researcher");
    click(find(hero(bot), "data-panel-label"));
    const input = find(hero(bot), "data-panel-label-input");
    expect(input.props.value).toBe("Researcher");
    change(input, "Writer");
    (find(hero(bot), "data-panel-label-input").props.onBlur as () => void)();
    expect(patch).toHaveBeenLastCalledWith({ title: "Writer" });

    click(find(hero(bot), "data-panel-label"));
    change(find(hero(bot), "data-panel-label-input"), "");
    key(find(hero(bot), "data-panel-label-input"), "Enter");
    expect(patch).toHaveBeenLastCalledWith({ title: "" });
  });
});

describe("the avatar editor", () => {
  const editor = (bot: Bot) => capture(() => AvatarEditorCard({ bot, activeState: "idle", onPatch: patch, onClose }));

  it("shows the ten bodies and twelve colors, with the Halloween bodies and the faces behind More looks", () => {
    const bot = makeBot();
    const rendered = editor(bot);
    expect(rendered.html.match(/aria-label="Use the \w+ body"/g)).toHaveLength(10);
    expect(rendered.html.match(/aria-label="Use \w+ mascot color"/g)).toHaveLength(12);
    expect(rendered.html).not.toContain(">Halloween<");
    expect(has(rendered, "data-avatar-face", "idle")).toBe(false);
    expect(find(rendered, "aria-label", "Use the Cursor body").props["aria-pressed"]).toBe(true);
    click(find(rendered, "aria-label", "Use the Blob body"));
    expect(patch).toHaveBeenLastCalledWith({ mascotBody: "blob" });
    click(find(rendered, "aria-label", "Use blue mascot color"));
    expect(patch).toHaveBeenLastCalledWith({ color: "blue" });
    expect(find(rendered, "aria-label", "Use silver mascot color").props.title).toBe("Silver");
    click(find(rendered, "aria-label", "Use silver mascot color"));
    expect(patch).toHaveBeenLastCalledWith({ color: "silver" });
    expect(find(rendered, "aria-label", "Use chrome mascot color").props.title).toBe("Chrome");
    click(find(rendered, "aria-label", "Use chrome mascot color"));
    expect(patch).toHaveBeenLastCalledWith({ color: "chrome" });

    const more = find(rendered, "data-avatar-more");
    expect(more.props["aria-expanded"]).toBe(false);
    expect(rendered.html).toContain(">More looks<");
    click(more);
    const open = editor(bot);
    expect(find(open, "data-avatar-more").props["aria-expanded"]).toBe(true);
    expect(open.html.match(/aria-label="Use the \w+ body"/g)).toHaveLength(20);
    expect(open.html).toContain(">Halloween<");
    click(find(open, "aria-label", "Use the Pumpkin body"));
    expect(patch).toHaveBeenLastCalledWith({ mascotBody: "pumpkin" });
    expect(find(open, "data-avatar-face", "idle").props["aria-pressed"]).toBe(true);
    click(find(open, "data-avatar-face", "proud"));
    expect(patch).toHaveBeenLastCalledWith({ mascotExpression: "proud" });
    expect(open.html).toContain(">Proud<");
  });

  it("opens More looks at once for a Halloween body or a chosen face", () => {
    expect(find(editor(makeBot({ mascotBody: "pumpkin" })), "data-avatar-more").props["aria-expanded"]).toBe(true);
    fresh();
    expect(find(editor(makeBot({ mascotExpression: "proud" })), "data-avatar-more").props["aria-expanded"]).toBe(true);
    fresh();
    expect(find(editor(makeBot()), "data-avatar-more").props["aria-expanded"]).toBe(false);
  });

  it("switches back to the mascot when a body is picked over a picture", () => {
    const bot = makeBot({ avatarUrl: "/api/attachments/cat.webp", avatarCrop: "circle" });
    click(find(editor(bot), "data-avatar-tab", "bot"));
    click(find(editor(bot), "aria-label", "Use the Star body"));
    expect(patch).toHaveBeenLastCalledWith({ mascotBody: "star", avatarCrop: "mascot" });
  });

  it("resets the mascot as the Advanced card does", () => {
    click(find(editor(makeBot()), "data-avatar-reset"));
    expect(patch).toHaveBeenLastCalledWith({ avatarCrop: "mascot", color: "green", mascotExpression: null, mascotBody: "cursor", mascotFaceColor: null });
  });

  it("edits facial feature color without changing body color or expression", () => {
    const props = ofType(editor(makeBot({ mascotFaceColor: "black" })), MascotFaceColorPicker)!.props;
    const choices = segment(capture(() => MascotFaceColorPicker(props as Parameters<typeof MascotFaceColorPicker>[0])), "data-avatar-face-color");
    expect(choices.value).toBe("black");
    expect(choices.options.map((option) => option.value)).toEqual(["white", "black"]);
    choices.onChange("white");
    expect(patch).toHaveBeenLastCalledWith({ mascotFaceColor: "white" });
  });

  it("generates with the shared generator, and uploads with shape and framing", () => {
    const bot = makeBot();
    click(find(editor(bot), "data-avatar-tab", "generate"));
    const generate = editor(bot);
    expect(ofType(generate, AvatarImageGenerator)!.props.botLabel).toBe("Researcher");

    click(find(generate, "data-avatar-tab", "upload"));
    const upload = editor(bot);
    expect(upload.html).toContain("Drop a picture here, or choose one");
    expect(upload.html).toContain("PNG, JPEG, GIF, or WebP · up to 10 MB");
    expect(segment(upload, "data-avatar-crop").options.map((option) => [option.value, option.disabled])).toEqual([
      ["circle", true], ["rounded", true], ["square", true],
    ]);
    expect(ofType(upload, AvatarFraming)).toBeUndefined();

    fresh();
    const pictured = makeBot({ avatarUrl: "/api/attachments/cat.webp", avatarCrop: "circle" });
    const withImage = editor(pictured);
    expect(find(withImage, "data-avatar-tab", "upload").props["aria-selected"]).toBe(true);
    expect(ofType(withImage, AvatarFraming)!.props.bot).toBe(pictured);
    expect(segment(withImage, "data-avatar-crop").value).toBe("circle");
    segment(withImage, "data-avatar-crop").onChange("square");
    expect(patch).toHaveBeenLastCalledWith({ avatarCrop: "square" });
    click(find(withImage, "aria-label", "Remove custom avatar image"));
    expect(patch).toHaveBeenLastCalledWith({ avatarUrl: null, avatarCrop: "mascot", avatarZoom: AVATAR_ZOOM_MIN, avatarFocusX: AVATAR_FOCUS_CENTER, avatarFocusY: AVATAR_FOCUS_CENTER });
  });

  it("closes on Escape without letting the dialog close settings", () => {
    const event = key(editor(makeBot()).nodes[0]!, "Escape");
    expect(onClose).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
  });
});


describe("the Details tab", () => {
  it("holds the model, the conversations, routines and this conversation's rows, in that order, with no switch or Thinking row", () => {
    const rendered = botTab(makeBot());
    expect(ofType(rendered, ModelPicker)!.props).toMatchObject({ bot: expect.objectContaining({ id: "scout" }), threadId: "thread-scout", contained: true });
    expect(ofType(rendered, BotConversations)!.props.bot).toMatchObject({ id: "scout" });
    const order = ['data-panel-row="model"', 'data-panel-card="conversations"', 'data-panel-empty="routines"', 'data-panel-item="find"', 'data-panel-item="activity"']
      .map((marker) => rendered.html.indexOf(marker));
    expect(order.every((index) => index > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const gone of ['data-panel-row="thinking"', 'data-panel-edit="soul"', 'data-panel-row="approval"', 'data-panel-row="goal"', 'data-panel-row="call-mode"',
      'data-panel-page="apps"', 'data-panel-page="memory"', 'data-panel-page="skills"', 'data-panel-page="folder"']) {
      expect(rendered.html, gone).not.toContain(gone);
    }
    expect(rendered.html).not.toContain(">Settings<");
    expect(switches(rendered.html)).toBe(0);
  });

  it("says what routines are while the bot has none, with Add a routine, and lists them once it has some", () => {
    const empty = botTab(makeBot());
    expect(empty.html).toContain('data-panel-empty="routines"');
    expect(empty.html).toContain(">Routines are recurring tasks this bot runs on a schedule. Ask it in chat to set one up.<");
    expect(empty.html.match(/data-panel-page="routines"/g)).toHaveLength(1);
    const add = find(empty, "data-panel-page", "routines");
    expect(add.props.children).toBe("Add a routine");
    click(add);
    expect(onOpen).toHaveBeenLastCalledWith("routines");
    fixture.derived.botRoutines = [routine()];
    const some = botTab(makeBot());
    expect(some.html).not.toContain('data-panel-empty="routines"');
    expect(some.html.indexOf('data-panel-card="conversations"')).toBeLessThan(some.html.indexOf('data-panel-page="routines"'));
  });

  it("values Routines by how many are on, and opens the routines page", () => {
    fixture.derived.botRoutines = [routine(), routine({ id: "r2", enabled: false }), routine({ id: "r3" })];
    const rendered = botTab(makeBot());
    expect(rowValue(rendered, "routines")).toBe("2 on");
    click(find(rendered, "data-panel-page", "routines"));
    expect(onOpen).toHaveBeenLastCalledWith("routines");
    fixture.derived.botRoutines = [routine({ enabled: false })];
    expect(rowValue(botTab(makeBot()), "routines")).toBe("None");
  });

  it("lists Find and Activity for this conversation as rows that run them, leaving Copy and Download to Share", () => {
    const rendered = botTab(makeBot());
    expect([...rendered.html.matchAll(/data-panel-item="(\w+)"/g)].map((match) => match[1])).toEqual(["find", "activity"]);
    expect(rendered.html).toContain(">Find in conversation<");
    const run = (key: string) => (rendered.nodes.find((node) => (node.props.item as { key?: string } | undefined)?.key === key)!.props.item as { onSelect: () => void }).onSelect();
    run("activity");
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "toggleActivity" });
  });
});

describe("the Bot settings page", () => {
  it("holds Instructions, Before it acts, Backup AIs, Call mode, Apps, Job and Hide, with every title on one edge", () => {
    const rendered = settingsPage(makeBot({ defaultBot: {} }));
    const order = ['data-panel-edit="soul"', 'data-panel-row="approval"', 'data-panel-row="backups"', 'data-panel-row="call-mode"', 'data-panel-page="apps"', 'data-panel-row="job"', 'data-panel-row="default-bot-hide"']
      .map((marker) => rendered.html.indexOf(marker));
    expect(order.every((index) => index > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(switches(rendered.html)).toBe(0);
    expect(rendered.html.match(/pl-\[38px\]/g)).toHaveLength(4);
  });

  it("shows the first line of the instructions, or how to start, and edits them in place with Done", () => {
    const bot = makeBot();
    const closed = settingsPage(bot);
    expect(closed.html).toContain("Be brief.");
    expect(ofType(closed, SoulField)).toBeUndefined();
    click(find(closed, "data-panel-edit", "soul"));
    expect(onEditInstructions).toHaveBeenLastCalledWith(true);
    expect(settingsPage(makeBot({ soul: "" })).html).toContain("Tell Scout how to work for you");

    const open = settingsPage(bot, true);
    expect(ofType(open, SoulField)!.props.onPatch).toBe(patch);
    expect(has(open, "data-panel-edit", "soul")).toBe(false);
    click(find(open, "data-panel-done", "soul"));
    expect(onEditInstructions).toHaveBeenLastCalledWith(false);

    const drifted = settingsPage(makeBot({ soulDrift: true }));
    expect(ofType(drifted, SoulField)).toBeDefined();
    expect(has(drifted, "data-panel-done", "soul")).toBe(false);
  });

  it("offers Ask me first and Just do it with no hint text, and writes either for every conversation", () => {
    const rendered = settingsPage(makeBot());
    const acts = segment(rendered, "data-approval-choice");
    expect(acts.options.map((option) => [option.value, option.label])).toEqual([["ask", "Ask me first"], ["full", "Just do it"]]);
    expect(acts.value).toBe("ask");
    for (const hint of ["Checks before changes", "Acts without checking", "Acts, then tells you"]) expect(rendered.html).not.toContain(`>${hint}<`);
    acts.onChange("ask");
    expect(fixture.dispatch).not.toHaveBeenCalled();
    acts.onChange("full");
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "updateBot", botId: "scout", patch: { approvalMode: "full", applyToAllThreads: true } });
    fixture.derived.approvalMode = "full";
    const full = settingsPage(makeBot());
    expect(pressed(full.html, "data-approval-choice")).toEqual(["full"]);
    segment(full, "data-approval-choice").onChange("ask");
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "updateBot", botId: "scout", patch: { approvalMode: "ask", applyToAllThreads: true } });
    expect(patch).not.toHaveBeenCalled();
  });

  it.each([["auto", "Decide for me", undefined], ["edits", "Auto-accept edits", undefined], ["custom", "Custom", "Change this in Advanced mode"]] as const)(
    "shows a bot in %s mode as a third, selected pill it cannot pick again, beside the two choices", (mode, label, tooltip) => {
      fixture.derived.approvalMode = mode;
      const rendered = settingsPage(makeBot());
      const acts = segment(rendered, "data-approval-choice");
      expect(acts.options.map((option) => [option.value, option.label, Boolean(option.disabled)])).toEqual([["ask", "Ask me first", false], ["full", "Just do it", false], [mode, label, true]]);
      expect((acts.options[2] as { tooltip?: string }).tooltip).toBe(tooltip);
      expect(pressed(rendered.html, "data-approval-choice")).toEqual([mode]);
      acts.onChange(mode);
      expect(fixture.dispatch).not.toHaveBeenCalled();
      acts.onChange("ask");
      expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "updateBot", botId: "scout", patch: { approvalMode: "ask", applyToAllThreads: true } });
    },
  );

  it("shows legacy Antigravity Auto as Ask without a third pill or a change to the saved mode", () => {
    fixture.derived.engine = engine({ driverKind: "antigravityAgent" });
    fixture.derived.approvalMode = "auto";
    const rendered = settingsPage(makeBot({ approvalMode: "auto" }));
    expect(segment(rendered, "data-approval-choice").options).toHaveLength(2);
    expect(pressed(rendered.html, "data-approval-choice")).toEqual(["ask"]);
    expect(patch).not.toHaveBeenCalled();
  });

  it("lets the approval level change while the bot is busy and says from when", () => {
    const rendered = settingsPage(makeBot({ busy: true }));
    expect(segment(rendered, "data-approval-choice").options.some((option) => option.disabled)).toBe(false);
    expect(rendered.html).toContain("The bot is working. A change applies from its next step");
    expect(settingsPage(makeBot()).html).not.toContain("The bot is working");
  });

  it("holds the conversation's approval level, the composer's choice, beside the bot's own", () => {
    expect(has(settingsPage(makeBot()), "data-panel-row", "thread-approval")).toBe(false);
    fixture.storeState = { ...fixture.storeState, instances: [engine({ displayName: "Claude" })] };
    const rendered = settingsPage(makeBot({ tasks: [{ threadId: "thread-scout", title: "Plan", createdAt: 1, approvalMode: "full" }] }));
    expect(has(rendered, "data-panel-row", "thread-approval")).toBe(true);
    expect(rendered.html).toContain(">In this conversation<");
    const choice = ofType(rendered, ApprovalChip)!.props.choice as Parameters<typeof ApprovalChip>[0]["choice"];
    expect(choice).toMatchObject({ approvalMode: "full", providerName: "Claude", driverKind: "claudeAgent" });
    choice.onSelect("ask");
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "updateTask", botId: "scout", threadId: "thread-scout", patch: { approvalMode: "ask" } });
  });

  it("chooses the call mode, Take turns or Live", () => {
    setCallMode("turns");
    try {
      const calls = segment(settingsPage(makeBot()), "data-call-mode");
      expect(calls.options.map((option) => [option.value, option.label])).toEqual([["turns", "Take turns"], ["live", "Live"]]);
      calls.onChange("live");
      expect(callMode()).toBe("live");
    } finally {
      setCallMode("turns");
    }
  });

  it("values the Apps row with the apps switched on, or None yet, and opens the apps page", () => {
    const empty = settingsPage(makeBot());
    expect(rowValue(empty, "apps")).toBe("None yet");
    click(find(empty, "data-panel-page", "apps"));
    expect(onOpen).toHaveBeenLastCalledWith("apps");
    fixture.apps = { phase: "ready", connectedSlugs: ["gmail", "notion", "slack"], apps: [app("gmail", "write"), app("notion", null), app("slack", "read")] };
    expect(rowValue(settingsPage(makeBot()), "apps")).toBe("Gmail, Slack");
  });

  it("edits the bot's job: saved on blur, Enter leaves the field, Escape puts it back", () => {
    const bot = makeBot();
    const job = () => find(settingsPage(bot), "data-panel-job");
    expect(job().props).toMatchObject({ value: "Researcher", placeholder: "What it does", "aria-label": "Job" });
    change(job(), "  Writer ");
    expect(job().props.value).toBe("  Writer ");
    (job().props.onBlur as () => void)();
    expect(patch).toHaveBeenLastCalledWith({ title: "Writer" });
    expect(job().props.value).toBe("Researcher");

    patch.mockReset();
    change(job(), "Editor");
    const escape = key(job(), "Escape");
    expect(escape.stopPropagation).toHaveBeenCalled();
    expect(job().props.value).toBe("Researcher");
    (job().props.onBlur as () => void)();
    expect(patch).not.toHaveBeenCalled();
  });
});

describe("the Library tab", () => {
  it("says what it will hold while the bot has made nothing, then what it remembers, its skills and its folder", () => {
    const rendered = library(makeBot());
    expect(rendered.html).toContain('data-panel-empty="library"');
    const order = ['data-panel-empty="library"', 'data-panel-page="memory"', 'data-panel-page="skills"', 'data-panel-page="folder"'].map((marker) => rendered.html.indexOf(marker));
    expect(order.every((index) => index > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("values What it remembers by the notes in MEMORY.md, says Off when memory is off, and opens the memory page", () => {
    expect(rowValue(library(makeBot()), "memory")).toBeUndefined();
    fixture.memory.docs = [memoryDoc("# Notes\n- Likes short replies\n- Uses Resolve\n- Works nights\n")];
    const rendered = library(makeBot());
    expect(rowValue(rendered, "memory")).toBe("3 notes");
    click(find(rendered, "data-panel-page", "memory"));
    expect(onOpen).toHaveBeenLastCalledWith("memory");
    fixture.memory.docs = [memoryDoc("- One thing\n")];
    expect(rowValue(library(makeBot()), "memory")).toBe("1 note");
    fixture.memory.docs = [memoryDoc("# Empty\n")];
    expect(rowValue(library(makeBot()), "memory")).toBe("Nothing yet");
    expect(rowValue(library(makeBot({ memoryEnabled: false })), "memory")).toBe("Off");
  });

  it("values Skills by how many are on, and opens the skills page", () => {
    expect(rowValue(library(makeBot()), "skills")).toBe("None");
    fixture.skills.skills = [skill("triage", true), skill("summarise", false), skill("deploy", true)];
    const rendered = library(makeBot());
    expect(rowValue(rendered, "skills")).toBe(2);
    click(find(rendered, "data-panel-page", "skills"));
    expect(onOpen).toHaveBeenLastCalledWith("skills");
    fixture.skills.loading = true;
    expect(rowValue(library(makeBot()), "skills")).toBeUndefined();
  });

  it("values Working folder as Private or the folder's short name, and opens the folder page", () => {
    const rendered = library(makeBot());
    expect(rowValue(rendered, "folder")).toBe("Private");
    click(find(rendered, "data-panel-page", "folder"));
    expect(onOpen).toHaveBeenLastCalledWith("folder");
    expect(rowValue(library(makeBot({ cwd: "/Users/omkar/Projects/site" })), "folder")).toBe("/Users/omkar/Projects/site");
  });
});

describe("the Computer tab", () => {
  it("shows the screen as one button that opens the full view, the caption, and where it works", () => {
    const rendered = computer(makeBot());
    expect(find(rendered, "data-panel-action", "open-computer").props["aria-label"]).toBe("Watch: Scout's screen");
    expect(rendered.html).toContain(">Not using its computer right now<");
    expect(rendered.html).toContain(">Watch<");
    expect(rendered.html).toContain("Scout&#x27;s screen");
    expect(rendered.html).toContain("Where Scout works");
    expect(rowValue(rendered, "where")).toBe("Let it choose");
    expect(has(rendered, "attr", "data-place-choice")).toBe(false);
    expect(switches(rendered.html)).toBe(0);
    click(find(rendered, "data-panel-page", "where"));
    expect(onOpen).toHaveBeenLastCalledWith("where");
    expect(computer(makeBot({ busy: true })).html).toContain("Working on a task.");
  });

  it("values Where it works with the place chosen, and says where it works right now when that differs", () => {
    expect(rowValue(computer(makeBot({ computer: "cloud" })), "where")).toBe("Cloud desktop");
    expect(rowValue(computer(makeBot({ computer: "vm" })), "where")).toBe("Private desktop");
    const at = (surface: "local" | "browser" | undefined, extra: Partial<Bot> = {}) =>
      computer(makeBot({ ...extra, tasks: [{ threadId: "thread-scout", title: "Main", ...(surface ? { surface } : {}) }] as Bot["tasks"] })).html;
    expect(at("local")).toContain("Right now: This PC");
    expect(at("browser")).toContain("Right now: Browser");
    expect(at(undefined)).not.toContain("Right now");
    expect(at("browser", { computer: "browser" })).not.toContain("Right now");
  });

  it("leads to the signed-in sites, and opens the full view from the screen", () => {
    const rendered = computer(makeBot());
    click(find(rendered, "data-panel-page", "browser"));
    expect(onOpen).toHaveBeenLastCalledWith("browser");
    for (const page of ["folder", "logins", "android"]) expect(has(rendered, "data-panel-page", page)).toBe(false);
    expect(has(rendered, "data-panel-row", "data")).toBe(false);
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { getItem: () => null, setItem });
    click(find(rendered, "data-panel-action", "open-computer"));
    expect(setItem).toHaveBeenLastCalledWith("omb-computer-panel-view:scout", "computer");
    expect((fixture.dispatch as ReturnType<typeof vi.fn>).mock.calls.slice(-2)).toEqual([
      [{ type: "toggleSettings", open: false }],
      [{ type: "toggleComputer", open: true }],
    ]);
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  });
});

describe("the Where it works page", () => {
  const where = (bot: Bot) => capture(() => WherePage({ bot, derived: derived() }));
  const choices = (rendered: Rendered) => rendered.nodes.filter((node) => node.props["data-panel-choice"] !== undefined)
    .map((node) => [node.props["data-panel-choice"], node.props.title, Boolean(node.props.disabled), node.props.checked]);
  const choose = (rendered: Rendered, value: string) => click(find(rendered, "data-panel-choice", value));

  it("offers Let it choose, this computer, the bot's browser and the Cloud desktop, with the chosen one checked", () => {
    // The tests run on no platform in particular, so this computer is a PC; a Mac says This Mac.
    expect(choices(where(makeBot()))).toEqual([
      ["auto", "Let it choose", false, true], ["local", "This PC", false, false], ["browser", "Browser", false, false], ["cloud", "Cloud desktop", false, false],
    ]);
    expect(where(makeBot()).html).toContain('role="radiogroup"');
  });

  it("saves each place through the bot patch, and sends nothing for the place already chosen", () => {
    const rendered = where(makeBot());
    choose(rendered, "cloud");
    expect(patch).toHaveBeenLastCalledWith({ computer: "cloud" });
    choose(rendered, "local");
    expect(patch).toHaveBeenLastCalledWith({ computer: "local" });
    choose(rendered, "browser");
    expect(patch).toHaveBeenLastCalledWith({ computer: "browser", browser: true });
    choose(where(makeBot({ computer: "cloud" })), "auto");
    expect(patch).toHaveBeenLastCalledWith({ computer: null });
    patch.mockReset();
    choose(where(makeBot({ computer: "cloud" })), "cloud");
    expect(patch).not.toHaveBeenCalled();
  });

  it.each([["vm", "Private desktop"], ["off", "Off"]] as const)("shows a bot kept on %s as a last, checked choice it cannot pick again", (place, label) => {
    const rendered = where(makeBot({ computer: place }));
    expect(choices(rendered).at(-1)).toEqual([place, label, true, true]);
    choose(rendered, place);
    expect(patch).not.toHaveBeenCalled();
    choose(rendered, "auto");
    expect(patch).toHaveBeenLastCalledWith({ computer: null });
  });

  it("holds a place the bot cannot use with the reason as its hint, and leaves out the Cloud desktop when none is offered", () => {
    fixture.places.cloud = [true, false, "Not ready"];
    expect(find(where(makeBot()), "data-panel-choice", "cloud").props).toMatchObject({ disabled: true, hint: "Not ready." });
    fixture.places.cloud = [false, false, "Not offered"];
    expect(choices(where(makeBot())).map(([value]) => value)).toEqual(["auto", "local", "browser"]);
    fixture.places.local = [false, false, "Not offered"];
    fixture.places.browser = [false, false, "Not offered"];
    expect(choices(where(makeBot())).map(([value]) => value)).toEqual(["auto"]);
    expect(choices(where(makeBot({ computer: "browser" }))).map(([value, , disabled]) => [value, disabled])).toEqual([["auto", false], ["browser", true]]);
  });

  it("names the browser My Chrome when the bot's profile is the person's own Chrome", () => {
    fixture.storeState = { ...fixture.storeState, config: { browserEngine: { myChrome: true }, browserProfiles: [{ id: "bank", name: "Bank", browser: "chrome" }] } };
    expect(find(where(makeBot({ browserProfile: "bank" })), "data-panel-choice", "browser").props.title).toBe("My Chrome");
    expect(find(where(makeBot()), "data-panel-choice", "browser").props.title).toBe("Browser");
  });

  it("says where the bot works right now when that is not the place chosen", () => {
    const html = where(makeBot({ computer: "cloud", tasks: [{ threadId: "thread-scout", title: "Main", surface: "local" }] as Bot["tasks"] })).html;
    expect(html).toContain("Right now: This PC");
  });

  it("warns before this computer for a bot that decides alone", () => {
    fixture.derived.approvalMode = "auto";
    const bot = makeBot();
    choose(where(bot), "local");
    expect(patch).not.toHaveBeenCalled();
    const warning = ofType(where(bot), LocalComputerAutoWarning)!;
    expect(warning.props.open).toBe(true);
    (warning.props.onConfirm as () => void)();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "updateBot", botId: "scout", patch: { computer: "local", acknowledgeLocalAuto: true } });
  });
});

describe("the drill-in pages", () => {
  const PAGE = {
    settings: SettingsPage, apps: AppsPage, routines: RoutinesPage, memory: MemoryPage, skills: SkillsPage, folder: FolderPage, browser: BrowserPage, where: WherePage,
  } as const;
  // The walker reads only what a component returns, so each page is called as the function PageBody picks.
  const body = (page: keyof typeof PAGE, bot = makeBot()) => capture(() => PAGE[page]({ bot, derived: derived() }) as ReactNode);

  it("draws one component per Simple page", () => {
    for (const page of Object.keys(PAGE) as Array<keyof typeof PAGE>) {
      const picked = ofType(capture(() => PageBody({ page, bot: makeBot(), derived: derived() }) as ReactNode), PAGE[page])!;
      expect(picked.props.bot, page).toMatchObject({ id: "scout" });
    }
  });
  const row = (rendered: { nodes: Node[] }, id: string) => find(rendered, "data-panel-row", id);

  it("gives each connected app one switch that writes the same scopes as Access, with no scopes or tool grants", () => {
    fixture.apps = { phase: "ready", connectedSlugs: ["github", "gmail", "slack"], apps: [app("github", "write"), app("gmail", "write"), app("slack", "write")] };
    const rendered = body("apps");
    expect(switches(rendered.html)).toBe(3);
    expect(rendered.html).not.toContain("Let Scout use apps");
    expect(rendered.html).not.toContain("Read only");
    expect(rendered.html).not.toContain("github things");
    click(find(rendered, "aria-label", "Scout can use Github"));
    expect(patch).toHaveBeenLastCalledWith({ connectorScopes: { apps: { gmail: "write", slack: "write" } } });

    fixture.apps = { phase: "ready", connectedSlugs: ["github", "gmail", "slack"], apps: [app("github", null), app("gmail", "read"), app("slack", "write")] };
    const scoped = body("apps", makeBot({ connectorScopes: { apps: { gmail: "read", slack: "write" } } }));
    expect(find(scoped, "aria-label", "Scout can use Github").props.checked).toBe(false);
    click(find(scoped, "aria-label", "Scout can use Github"));
    expect(patch).toHaveBeenLastCalledWith({ connectorScopes: { apps: { gmail: "read", slack: "write", github: "write" } } });
  });

  it("switching an app on while apps are off for the bot turns them on with only that app", () => {
    fixture.derived.connectedAppsEnabled = false;
    fixture.apps = { phase: "ready", connectedSlugs: ["gmail", "slack"], apps: [app("gmail", null), app("slack", null)] };
    click(find(body("apps", makeBot({ composio: false })), "aria-label", "Scout can use Gmail"));
    expect(patch).toHaveBeenLastCalledWith({ connectorScopes: { apps: { gmail: "write" } }, composio: true });
    patch.mockReset();
    click(find(body("apps", makeBot({ composio: false, connectorScopes: { apps: { slack: "write" } } })), "aria-label", "Scout can use Gmail"));
    expect(patch).toHaveBeenLastCalledWith({ connectorScopes: { apps: { slack: "write", gmail: "write" } }, composio: true });
  });

  it("says what it knows about the apps: checking, unreadable, empty or unusable, and leads to the catalog", () => {
    fixture.apps = { phase: "loading", apps: [], connectedSlugs: [] };
    expect(body("apps").html).toContain("Checking…");
    fixture.apps = { phase: "unknown", apps: [], connectedSlugs: [] };
    expect(body("apps").html).toContain("Couldn&#x27;t check your apps just now.");
    fixture.apps = { phase: "ready", apps: [], connectedSlugs: [] };
    const empty = body("apps");
    expect(empty.html).toContain("No apps connected yet.");
    click(find(empty, "data-panel-link", "add-app"));
    expect((fixture.dispatch as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      [{ type: "toggleSettings", open: false }],
      [{ type: "togglePlugins", open: true, surface: "apps" }],
    ]);
    fixture.derived.canUseConnectedApps = false;
    fixture.apps = { phase: "ready", connectedSlugs: ["gmail"], apps: [app("gmail", "write")] };
    const cannot = body("apps");
    expect(cannot.html).toContain("The model Scout runs on can&#x27;t use apps.");
    expect(switches(cannot.html)).toBe(0);
  });

  it("lists routines with switches, adds one locked to this bot, and says to ask in chat; no logs page, no schedules link", () => {
    const morning = routine();
    fixture.derived.botRoutines = [morning];
    const rendered = body("routines");
    const list = ofType(rendered, RoutineList)!;
    expect(list.props.routines).toBe(fixture.derived.botRoutines);
    (list.props.onToggle as (routine: Routine) => void)(morning);
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "updateRoutine", routineId: "r1", patch: { enabled: false } });
    expect(rendered.html).toContain('aria-label="Run Morning brief on its schedule" type="button" role="switch" aria-checked="true"');
    expect(rendered.html).toContain("Or just ask Scout in chat: “every weekday at 8, send me a summary”.");
    expect(rendered.html).not.toContain("Open schedules");
    expect(has(rendered, "data-panel-action", "routine-logs")).toBe(false);
    click(find(rendered, "data-panel-action", "new-routine"));
    expect(ofType(body("routines"), RoutineEditor)!.props).toMatchObject({ lockedBotId: "scout", routine: undefined });
  });

  it("lists what MEMORY.md remembers, forgets one line through the memory file route, and adds one", async () => {
    fixture.memory.docs = [memoryDoc("# Notes\n- Likes short replies\n\n- Uses Resolve Studio\n")];
    const rendered = body("memory");
    expect(rendered.html).toContain("Likes short replies");
    expect(rendered.html).toContain("Uses Resolve Studio");
    expect(rendered.html).not.toContain("# Notes");
    expect(switches(rendered.html)).toBe(0);
    for (const text of ["Tidy now", "Upkeep", "Obsidian", "Daily logs", "Journal"]) expect(rendered.html).not.toContain(text);
    click(rendered.nodes.filter((node) => node.props.label === "Forget")[0]!);
    await Promise.resolve();
    expect(fixture.saveMemory).toHaveBeenLastCalledWith("scout", "MEMORY.md", "# Notes\n\n- Uses Resolve Studio\n", "h1", false);
    await Promise.resolve();
    expect(fixture.memory.setDoc).toHaveBeenLastCalledWith(expect.objectContaining({ text: "# Notes\n\n- Uses Resolve Studio\n", hash: "h2" }));

    (find(body("memory"), "data-panel-form", "memory-add").props.onChange as (value: string) => void)("  Prefers the free version ");
    (find(body("memory"), "data-panel-form", "memory-add").props.onSubmit as () => void)();
    await Promise.resolve();
    expect(fixture.saveMemory).toHaveBeenLastCalledWith("scout", "MEMORY.md", "# Notes\n- Likes short replies\n\n- Uses Resolve Studio\n- Prefers the free version\n", "h1", false);
  });

  it("says when memory is off, empty or unreadable, and re-reads on a conflict", async () => {
    expect(body("memory", makeBot({ memoryEnabled: false })).html).toContain("Memory is off for Scout.");
    expect(has(body("memory", makeBot({ memoryEnabled: false })), "data-panel-form", "memory-add")).toBe(false);
    fixture.memory.docs = [memoryDoc("")];
    expect(body("memory").html).toContain("Nothing remembered yet.");
    fixture.memory = { ...fixture.memory, docs: null, error: true };
    expect(body("memory").html).toContain("Couldn&#x27;t read the memory file just now.");

    fixture.memory = { ...fixture.memory, docs: [memoryDoc("- Old\n")], error: false };
    fixture.saveMemory = vi.fn(() => Promise.resolve({ ok: false, conflict: true, current: "- New\n", currentHash: "h3" }));
    click(find(body("memory"), "label", "Forget"));
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.memory.reload).toHaveBeenCalled();
    expect(body("memory").html).toContain("Scout changed this file while you were editing.");
  });

  it("switches skills, removes one, adds one from a link and browses the library or skills.sh", async () => {
    const off = skill("summarise", false);
    const shared = skill("triage", true, "library");
    fixture.skills.skills = [shared, off];
    const rendered = body("skills");
    expect(row(rendered, "skill:summarise").props).toMatchObject({ checked: false, label: "Use summarise", hint: "summarise helper", disabled: false });
    (row(rendered, "skill:summarise").props.onChange as () => void)();
    expect(fixture.skills.toggle).toHaveBeenCalledWith(off);
    expect(rendered.html).not.toContain("Write a command");

    click(find(rendered, "data-panel-action", "remove-skill:summarise"));
    await Promise.resolve();
    expect(fixture.api).toHaveBeenCalledWith("/api/bots/scout/skills/summarise", { method: "DELETE" });
    await Promise.resolve();
    expect(fixture.skills.refresh).toHaveBeenCalled();
    click(find(rendered, "data-panel-action", "remove-skill:triage"));
    expect(fixture.skills.putAssignments).toHaveBeenCalledWith("triage", true);

    (find(rendered, "data-panel-form", "skill-import").props.onChange as (value: string) => void)("owner/repo");
    (find(body("skills"), "data-panel-form", "skill-import").props.onSubmit as () => void)();
    await Promise.resolve();
    expect(fixture.api).toHaveBeenCalledWith("/api/bots/scout/skills", { method: "POST", body: JSON.stringify({ source: "owner/repo" }) });

    click(find(rendered, "data-panel-link", "browse-skills"));
    expect(fixture.openExternal).toHaveBeenCalledWith("https://skills.sh");
    fixture.storeState = { ...fixture.storeState, config: { features: { skillsLibrary: true } } };
    click(find(body("skills"), "data-panel-link", "browse-skills"));
    expect((fixture.dispatch as ReturnType<typeof vi.fn>).mock.calls.slice(-2)).toEqual([
      [{ type: "toggleSettings", open: false }],
      [{ type: "toggleAppSettings", open: true, section: "skills" }],
    ]);
    fixture.skills.working = "triage";
    expect(row(body("skills"), "skill:summarise").props.disabled).toBe(true);
    fixture.skills.skills = [];
    expect(body("skills").html).toContain("No skills yet.");
  });

  it("keeps the bot's own private folder, or a folder chosen with the native picker, saved through the bot route", async () => {
    const pickFolder = vi.fn(() => Promise.resolve("/Users/omkar/Projects/site"));
    (window as unknown as { ogb: unknown }).ogb = { pickFolder };
    const rendered = body("folder");
    expect(find(rendered, "data-panel-choice", "private").props.checked).toBe(true);
    expect(find(rendered, "data-panel-choice", "pick").props.checked).toBe(false);
    expect(has(rendered, "data-panel-action", "pick-folder")).toBe(false);
    expect(rendered.html).not.toContain("Changed in this chat");
    click(find(rendered, "data-panel-choice", "pick"));
    await Promise.resolve();
    expect(pickFolder).toHaveBeenCalledWith(undefined);
    await Promise.resolve();
    expect(fixture.api).toHaveBeenCalledWith("/api/bots/scout", { method: "PATCH", body: JSON.stringify({ cwd: "/Users/omkar/Projects/site" }) });

    fresh();
    const chosen = body("folder", makeBot({ cwd: "/Users/omkar/Projects/site" }));
    expect(find(chosen, "data-panel-choice", "pick").props.checked).toBe(true);
    expect(chosen.html).toContain("/Users/omkar/Projects/site");
    click(find(chosen, "data-panel-action", "pick-folder"));
    expect(pickFolder).toHaveBeenLastCalledWith("/Users/omkar/Projects/site");
    click(find(chosen, "data-panel-choice", "private"));
    expect(fixture.api).toHaveBeenLastCalledWith("/api/bots/scout", { method: "PATCH", body: JSON.stringify({ cwd: null }) });
  });

  it("takes a typed path where there is no native picker", () => {
    const rendered = body("folder");
    click(find(rendered, "data-panel-choice", "pick"));
    const typed = body("folder");
    expect(find(typed, "data-panel-choice", "pick").props.checked).toBe(true);
    const form = find(typed, "data-panel-form", "folder-path");
    change(nodes(form.props.children).find((node) => node.type === "input")!, "/tmp/work");
    submit(find(body("folder"), "data-panel-form", "folder-path"));
    expect(fixture.api).toHaveBeenLastCalledWith("/api/bots/scout", { method: "PATCH", body: JSON.stringify({ cwd: "/tmp/work" }) });
  });

  it("shows only the signed-in sites on the browser page, with no browser or record-steps switch", () => {
    fixture.ownerOrAdmin = true;
    const page = body("browser");
    expect(ofType(page, BrowserLogins)!.props).toMatchObject({ bot: expect.objectContaining({ id: "scout" }), browserEnabled: true });
    const rendered = capture(() => BrowserLogins({ bot: makeBot(), browserEnabled: true, onOpenBrowser: vi.fn() }));
    expect(ofType(rendered, SignedInSites)!.props).toMatchObject({ bare: true, target: { bot: "scout" }, sharedBy: ["Scout"], disabled: false });
    expect(switches(rendered.html)).toBe(0);
    expect(rendered.html).not.toContain("Record");
    expect(rendered.html).not.toContain(">Logins<");
    const onOpenBrowser = vi.fn();
    click(find(capture(() => BrowserLogins({ bot: makeBot(), browserEnabled: true, onOpenBrowser })), "data-panel-action", "add-login"));
    expect(onOpenBrowser).toHaveBeenCalled();
    fixture.derived.browserEnabled = false;
    expect(ofType(body("browser"), BrowserLogins)!.props.browserEnabled).toBe(false);
    expect(capture(() => BrowserLogins({ bot: makeBot(), browserEnabled: false, onOpenBrowser: vi.fn() })).html).toContain("Scout&#x27;s browser is off.");
  });
});

describe("the bot settings dialog", () => {
  it("opens on the Simple panel without the accordion, and hands it the deep-linked section", () => {
    const bot = makeBot();
    const simple = dialog(bot);
    expect(simple.html).toContain('id="bot-panel"');
    const shell = ofType(simple, BotPanel)!;
    expect(shell.props.bot).toBe(bot);
    expect(shell.props.linkedSection).toBeNull();
    expect(simple.html).not.toContain("data-bot-settings-section");

    fresh();
    fixture.storeState = { settingsOpen: true, botSettingsSection: "model", botSettingsExpandAccordion: true };
    expect(ofType(dialog(bot), BotPanel)!.props.linkedSection).toBe("model");
  });

  it("a stored section never moves the Simple panel", () => {
    fixture.storeState = {
      settingsOpen: true, botSettingsSection: "model", botSettingsExpandAccordion: true,
      botSettingsSectionStored: true, botSettingsExpandRemembered: true,
    };
    expect(ofType(dialog(makeBot()), BotPanel)!.props.linkedSection).toBeNull();
  });

  it("leaves Advanced mode on the full accordion", () => {
    fixture.advanced = true;
    const rendered = dialog(makeBot());
    expect(ofType(rendered, BotPanel)).toBeUndefined();
    expect(rendered.html).not.toContain('id="bot-panel"');
    expect(rendered.html).toContain("Search settings");
    for (const label of ["Overview", "Identity", "Soul", "Skills", "Memory", "Routines", "Access", "Model", "Permissions", "Voice &amp; alerts", "History", "Usage"]) {
      expect(rendered.html).toContain(`>${label}</span>`);
    }
    // The accordion keeps the Memory and Access sections, where the memory, upkeep, browser and record-steps switches live.
    for (const section of ["memory", "access", "model", "permissions"]) expect(rendered.html).toContain(`data-bot-settings-section="${section}"`);
  });

  it("a stored section opens expanded in the full view", () => {
    fixture.advanced = true;
    fixture.storeState = {
      settingsOpen: true, botSettingsSection: "model", botSettingsExpandAccordion: true,
      botSettingsSectionStored: true, botSettingsExpandRemembered: true,
    };
    const rowOpen = (rendered: Rendered, id: string) =>
      (Children.toArray(find(rendered, "data-bot-settings-section", id).props.children)[0] as Node).props["aria-expanded"] === true;
    expect(rowOpen(dialog(makeBot()), "model")).toBe(true);
    const search = find(dialog(makeBot()), "aria-label", "Search settings");
    change(search, "model");
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "toggleSettings", open: true });
    fixture.storeState = { ...fixture.storeState, botSettingsExpandAccordion: false, botSettingsExpandRemembered: false };
    expect(rowOpen(dialog(makeBot()), "model")).toBe(false);
  });

  it("one click on a remembered-expanded row collapses it", () => {
    fixture.advanced = true;
    fixture.storeState = {
      settingsOpen: true, botSettingsSection: "model", botSettingsExpandAccordion: true,
      botSettingsSectionStored: true, botSettingsExpandRemembered: true,
    };
    const row = find(dialog(makeBot()), "data-bot-settings-section", "model");
    click(Children.toArray(row.props.children)[0] as Node);
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "toggleSettings", open: true });
  });

  it("shows Switch them too in the full Model section, and its button switches them", () => {
    fixture.advanced = true;
    fixture.storeState = { settingsOpen: true, botSettingsSection: "model", botSettingsExpandAccordion: true };
    const opus = { instanceId: "claude", model: "claude-opus-5-5" };
    const tasks = [
      { threadId: "thread-scout", title: "Follows", createdAt: 1, modelSelection: opus, followsBotModel: true },
      ...[0, 1, 2].map((index) => ({ threadId: `own-${index}`, title: `Own ${index}`, createdAt: 1, modelSelection: { instanceId: "codex", model: "gpt-5.6" }, followsBotModel: false })),
    ];
    const rendered = dialog(makeBot({ tasks }));
    expect(rendered.html).toContain("3 threads use their own model.");
    expect(rendered.html).toContain("Switch them too");
    fresh();
    const section = capture(() => ModelSection({ bot: makeBot({ tasks }) }));
    const line = ofType(section, ThreadModelsLine)!;
    click(capture(() => ThreadModelsLine(line.props as never)).nodes.find((node) => node.props["data-switch-them-too"] !== undefined)!);
    expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ type: "followBotModel", botId: "scout" }));
  });
});

describe("the panel's switches", () => {
  it("are the shared switch, in the bot's own color when on", () => {
    fixture.apps = { phase: "ready", connectedSlugs: ["gmail"], apps: [app("gmail", "write")] };
    const html = capture(() => PageBody({ page: "apps", bot: makeBot({ color: "blue" }), derived: derived() }) as ReactNode).html;
    expect(html.match(/role="switch"/g)).toHaveLength(1);
    expect(html).toContain("background-color:#377FE6");
    expect(Switch).toBeDefined();
  });
});
