import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Routine } from "@/lib/routines";
import type { BotOverview } from "@/lib/bot-overview-types";
import type { Bot, BotSettingsSection, Message } from "@/state/store";
import { AVATAR_FOCUS_CENTER, AVATAR_ZOOM_MIN } from "../../shared/bot-avatar";
import type { ManagedSkill } from "./bot-settings/SkillsSection";
import type { BotApps } from "./bot-settings/useBotApps";

// Hook-by-call-order harness: component state survives between renders, effects never run, and handlers are read off
// the element tree.
const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return {
    advanced: false,
    setAdvanced: (() => {}) as (enabled: boolean) => void,
    ownerOrAdmin: false as boolean | null,
    values: [] as unknown[],
    index: 0,
    own: 0,
    dispatch: (() => {}) as (...args: unknown[]) => void,
    storeState: {} as Record<string, unknown>,
    skills: {
      skills: [] as ManagedSkill[],
      loading: false,
      working: "",
      error: "",
      reviewing: null as null | { skill: ManagedSkill; text: string },
      toggle: (() => Promise.resolve()) as (skill: ManagedSkill) => Promise<void>,
    },
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
vi.mock("./bot-settings/SkillsSection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bot-settings/SkillsSection")>()),
  useManagedSkills: () => ({ ...fixture.skills, setReviewing: () => {}, enableReviewed: () => Promise.resolve() }),
}));
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
const { LibraryTab } = await import("./bot-panel/LibraryTab");
const { ComputerTab } = await import("./bot-panel/ComputerTab");
const { SettingsTab } = await import("./bot-panel/SettingsTab");
const { PageBody, SetupPage } = await import("./bot-panel/pages");
const { AppsCard, BrowserLogins } = await import("./bot-panel/apps-and-logins");
const { botLibraryItems, memoryEntries } = await import("./bot-panel/library-items");
const { PAGES, sectionTarget } = await import("./bot-panel/page-registry");
const { openBotSettings } = await import("./bot-panel/panel-link");
const { PageHeader } = await import("./bot-panel/rows");
const { ChatMoreMenu } = await import("./ChatMoreMenu");
const { SoulField } = await import("./SoulField");
const { LocalComputerAutoWarning } = await import("./LocalComputerAutoWarning");
const { ModelPicker } = await import("./ModelPicker");
const { ThreadModelsLine } = await import("./ThreadModelsLine");
const { ModelSection } = await import("./bot-settings/ModelSection");
const { MemorySection } = await import("./bot-settings/MemorySection");
const { AccessSection } = await import("./bot-settings/AccessSection");
const { PermissionsSection } = await import("./bot-settings/PermissionsSection");
const { RoutinesSection } = await import("./bot-settings/RoutinesSection");
const { OverviewSection } = await import("./bot-settings/OverviewSection");
const { RoutineEditor } = await import("./RoutinesPage");
const { PhoneAppDialog } = await import("./PhoneAppDialog");
const { ConfirmDialog } = await import("./ConfirmDialog");
const { AvatarImageGenerator } = await import("./AvatarImageGenerator");
const { AvatarFraming } = await import("./avatar-editing");
const { Switch } = await import("./SettingsPrimitives");

afterAll(() => vi.unstubAllGlobals());

type Node = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
type Rendered = { html: string; nodes: Node[] };
function nodes(value: ReactNode): Node[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as Node;
    return [node, ...nodes(node.props.children), ...nodes(node.props.action as ReactNode)];
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
const onGo = vi.fn();
const onClose = vi.fn();
const derived = () => fixture.derived as never;
const panel = (bot: Bot, linkedSection: BotSettingsSection | null = null, slackUrl: string | null = null) =>
  capture(() => BotPanel({ bot, derived: derived(), linkedSection, slackUrl, onClose }));
const dialog = (bot: Bot) => capture(() => BotSettingsDialog({ bot }));
const details = (bot: Bot, overview: BotOverview | null = null) => capture(() => DetailsTab({ bot, derived: derived(), overview, onOpen }));
const library = (bot: Bot) => capture(() => LibraryTab({ bot, onOpen }));
const computer = (bot: Bot) => capture(() => ComputerTab({ bot, derived: derived(), onOpen }));
const settings = (bot: Bot, query = "", slackUrl: string | null = null) =>
  capture(() => SettingsTab({ bot, derived: derived(), slackUrl, query, onQuery: vi.fn(), onOpen, onGo }));
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
const key = (node: Node, name: string) => {
  const event = { key: name, defaultPrevented: false, target: null, preventDefault: vi.fn(), stopPropagation: vi.fn() };
  (node.props.onKeyDown as (event: unknown) => void)(event);
  return event;
};
const shown = (rendered: Rendered) => ({
  tab: rendered.nodes.find((node) => node.props["data-panel-tab"] !== undefined && node.props["aria-selected"] === true)?.props["data-panel-tab"],
  page: rendered.nodes.find((node) => node.type === PageBody)?.props.page
    ?? (rendered.nodes.some((node) => node.props["data-panel-page-view"] === "memory" && node.props.hidden === false) ? "memory" : undefined),
});
const skill = (name: string, enabled: boolean): ManagedSkill => ({ name, description: `${name} helper`, enabled, source: "github:x/y", warnings: [] });
const routine = (extra: Partial<Routine> = {}): Routine => ({
  id: "r1", name: "Morning brief", prompt: "Brief me", target: "bot", botId: "scout", runOn: "maus", enabled: true,
  schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] }, durationMinutes: 15,
  nextRunAt: Date.UTC(2099, 0, 5, 9), createdAt: 1, updatedAt: 1, ...extra,
});
const app = (slug: string, scope: "read" | "write" | null) => ({
  slug, label: slug[0]!.toUpperCase() + slug.slice(1), blurb: `${slug} things`, card: { logo: null, domain: null, label: slug }, scope,
});
const overviewWith = (setup: BotOverview["setup"]): BotOverview => ({
  who: { name: "Scout", title: "", blurb: "", soulLead: "" }, does: [], reaches: [], wont: [], recent: [], setup,
});

beforeEach(() => {
  fixture.advanced = false;
  fixture.setAdvanced = vi.fn();
  fixture.ownerOrAdmin = false;
  fresh();
  fixture.index = 0;
  fixture.dispatch = vi.fn();
  fixture.storeState = { settingsOpen: true, botSettingsSection: "overview", botSettingsExpandAccordion: false };
  fixture.skills = { skills: [], loading: false, working: "", error: "", reviewing: null, toggle: vi.fn(() => Promise.resolve()) };
  patch.mockReset();
  onOpen.mockReset();
  onGo.mockReset();
  onClose.mockReset();
  fixture.derived = {
    patch, approvalMode: "ask", engine: { driverKind: "claudeAgent" }, trustedModesAvailable: false, activeState: "idle",
    botRoutines: [], canCoordinate: true, sectionName: "General", mascotMotion: null,
    canUseConnectedApps: true, connectedAppsConfigured: true, connectedAppsEnabled: true, browserEnabled: true,
  };
  fixture.apps = { phase: "ready", apps: [], connectedSlugs: [] };
  fixture.places = {
    cloud: [true, true, "Cloud computer"], vm: [true, true, "Private desktop"], local: [true, true, "Your screen"], browser: [true, true, "Web pages only"],
  };
});

describe("the bot panel in Simple mode", () => {
  it("has the chat menu and a close button on top, the hero, and four tabs with Details first", () => {
    const bot = makeBot();
    const rendered = panel(bot);
    expect(ofType(rendered, ChatMoreMenu)!.props.bot).toBe(bot);
    click(find(rendered, "aria-label", "Close settings"));
    expect(onClose).toHaveBeenCalled();
    const hero = ofType(rendered, PanelHero)!;
    expect(hero.props.bot).toBe(bot);
    expect(hero.props.patch).toBe(patch);
    const tabs = [...rendered.html.matchAll(/data-panel-tab="(\w+)"[^>]*>([^<]+)<\/button>/g)].map((match) => [match[1], match[2]]);
    expect(tabs).toEqual([["details", "Details"], ["library", "Library"], ["computer", "Computer"], ["settings", "Settings"]]);
    expect(shown(rendered)).toEqual({ tab: "details", page: undefined });
    expect(ofType(rendered, DetailsTab)!.props.bot).toBe(bot);
    expect(rendered.html).toContain('id="bot-settings-title"');
  });

  it("switches tabs", () => {
    const bot = makeBot();
    for (const [tab, type] of [["library", LibraryTab], ["computer", ComputerTab], ["settings", SettingsTab], ["details", DetailsTab]] as const) {
      click(find(panel(bot), "data-panel-tab", tab));
      const rendered = panel(bot);
      expect(shown(rendered).tab).toBe(tab);
      expect(ofType(rendered, type)).toBeDefined();
    }
  });

  it("drills into a page and back, naming where Back goes", () => {
    const bot = makeBot();
    (ofType(panel(bot), DetailsTab)!.props.onOpen as (page: string) => void)("instructions");
    const page = panel(bot);
    expect(shown(page)).toEqual({ tab: undefined, page: "instructions" });
    expect(has(page, "role", "tablist")).toBe(false);
    expect(ofType(page, PageHeader)!.props).toMatchObject({ back: "Details", title: "Instructions" });
    expect(page.html).toContain('id="bot-settings-title"');

    (ofType(page, PageBody)!.props.onOpen as (page: string) => void)("history");
    const deeper = panel(bot);
    expect(shown(deeper).page).toBe("history");
    expect(ofType(deeper, PageHeader)!.props).toMatchObject({ back: "Instructions", title: "History" });

    (ofType(deeper, PageHeader)!.props.onBack as () => void)();
    expect(shown(panel(bot)).page).toBe("instructions");
    (ofType(panel(bot), PageHeader)!.props.onBack as () => void)();
    expect(shown(panel(bot))).toEqual({ tab: "details", page: undefined });
  });

  it("goes back on Escape from a page, and leaves Escape to the dialog on a tab", () => {
    const bot = makeBot();
    (ofType(panel(bot), DetailsTab)!.props.onOpen as (page: string) => void)("model");
    const event = key(panel(bot).nodes[0]!, "Escape");
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(shown(panel(bot)).page).toBeUndefined();
    const onTab = key(panel(bot).nodes[0]!, "Escape");
    expect(onTab.stopPropagation).not.toHaveBeenCalled();
  });

  it("keeps Memory mounted once opened, so a draft survives Back", () => {
    const bot = makeBot();
    expect(ofType(panel(bot), MemorySection)).toBeUndefined();
    (ofType(panel(bot), DetailsTab)!.props.onOpen as (page: string) => void)("memory");
    const open = panel(bot);
    expect(shown(open).page).toBe("memory");
    const memory = ofType(open, MemorySection)!;
    expect(memory.props.active).toBe(true);
    (memory.props.onToggle as (enabled: boolean) => void)(false);
    expect(patch).toHaveBeenLastCalledWith({ memoryEnabled: false });
    (ofType(open, PageHeader)!.props.onBack as () => void)();
    const back = panel(bot);
    expect(ofType(back, MemorySection)!.props.active).toBe(false);
    expect(find(back, "data-panel-page-view", "memory").props.hidden).toBe(true);
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
    ["overview", "settings", "overview"], ["identity", "details", undefined], ["slack", "settings", "slack"],
    ["soul", "details", "instructions"], ["skills", "library", "skills"], ["memory", "library", "memory"],
    ["routines", "details", "routines"], ["access", "computer", undefined], ["model", "details", "model"],
    ["permissions", "details", "approvals"], ["voice", "settings", "voice"], ["visibility", "settings", "visibility"],
    ["history", "settings", "history"], ["usage", "settings", undefined],
  ] as const)("lands a deep link to %s on %s › %s", (section, tab, page) => {
    expect([sectionTarget(section).tab, sectionTarget(section).page]).toEqual([tab, page]);
    const rendered = panel(makeBot(), section);
    if (page) expect(shown(rendered).page).toBe(page);
    else expect(shown(rendered)).toEqual({ tab, page: undefined });
    if (page) expect(PAGES[page].home).toBe(tab);
  });

  it("scrolls Usage into view on the Settings tab", () => {
    expect(sectionTarget("usage").anchor).toBe("activity");
  });

  // App tool grants (PluginsPanel), MCP access, a place's tool selection, the working folder.
  it.each(["apps", "mcp", "tools", "folder"] as const)("opens Access on the %s page when a link names it", (page) => {
    try {
      openBotSettings(fixture.dispatch, "access", { page });
      expect(shown(panel(makeBot(), "access"))).toEqual({ tab: undefined, page });
    } finally {
      // A link without a page lands where the section does: later tests see no trace of this one.
      openBotSettings(vi.fn(), "access");
    }
    fresh();
    expect(shown(panel(makeBot(), "access"))).toEqual({ tab: "computer", page: undefined });
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

  it("offers Add a label without a title, and edits the title inline", () => {
    expect(hero(makeBot({ title: "" })).html).toContain("Add a label");
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

  it("picks one of the ten bodies, ten colors and a face for the mascot", () => {
    const bot = makeBot();
    const rendered = editor(bot);
    expect(rendered.html.match(/aria-label="Use the \w+ body"/g)).toHaveLength(10);
    expect(rendered.html.match(/aria-label="Use \w+ mascot color"/g)).toHaveLength(10);
    expect(find(rendered, "aria-label", "Use the Cursor body").props["aria-pressed"]).toBe(true);
    click(find(rendered, "aria-label", "Use the Blob body"));
    expect(patch).toHaveBeenLastCalledWith({ mascotBody: "blob" });
    click(find(rendered, "aria-label", "Use blue mascot color"));
    expect(patch).toHaveBeenLastCalledWith({ color: "blue" });
    expect(find(rendered, "data-avatar-face", "idle").props["aria-pressed"]).toBe(true);
    click(find(rendered, "data-avatar-face", "proud"));
    expect(patch).toHaveBeenLastCalledWith({ mascotExpression: "proud" });
    expect(rendered.html).toContain(">Proud<");
  });

  it("switches back to the mascot when a body is picked over a picture", () => {
    const bot = makeBot({ avatarUrl: "/api/attachments/cat.webp", avatarCrop: "circle" });
    click(find(editor(bot), "data-avatar-tab", "bot"));
    click(find(editor(bot), "aria-label", "Use the Star body"));
    expect(patch).toHaveBeenLastCalledWith({ mascotBody: "star", avatarCrop: "mascot" });
  });

  it("resets the mascot as the Advanced card does", () => {
    click(find(editor(makeBot()), "data-avatar-reset"));
    expect(patch).toHaveBeenLastCalledWith({ avatarCrop: "mascot", color: "green", mascotExpression: null, mascotBody: "cursor" });
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
  it("shows Finish setting up only while setup ideas remain", () => {
    expect(has(details(makeBot()), "data-panel-page", "setup")).toBe(false);
    expect(has(details(makeBot(), overviewWith([{ id: "soul", label: "Write instructions", done: true }])), "data-panel-page", "setup")).toBe(false);
    const rendered = details(makeBot(), overviewWith([
      { id: "soul", label: "Write instructions", done: false, section: "soul" },
      { id: "apps", label: "Connect an app", done: false, section: "access" },
    ]));
    expect(rendered.html).toContain("2 ideas to make Scout more useful");
    click(find(rendered, "data-panel-page", "setup"));
    expect(onOpen).toHaveBeenLastCalledWith("setup");
  });

  it("picks the model in the contained picker for the open thread, with Thinking on its own row", () => {
    fixture.derived.engine = { driverKind: "claudeAgent", capabilities: { effortLevels: ["low", "medium", "high", "max"] } };
    const bot = makeBot({ modelSelection: { instanceId: "claude", model: "claude-opus-5-5", effort: "medium" } });
    const rendered = details(bot);
    const picker = ofType(rendered, ModelPicker)!;
    // As the Advanced header's picker: the thread's view of the bot and its thread, so a Cloud guest's pick stays in
    // their own conversation while an owner's also sets the bot's default.
    expect(picker.props).toMatchObject({ bot, contained: true, threadId: "thread-scout" });
    expect(picker.key).toMatch(/thread-scout$/);
    const onOwnModel = makeBot({ tasks: [{ threadId: "thread-scout", title: "Side", createdAt: 1, modelSelection: { instanceId: "claude", model: "claude-haiku-4-5" } }] });
    expect((ofType(details(onOwnModel), ModelPicker)!.props.bot as Bot).modelSelection.model).toBe("claude-haiku-4-5");
    expect(String(find(rendered, "data-simple-default-model").props.className)).toContain("[&_[data-simple-effort]]:hidden");
    expect(rendered.html).toContain("More thinking is slower and more careful.");
    const thinking = segment(rendered, "data-thinking-choice");
    expect(thinking.options.map((option) => [option.value, option.label])).toEqual([["low", "Quick"], ["medium", "Balanced"], ["high", "Deep"], ["max", "Max"]]);
    expect(thinking.value).toBe("medium");
    thinking.onChange("high");
    expect(fixture.dispatch).toHaveBeenLastCalledWith({
      type: "setModel", botId: "scout", selection: { instanceId: "claude", model: "claude-opus-5-5", effort: "high" },
    });
    (fixture.dispatch as ReturnType<typeof vi.fn>).mockClear();
    thinking.onChange("medium");
    expect(fixture.dispatch).not.toHaveBeenCalled();
    click(find(rendered, "data-panel-link", "model"));
    expect(onOpen).toHaveBeenLastCalledWith("model");
  });

  it("has no Thinking row where the engine has no steps or keeps its own variants", () => {
    expect(details(makeBot()).html).not.toContain("data-thinking-choice");
    fixture.derived.engine = { driverKind: "acp", capabilities: { effortLevels: ["low", "high"], modelVariants: true } };
    const variants = details(makeBot());
    expect(variants.html).not.toContain("data-thinking-choice");
    expect(String(find(variants, "data-simple-default-model").props.className)).not.toContain("hidden");
  });

  it("holds Thinking while a turn runs", () => {
    fixture.derived.engine = { driverKind: "claudeAgent", capabilities: { effortLevels: ["low", "high"] } };
    const busy = details(makeBot({ busy: true }));
    expect(busy.html).toMatch(/data-thinking-choice="high" aria-pressed="false" disabled=""/);
  });

  it("edits instructions in place, and opens the box by itself while the file has drifted", () => {
    const bot = makeBot();
    const closed = details(bot);
    expect(closed.html).toContain("Be brief.");
    expect(ofType(closed, SoulField)).toBeUndefined();
    click(find(closed, "data-panel-edit", "soul"));
    const open = details(bot);
    expect(ofType(open, SoulField)!.props.onPatch).toBe(patch);
    click(find(open, "data-panel-done", "soul"));
    expect(ofType(details(bot), SoulField)).toBeUndefined();

    expect(details(makeBot({ soul: "" })).html).toContain("No instructions yet.");
    const drifted = details(makeBot({ soulDrift: true }));
    expect(ofType(drifted, SoulField)).toBeDefined();
    expect(has(drifted, "data-panel-done", "soul")).toBe(false);
  });

  it("sets the reply style, and leads to SOUL.md and earlier versions", () => {
    const rendered = details(makeBot());
    expect(segment(rendered, "data-reply-style-choice").value).toBe("default");
    segment(rendered, "data-reply-style-choice").onChange("conversational");
    expect(patch).toHaveBeenLastCalledWith({ replyStyle: "conversational" });
    click(find(rendered, "data-panel-link", "instructions"));
    expect(onOpen).toHaveBeenLastCalledWith("instructions");
  });

  it("maps the three choices onto Ask, Approve for me and Full access", () => {
    const rendered = details(makeBot());
    const acts = segment(rendered, "data-approval-choice");
    expect(acts.options.map((option) => [option.value, option.label])).toEqual([["ask", "Ask me first"], ["auto", "Decide for me"], ["full", "Full access"]]);
    expect(acts.value).toBe("ask");
    acts.onChange("ask");
    expect(patch).not.toHaveBeenCalled();
    acts.onChange("auto");
    expect(patch).toHaveBeenLastCalledWith({ approvalMode: "auto" });
    acts.onChange("full");
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "updateBot", botId: "scout", patch: { approvalMode: "full", applyToAllThreads: true } });
    click(find(rendered, "data-panel-link", "approvals"));
    expect(onOpen).toHaveBeenLastCalledWith("approvals");

    fixture.derived.approvalMode = "full";
    expect(details(makeBot()).html).toContain("Acts without checking");
    fixture.derived.approvalMode = "edits";
    const custom = details(makeBot());
    expect(segment(custom, "data-approval-choice").value).toBe("edits");
    expect(custom.html).not.toMatch(/data-approval-choice="\w+" aria-pressed="true"/);
    expect(custom.html).toContain("A custom setting is in use.");
  });

  it("shows legacy Antigravity Auto as Ask without changing the saved mode", () => {
    fixture.derived.engine = { driverKind: "antigravityAgent" };
    fixture.derived.approvalMode = "auto";
    const rendered = details(makeBot({ approvalMode: "auto" }));
    expect(segment(rendered, "data-approval-choice").value).toBe("ask");
    expect(rendered.html).toMatch(/data-approval-choice="auto" aria-pressed="false" disabled=""/);
    expect(patch).not.toHaveBeenCalled();
  });

  it("warns before Decide for me on this computer", () => {
    const bot = makeBot({ computer: "local" });
    segment(details(bot), "data-approval-choice").onChange("auto");
    expect(patch).not.toHaveBeenCalled();
    const warning = ofType(details(bot), LocalComputerAutoWarning)!;
    expect(warning.props.open).toBe(true);
    (warning.props.onConfirm as () => void)();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "updateBot", botId: "scout", patch: { approvalMode: "auto", acknowledgeLocalAuto: true } });
  });

  it("lists routines with a switch each, and creates, logs and opens schedules", () => {
    const morning = routine();
    const paused = routine({ id: "r2", name: "Weekly digest", enabled: false, nextRunAt: null });
    const done = routine({ id: "r3", name: "One-off", enabled: false, nextRunAt: null, schedule: { type: "once", at: 1 } });
    fixture.derived.botRoutines = [paused, done, morning];
    const bot = makeBot();
    const rendered = details(bot);
    expect(rendered.nodes.filter((node) => node.props["data-simple-routine"] !== undefined).map((node) => node.props["data-simple-routine"]))
      .toEqual(["r1", "r3", "r2"]);
    expect(rendered.html).toContain("Every weekday at");
    expect(find(rendered, "aria-label", "Run Morning brief on its schedule").props.checked).toBe(true);
    expect(has(rendered, "aria-label", "Run One-off on its schedule")).toBe(false);
    click(find(rendered, "aria-label", "Run Morning brief on its schedule"));
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "updateRoutine", routineId: "r1", patch: { enabled: false } });

    click(find(rendered, "data-panel-action", "routine-logs"));
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "showRoutines", section: "logs", botId: "scout" });
    click(find(rendered, "data-panel-link", "schedules"));
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "showRoutines", section: "schedule", view: "list", botId: "scout" });
    click(find(rendered, "data-panel-action", "routines"));
    expect(onOpen).toHaveBeenLastCalledWith("routines");

    click(find(rendered, "data-panel-action", "new-routine"));
    const editor = ofType(details(bot), RoutineEditor)!;
    expect(editor.props).toMatchObject({ lockedBotId: "scout", routine: undefined });
  });

  it("says how to add a routine when there is none", () => {
    expect(details(makeBot()).html).toContain("Nothing scheduled yet. Ask Scout in chat, or create a schedule.");
  });

  it("shows the line and its button under the model only while a thread runs on its own model", () => {
    const opus = { instanceId: "claude", model: "claude-opus-5-5" };
    const tasks = [
      { threadId: "thread-scout", title: "Follows", createdAt: 1, modelSelection: opus, followsBotModel: true },
      { threadId: "own", title: "Own", createdAt: 1, modelSelection: { instanceId: "codex", model: "gpt-5.6" }, followsBotModel: false },
    ];
    const { html } = details(makeBot({ tasks }));
    expect(html).toContain("1 thread uses its own model.");
    expect(html).toContain("Switch it too");
    expect(ofType(details(makeBot({ tasks })), ThreadModelsLine)).toBeDefined();
  });
});

describe("the Apps card", () => {
  const card = (bot: Bot, onOpenAccess = vi.fn()) =>
    capture(() => AppsCard({ bot, derived: derived(), apps: fixture.apps, onOpenAccess }));

  it("gives each connected app a switch for this bot, and writes the same record as Access", () => {
    fixture.apps = { phase: "ready", connectedSlugs: ["github", "gmail", "slack"], apps: [app("github", "write"), app("gmail", "write"), app("slack", "write")] };
    const rendered = card(makeBot());
    expect(rendered.html).toContain("github things");
    click(find(rendered, "aria-label", "Scout can use Github"));
    expect(patch).toHaveBeenLastCalledWith({ connectorScopes: { apps: { gmail: "write", slack: "write" } } });

    fixture.apps = { phase: "ready", connectedSlugs: ["github", "gmail", "slack"], apps: [app("github", null), app("gmail", "read"), app("slack", "write")] };
    const scoped = card(makeBot({ connectorScopes: { apps: { gmail: "read", slack: "write" } } }));
    expect(find(scoped, "aria-label", "Scout can use Github").props.checked).toBe(false);
    expect(scoped.html).toContain("Read only");
    click(find(scoped, "aria-label", "Scout can use Github"));
    expect(patch).toHaveBeenLastCalledWith({ connectorScopes: { apps: { gmail: "read", slack: "write", github: "write" } } });
  });

  it("turns all apps off or on with the bot's own switch, and holds the app switches while it is off", () => {
    fixture.apps = { phase: "ready", connectedSlugs: ["gmail"], apps: [app("gmail", "write")] };
    const rendered = card(makeBot());
    const master = rendered.nodes.find((node) => node.props["data-panel-row"] === "apps")!;
    expect(master.props.title).toBe("Let Scout use apps");
    (master.props.onChange as () => void)();
    expect(patch).toHaveBeenLastCalledWith({ composio: false });

    fixture.derived.connectedAppsEnabled = false;
    fixture.apps = { phase: "ready", connectedSlugs: ["gmail"], apps: [app("gmail", null)] };
    expect(find(card(makeBot({ composio: false })), "aria-label", "Scout can use Gmail").props.disabled).toBe(true);
    fixture.derived.canUseConnectedApps = false;
    const cannot = card(makeBot({ composio: false }));
    expect(cannot.nodes.find((node) => node.props["data-panel-row"] === "apps")!.props.disabled).toBe(true);
    expect(cannot.html).toContain("The model Scout runs on can&#x27;t use apps.");
  });

  it("says what it knows about the list: checking, unreadable, or empty", () => {
    fixture.apps = { phase: "loading", apps: [], connectedSlugs: [] };
    expect(card(makeBot()).html).toContain("Checking…");
    fixture.apps = { phase: "unknown", apps: [], connectedSlugs: [] };
    expect(card(makeBot()).html).toContain("Couldn&#x27;t check your apps just now.");
    fixture.apps = { phase: "ready", apps: [], connectedSlugs: [] };
    expect(card(makeBot()).html).toContain("No apps connected yet.");
  });

  it("opens App access and tools, and the app catalog from Add app", () => {
    const onOpenAccess = vi.fn();
    const rendered = card(makeBot(), onOpenAccess);
    click(find(rendered, "data-panel-link", "apps"));
    expect(onOpenAccess).toHaveBeenCalled();
    click(find(rendered, "data-panel-link", "add-app"));
    expect((fixture.dispatch as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      [{ type: "toggleSettings", open: false }],
      [{ type: "togglePlugins", open: true, surface: "apps" }],
    ]);
  });
});

describe("the browser logins", () => {
  const logins = (bot: Bot, onOpenBrowser = vi.fn(), browserEnabled = true) =>
    capture(() => BrowserLogins({ bot, browserEnabled, onOpenBrowser }));

  it("lists the sites the bot's own browser is signed in to, and explains the browsers it cannot list", async () => {
    const { SignedInSites } = await import("./SignedInSites");
    expect(logins(makeBot()).nodes.some((node) => node.type === SignedInSites)).toBe(false);
    fixture.ownerOrAdmin = true;
    const own = logins(makeBot());
    expect(ofType(own, SignedInSites)!.props).toMatchObject({ bare: true, target: { bot: "scout" }, sharedBy: ["Scout"], disabled: false });
    expect(own.html).toContain("Sign in once in Scout&#x27;s browser and it stays signed in.");

    fixture.storeState = {
      ...fixture.storeState,
      config: { browserProfiles: [{ id: "team", name: "Team" }] },
      bots: [makeBot({ browserProfile: "team" }), makeBot({ id: "nova", name: "Nova", browserProfile: "team" })],
    };
    expect(ofType(logins(makeBot({ browserProfile: "team" })), SignedInSites)!.props.sharedBy).toEqual(["Scout", "Nova"]);
    const temporary = logins(makeBot({ browserProfile: "guest" }));
    expect(ofType(temporary, SignedInSites)).toBeUndefined();
    expect(temporary.html).toContain("Temporary sessions keep logins only while this server is running");
    const off = logins(makeBot(), vi.fn(), false);
    expect(ofType(off, SignedInSites)).toBeUndefined();
    expect(off.html).toContain("Scout&#x27;s browser is off.");
  });

  it("opens the bot's browser from Add login", () => {
    const onOpenBrowser = vi.fn();
    click(find(logins(makeBot(), onOpenBrowser), "data-panel-action", "add-login"));
    expect(onOpenBrowser).toHaveBeenCalled();
  });
});

describe("the Computer tab", () => {
  const places = (rendered: { nodes: Node[] }) => rendered.nodes.filter((node) => node.props["data-place-choice"] !== undefined);
  const placeOf = (rendered: { nodes: Node[] }, value: string) => find(rendered, "data-place-choice", value);

  it("offers Auto, this computer and a Cloud computer, with the rarer places under More places", () => {
    const rendered = computer(makeBot());
    expect(rendered.html).toContain("Where Scout works");
    expect(rendered.html).toContain("More places");
    expect(rendered.html).toMatch(/data-place-choice="auto" aria-pressed="true"[^>]*>Auto</);
    expect(rendered.html).toMatch(/data-place-choice="cloud" aria-pressed="false"[^>]*>Cloud computer</);
    expect(places(rendered).map((node) => [node.props["data-place-choice"], node.props.children])).toEqual([
      ["vm", "Local VM"], ["browser", "Browser only"], ["off", "Off"],
    ]);
    expect(rendered.html).toContain("Picks the right place for each task");
  });

  it("saves each place through the bot patch, and sends nothing for the place already chosen", () => {
    const rendered = computer(makeBot());
    segment(rendered, "data-place-choice").onChange("cloud");
    expect(patch).toHaveBeenLastCalledWith({ computer: "cloud" });
    click(placeOf(rendered, "vm"));
    expect(patch).toHaveBeenLastCalledWith({ computer: "vm" });
    click(placeOf(rendered, "browser"));
    expect(patch).toHaveBeenLastCalledWith({ computer: "browser", browser: true });
    click(placeOf(rendered, "off"));
    expect(patch).toHaveBeenLastCalledWith({ computer: "off" });
    segment(computer(makeBot({ computer: "cloud" })), "data-place-choice").onChange("auto");
    expect(patch).toHaveBeenLastCalledWith({ computer: null });
    patch.mockReset();
    click(placeOf(computer(makeBot({ computer: "off" })), "off"));
    expect(patch).not.toHaveBeenCalled();
  });

  it("holds a place the bot cannot use with the reason on it, and leaves out one never offered", () => {
    fixture.places.vm = [true, false, "Not ready"];
    const blocked = computer(makeBot());
    expect(placeOf(blocked, "vm").props).toMatchObject({ disabled: true, title: "Not ready." });
    fixture.places.vm = [false, false, "Not offered"];
    fixture.places.local = [false, false, "Not offered"];
    const rendered = computer(makeBot());
    expect(places(rendered).map((node) => node.props["data-place-choice"])).toEqual(["browser", "off"]);
    expect(rendered.html).not.toContain('data-place-choice="local"');
  });

  it("warns before this computer for a bot that decides alone", () => {
    fixture.derived.approvalMode = "auto";
    const bot = makeBot();
    segment(computer(bot), "data-place-choice").onChange("local");
    expect(patch).not.toHaveBeenCalled();
    const warning = ofType(computer(bot), LocalComputerAutoWarning)!;
    expect(warning.props.open).toBe(true);
    (warning.props.onConfirm as () => void)();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "updateBot", botId: "scout", patch: { computer: "local", acknowledgeLocalAuto: true } });
  });

  it("leads to the browser and folder pages, and opens the full view on a tab", () => {
    const rendered = computer(makeBot());
    click(find(rendered, "data-panel-page", "browser"));
    expect(onOpen).toHaveBeenLastCalledWith("browser");
    click(find(rendered, "data-panel-page", "logins"));
    expect(onOpen).toHaveBeenLastCalledWith("browser");
    click(find(rendered, "data-panel-page", "folder"));
    expect(onOpen).toHaveBeenLastCalledWith("folder");
    expect(has(rendered, "data-panel-page", "android")).toBe(false);

    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { getItem: () => null, setItem });
    click(find(rendered, "data-panel-row", "data"));
    expect(setItem).toHaveBeenLastCalledWith("omb-computer-panel-view:scout", "data");
    expect((fixture.dispatch as ReturnType<typeof vi.fn>).mock.calls.slice(-2)).toEqual([
      [{ type: "toggleSettings", open: false }],
      [{ type: "toggleComputer", open: true }],
    ]);
    click(find(rendered, "data-panel-action", "open-computer"));
    expect(setItem).toHaveBeenLastCalledWith("omb-computer-panel-view:scout", "computer");
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  });
});

describe("the Library tab", () => {
  it("filters between memories, files, pages and skills", () => {
    const bot = makeBot();
    const all = library(bot);
    for (const label of ["Memories", "Files", "Pages and apps", "Skills"]) expect(all.html).toContain(`>${label}`);
    click(find(all, "data-library-filter", "skills"));
    const skills = library(bot);
    expect(find(skills, "data-library-filter", "skills").props["aria-pressed"]).toBe(true);
    expect(skills.html).not.toContain('data-panel-card="memories"');
    expect(skills.html).toContain("No skills yet.");
  });

  it("shows what the bot made, splitting pages from files, and jumps to the message", () => {
    const message = {
      id: "m1", role: "bot", kind: "text", at: Date.UTC(2026, 8, 30), text: "Done",
      attachments: [{ path: "/tmp/chart.png", kind: "image" }, { path: "/tmp/report.pdf", kind: "file", name: "report.pdf" }, { path: "/tmp/site.html", kind: "file", name: "site.html" }],
    } as Message;
    const made = makeBot({ messages: [message] });
    expect(botLibraryItems(made).map((item) => item.name)).toEqual(["chart.png", "report.pdf", "site.html"]);
    const rendered = library(made);
    expect(rendered.html).toContain("Files · 2");
    expect(rendered.html).toContain("site.html");
    click(find(rendered, "data-library-item", "m1"));
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "focusMessage", threadId: "thread-scout", messageId: "m1" });
    expect(library(makeBot()).html).toContain("Pages and apps Scout makes in chat show up here.");
  });

  it("keeps the latest artifact reply and date while preserving each reply's file order", () => {
    const made = makeBot({ messages: [
      { id: "old", role: "bot", kind: "text", at: 100, text: "First draft", attachments: [
        { path: "/tmp/report.pdf", kind: "file", name: "draft.pdf" },
        { path: "/tmp/old-only.pdf", kind: "file", name: "old-only.pdf" },
      ] },
      { id: "latest", role: "bot", kind: "text", at: 200, text: "Updated", attachments: [
        { path: "/tmp/chart.png", kind: "image" },
        { path: "/tmp/report.pdf", kind: "file", name: "report.pdf" },
        { path: "/tmp/notes.md", kind: "file", name: "notes.md" },
      ] },
    ] as Message[] });
    expect(botLibraryItems(made).map(({ name, messageId, at }) => ({ name, messageId, at }))).toEqual([
      { name: "chart.png", messageId: "latest", at: 200 },
      { name: "report.pdf", messageId: "latest", at: 200 },
      { name: "notes.md", messageId: "latest", at: 200 },
      { name: "old-only.pdf", messageId: "old", at: 100 },
    ]);
  });

  it("reads memories as the bullet lines of MEMORY.md", () => {
    expect(memoryEntries("# Notes\n- Omkar uses Resolve Studio\n* Likes short replies\nplain line\n  - nested one")).toEqual([
      "Omkar uses Resolve Studio", "Likes short replies", "nested one",
    ]);
    expect(library(makeBot({ memoryEnabled: false })).html).toContain("Memory is off for Scout.");
  });

  it("switches skills with the Skills section's toggle, holds them while one settles, and manages them", () => {
    const off = skill("summarise", false);
    fixture.skills.skills = [skill("triage", true), off];
    const rendered = library(makeBot());
    expect(rendered.html).toContain("Skills · 2");
    const row = rendered.nodes.find((node) => node.props["data-panel-row"] === "skill:summarise")!;
    expect(row.props).toMatchObject({ checked: false, label: "Use summarise", hint: "summarise helper", disabled: false });
    (row.props.onChange as () => void)();
    expect(fixture.skills.toggle).toHaveBeenCalledWith(off);
    fixture.skills.working = "triage";
    expect(library(makeBot()).nodes.find((node) => node.props["data-panel-row"] === "skill:summarise")!.props.disabled).toBe(true);
    click(find(rendered, "data-panel-action", "skills"));
    expect(onOpen).toHaveBeenLastCalledWith("skills");
    click(find(rendered, "data-panel-link", "skills"));
    expect(onOpen).toHaveBeenLastCalledWith("skills");
    click(find(rendered, "data-panel-action", "memory"));
    expect(onOpen).toHaveBeenLastCalledWith("memory");
  });
});

describe("the Settings tab", () => {
  const row = (rendered: { nodes: Node[] }, id: string) => find(rendered, "data-panel-row", id);

  it("groups Profile, Teamwork, Tools, Sharing, Activity, the bot's own card and Advanced mode", () => {
    const { html } = settings(makeBot());
    const at = (text: string) => html.indexOf(text);
    const order = ["Profile", "Teamwork", "Tools", "Sharing", "Activity", ">Scout<", "Advanced mode"].map(at);
    expect(order.every((index) => index > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const text of ["What Scout does", "Voice", "Notifications", "Team", "Chief of Staff", "Ask me before contacting other bots",
      "MCP servers", "Tool selection", "Webhooks", "Always allowed", "Get it on your phone", "Phone and email", "Overview",
      "What Scout sees", "History", "Usage for all bots", "Pin to top", "Duplicate", "Copy conversation ID",
      "Mark all conversations as read", "Archive Scout", "Delete Scout"]) expect(html).toContain(text);
    expect(html).not.toContain("Who can see it");
    expect(html).not.toContain(">Slack<");
    expect(html.match(/>Soon</g)).toHaveLength(1);
  });

  it("opens each page from its row", () => {
    const rendered = settings(makeBot());
    for (const page of ["blurb", "voice", "team", "mcp", "tools", "webhooks", "always", "overview", "prompt", "history"]) {
      click(find(rendered, "data-panel-page", page));
      expect(onOpen).toHaveBeenLastCalledWith(page);
    }
    expect(has(rendered, "data-panel-page", "chiefteams")).toBe(false);
    expect(has(settings(makeBot({ chiefOfStaff: true })), "data-panel-page", "chiefteams")).toBe(true);
  });

  it("shows Slack and Who can see it only where they apply", () => {
    expect(has(settings(makeBot(), "", "https://admin.example/slack"), "data-panel-page", "slack")).toBe(true);
    fixture.ownerOrAdmin = true;
    const visibility = settings(makeBot());
    expect(find(visibility, "data-panel-page", "visibility").props.value).toBe("Everyone");
  });

  it("switches notifications, Chief of Staff, peer checks and Advanced mode", () => {
    const rendered = settings(makeBot());
    (row(rendered, "notify").props.onChange as () => void)();
    expect(patch).toHaveBeenLastCalledWith({ notifications: false });
    (row(rendered, "chief").props.onChange as () => void)();
    expect(patch).toHaveBeenLastCalledWith({ chiefOfStaff: true });
    (row(rendered, "peers").props.onChange as () => void)();
    expect(patch).toHaveBeenLastCalledWith({ approvePeerComms: true });
    (row(rendered, "advanced").props.onChange as () => void)();
    expect(fixture.setAdvanced).toHaveBeenCalledWith(true);

    fixture.derived.canCoordinate = false;
    const cannot = settings(makeBot());
    expect(row(cannot, "chief").props.disabled).toBe(true);
    expect(row(cannot, "peers").props.disabled).toBe(true);
  });

  it("runs the sidebar's bot actions with the same confirmations", () => {
    const rendered = settings(makeBot());
    (row(rendered, "pin").props.onChange as () => void)();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "updateBot", botId: "scout", patch: { pinned: true } });
    click(row(rendered, "duplicate"));
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "duplicateBot", botId: "scout" });
    expect(row(rendered, "read").props.disabled).toBe(true);
    expect(row(rendered, "archive").props.disabled).toBe(true);
    expect(row(rendered, "archive").props.hint).toBe("Keep at least one active bot");

    click(row(rendered, "delete"));
    const confirm = ofType(settings(makeBot()), ConfirmDialog)!;
    expect(confirm.props).toMatchObject({ open: true, title: "Delete Scout?", confirmLabel: "Delete", tone: "danger" });
    (confirm.props.onConfirm as () => void)();
    expect((fixture.dispatch as ReturnType<typeof vi.fn>).mock.calls.slice(-2)).toEqual([
      [{ type: "toggleSettings", open: false }],
      [{ type: "deleteBot", botId: "scout" }],
    ]);

    fixture.storeState = { ...fixture.storeState, bots: [makeBot(), makeBot({ id: "nova", name: "Nova" })] };
    const two = settings(makeBot({ unread: true }));
    expect(row(two, "read").props.disabled).toBe(false);
    click(row(two, "archive"));
    expect(ofType(settings(makeBot()), ConfirmDialog)!.props).toMatchObject({ open: true, title: "Archive Scout?", tone: "neutral" });
  });

  it("opens the phone apps from Get it on your phone", () => {
    const rendered = settings(makeBot());
    expect(ofType(rendered, PhoneAppDialog)!.props.open).toBe(false);
    click(row(rendered, "phoneapp"));
    expect(ofType(settings(makeBot()), PhoneAppDialog)!.props.open).toBe(true);
  });

  it("searches pages, rows and other tabs, and says where each lives", () => {
    const voice = settings(makeBot(), "elevenlabs");
    expect(voice.html).toContain("1 result");
    const hit = find(voice, "data-panel-page", "voice");
    expect(hit.props).toMatchObject({ title: "Voice", hint: "Settings › Profile" });
    click(hit);
    expect(onOpen).toHaveBeenLastCalledWith("voice");

    const model = settings(makeBot(), "fallback");
    expect(find(model, "data-panel-page", "model").props.hint).toBe("Details › Model");

    const pin = settings(makeBot(), "pin");
    expect(has(pin, "data-panel-row", "pin")).toBe(true);
    expect(has(pin, "data-panel-row", "notify")).toBe(false);

    const thinking = settings(makeBot(), "thinking");
    const jump = find(thinking, "data-panel-jump", "thinking");
    expect(jump.props.hint).toBe("Details › Model");
    click(jump);
    expect(onGo).toHaveBeenLastCalledWith({ tab: "details", anchor: "model" });

    expect(settings(makeBot(), "zzz").html).toContain("Nothing matches “zzz”.");
    expect(has(settings(makeBot(), "slack"), "data-panel-page", "slack")).toBe(false);
  });
});

describe("the drill-in pages", () => {
  const overview = { overview: null, overviewError: false, prompt: null, promptError: false };
  const history = {
    rows: null, error: false, revision: null, rollingBack: false, rollbackTarget: null,
    setRollbackTarget: vi.fn(), rollback: vi.fn(), requestRollback: vi.fn(),
  };
  const body = (page: Parameters<typeof PageBody>[0]["page"], bot = makeBot(), extra: Partial<Parameters<typeof PageBody>[0]> = {}) =>
    capture(() => PageBody({ page, bot, derived: derived(), slackUrl: null, overview, history, onOpen, onGo, ...extra }) as ReactNode);

  it("renders the full sections, or the part a page needs", () => {
    expect(ofType(body("model"), ModelSection)!.props.bot).toMatchObject({ id: "scout" });
    expect(ofType(body("approvals"), PermissionsSection)!.props.parts).toEqual(["approval", "outbound"]);
    for (const [page, parts] of [["apps", ["apps", "xResearch"]], ["mcp", ["mcp"]], ["tools", ["tools"]], ["webhooks", ["webhooks"]], ["always", ["always"]]] as const) {
      expect(ofType(body(page), AccessSection)!.props.parts).toEqual(parts);
    }
    expect(ofType(body("routines"), RoutinesSection)!.props.routines).toBe(fixture.derived.botRoutines);
  });

  it("follows the Overview's links to the matching page", () => {
    const section = ofType(body("overview"), OverviewSection)!;
    (section.props.onOpen as (section: string) => void)("soul");
    expect(onOpen).toHaveBeenLastCalledWith("instructions");
    (section.props.onOpen as (section: string) => void)("access");
    expect(onGo).toHaveBeenLastCalledWith({ tab: "computer" });
  });

  it("lists the setup ideas that remain and starts setup with the bot", () => {
    const context = { bot: makeBot(), derived: derived(), slackUrl: null, history, onOpen, onGo, overview: { ...overview, overview: overviewWith([
      { id: "folder", label: "Choose a working folder", done: false, section: "access" },
      { id: "identity", label: "Name it", done: true },
    ]) } };
    const rendered = capture(() => SetupPage(context));
    expect(rendered.html).toContain("Choose a working folder");
    expect(rendered.html).not.toContain("Name it");
    click(find(rendered, "data-panel-setup", "folder"));
    expect(onOpen).toHaveBeenLastCalledWith("folder");
    click(find(rendered, "data-panel-action", "setup"));
    expect((fixture.dispatch as ReturnType<typeof vi.fn>).mock.calls.slice(-2)).toEqual([
      [{ type: "toggleSettings", open: false }],
      [{ type: "send", botId: "scout", text: "/setup", threadId: "thread-scout" }],
    ]);
  });

  it("moves the bot to a team, a new team, or back to General", () => {
    fixture.storeState = { ...fixture.storeState, sections: ["Research"], bots: [makeBot()], groups: [] };
    const team = capture(() => PageBody({ page: "team", bot: makeBot(), derived: derived(), slackUrl: null, overview, history, onOpen, onGo }) as ReactNode);
    expect(team.html).toContain("General");
    expect(team.html).toContain("Research");
    expect(team.html).toContain('aria-pressed="true"');
  });
});

describe("the bot settings dialog", () => {
  it("opens on the Simple panel without the accordion, and hands it the deep-linked section", () => {
    const bot = makeBot();
    const simple = dialog(bot);
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
    expect(rendered.html).toContain("Search settings");
    for (const label of ["Overview", "Identity", "Soul", "Skills", "Memory", "Routines", "Access", "Model", "Permissions", "Voice &amp; alerts", "History", "Usage"]) {
      expect(rendered.html).toContain(`>${label}</span>`);
    }
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
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "followBotModel", botId: "scout" });
  });
});

describe("the panel's switches", () => {
  it("are the shared switch, in the bot's own color when on", () => {
    fixture.apps = { phase: "ready", connectedSlugs: ["gmail"], apps: [app("gmail", "write")] };
    const html = capture(() => AppsCard({ bot: makeBot({ color: "blue" }), derived: derived(), apps: fixture.apps, onOpenAccess: vi.fn() })).html;
    expect(html.match(/role="switch"/g)).toHaveLength(2);
    expect(html).toContain("background-color:#377FE6");
    expect(Switch).toBeDefined();
  });
});
