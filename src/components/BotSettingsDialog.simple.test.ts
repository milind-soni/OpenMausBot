import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bot, Message } from "@/state/store";
import type { ManagedSkill } from "./bot-settings/SkillsSection";

// Same hook-by-call-order harness as ModelPicker.simple.test.ts: component
// state survives between renders, effects never run, and handlers are read
// off the returned element tree.
const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return {
    advanced: false,
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
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, setAdvancedMode: () => {} }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => false }));
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
const { SimpleBotPanel, botLibraryItems } = await import("./bot-settings/SimpleBotPanel");
const { SoulField } = await import("./SoulField");
const { LocalComputerAutoWarning } = await import("./LocalComputerAutoWarning");
const { ModelPicker } = await import("./ModelPicker");
const { ThreadModelsLine } = await import("./ThreadModelsLine");
const { ModelSection } = await import("./bot-settings/ModelSection");

afterAll(() => vi.unstubAllGlobals());

type Node = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
function nodes(value: ReactNode): Node[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as Node;
    return [node, ...nodes(node.props.children)];
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

function capture(component: () => ReactNode) {
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

const patch = vi.fn();
const panelProps = { onClose: vi.fn(), onAllSettings: vi.fn(), onAddSkill: vi.fn() };
const panel = (bot: Bot) => capture(() => SimpleBotPanel({ bot, derived: fixture.derived as never, ...panelProps }));
const dialog = (bot: Bot) => capture(() => BotSettingsDialog({ bot }));
const find = (rendered: { nodes: Node[] }, attr: string, value: unknown = true) =>
  rendered.nodes.find((node) => node.props[attr] === value)!;
const click = (node: Node) => (node.props.onClick as () => void)();
const isSimple = (rendered: { nodes: Node[] }) => rendered.nodes.some((node) => node.type === SimpleBotPanel);

const skill = (name: string, enabled: boolean): ManagedSkill => ({ name, description: `${name} helper`, enabled, source: "github:x/y", warnings: [] });

beforeEach(() => {
  fixture.advanced = false;
  fixture.values = [];
  fixture.index = 0;
  fixture.own = 0;
  fixture.dispatch = vi.fn();
  fixture.storeState = { settingsOpen: true, botSettingsSection: "overview", botSettingsExpandAccordion: false };
  fixture.skills = { skills: [], loading: false, working: "", error: "", reviewing: null, toggle: vi.fn(() => Promise.resolve()) };
  patch.mockReset();
  fixture.derived = {
    patch, approvalMode: "ask", engine: { driverKind: "claudeAgent" }, trustedModesAvailable: false, activeState: "idle",
    botRoutines: [],
  };
});

describe("the bot settings panel in Simple mode", () => {
  it("shows the avatar header, Details and Library tabs, and the plain fields", () => {
    const { html } = panel(makeBot());
    expect(html).toContain(">Details</button>");
    expect(html).toContain(">Library</button>");
    expect(html).toContain(">Name</label>");
    expect(html).toContain(">Job</label>");
    expect(html).toContain("value=\"Scout\"");
    expect(html).toContain("value=\"Researcher\"");
    expect(html).toContain(">Instructions</label>");
    expect(html).toContain("Be brief.");
    expect(html).toContain("Before Scout acts");
    expect(html).toContain("Ask me first");
    expect(html).toContain("Decide for me");
    expect(html).toContain("All settings");
    expect(html).not.toContain("SOUL.md");
  });

  it("sets the bot's default model between Instructions and Before acts, in the inline picker", () => {
    const bot = makeBot();
    const rendered = panel(bot);
    const picker = rendered.nodes.find((node) => node.type === ModelPicker)!;
    expect(picker).toBeDefined();
    // Contained (in place, never clipped by the scrolling panel) and on the
    // bot itself, with no thread: a pick is the bot's default.
    expect(picker.props.contained).toBe(true);
    expect(picker.props.bot).toBe(bot);
    expect(picker.props.threadId).toBeUndefined();
    const { html } = rendered;
    const at = (text: string) => html.indexOf(text);
    expect(at(">Instructions</label>")).toBeLessThan(at("Default model"));
    expect(at("Default model")).toBeLessThan(at("Before Scout acts"));
  });

  it("saves name, job and instructions through the same bot patch", () => {
    const rendered = panel(makeBot());
    (find(rendered, "id", "simple-bot-name-scout").props.onChange as (e: unknown) => void)({ target: { value: "Nova" } });
    expect(patch).toHaveBeenLastCalledWith({ name: "Nova" });
    (find(rendered, "id", "simple-bot-job-scout").props.onChange as (e: unknown) => void)({ target: { value: "Writer" } });
    expect(patch).toHaveBeenLastCalledWith({ title: "Writer" });
    const soul = rendered.nodes.find((node) => node.type === SoulField)!;
    expect(soul.props.onPatch).toBe(patch);
  });

  it("maps the two cards onto Ask and Approve for me", () => {
    const rendered = panel(makeBot());
    expect(find(rendered, "data-approval-choice", "ask").props["aria-pressed"]).toBe(true);
    expect(find(rendered, "data-approval-choice", "auto").props["aria-pressed"]).toBe(false);
    click(find(rendered, "data-approval-choice", "auto"));
    expect(patch).toHaveBeenLastCalledWith({ approvalMode: "auto" });

    fixture.derived.approvalMode = "auto";
    const onAuto = panel(makeBot());
    click(find(onAuto, "data-approval-choice", "ask"));
    expect(patch).toHaveBeenLastCalledWith({ approvalMode: "ask" });
  });

  it("shows legacy Antigravity Auto as Ask without changing the saved mode", () => {
    fixture.derived.engine = { ...fixture.derived.engine!, driverKind: "antigravityAgent" };
    fixture.derived.approvalMode = "auto";
    const rendered = panel(makeBot({ approvalMode: "auto" }));
    expect(find(rendered, "data-approval-choice", "ask").props["aria-pressed"]).toBe(true);
    expect(find(rendered, "data-approval-choice", "auto").props["aria-pressed"]).toBe(false);
    expect(find(rendered, "data-approval-choice", "auto").props.disabled).toBe(true);
    expect(patch).not.toHaveBeenCalled();
  });

  it("warns before Decide for me on this computer, as Permissions does", () => {
    const bot = makeBot({ computer: "local" });
    click(find(panel(bot), "data-approval-choice", "auto"));
    expect(patch).not.toHaveBeenCalled();
    const warning = panel(bot).nodes.find((node) => node.type === LocalComputerAutoWarning)!;
    expect(warning.props.open).toBe(true);
    (warning.props.onConfirm as () => void)();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({
      type: "updateBot", botId: "scout", patch: { approvalMode: "auto", acknowledgeLocalAuto: true },
    });
  });

  it("selects neither card and says so when another level is in use", () => {
    fixture.derived.approvalMode = "full";
    const rendered = panel(makeBot());
    expect(find(rendered, "data-approval-choice", "ask").props["aria-pressed"]).toBe(false);
    expect(find(rendered, "data-approval-choice", "auto").props["aria-pressed"]).toBe(false);
    expect(rendered.html).toContain("A custom setting is in use.");
    expect(patch).not.toHaveBeenCalled();
  });

  it("lists skills with the Skills section's on/off switch", () => {
    const off = skill("summarise", false);
    fixture.skills.skills = [skill("triage", true), off];
    const rendered = panel(makeBot());
    expect(rendered.html).toContain("triage");
    expect(rendered.html).toContain("summarise helper");
    click(find(rendered, "aria-label", "Use summarise"));
    expect(fixture.skills.toggle).toHaveBeenCalledWith(off);
    click(find(rendered, "data-simple-add-skill"));
    expect(panelProps.onAddSkill).toHaveBeenCalled();
  });

  it("disables every skill switch until a pending toggle settles", async () => {
    const first = skill("triage", true);
    const second = skill("summarise", false);
    fixture.skills.skills = [first, second];
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    fixture.skills.toggle = vi.fn(async (selected) => {
      fixture.skills.working = selected.name;
      await pending;
      fixture.skills.working = "";
    });

    click(find(panel(makeBot()), "aria-label", "Use triage"));
    const busy = panel(makeBot());
    expect(find(busy, "aria-label", "Use triage").props.disabled).toBe(true);
    expect(find(busy, "aria-label", "Use summarise").props.disabled).toBe(true);

    finish();
    await pending;
    const settled = panel(makeBot());
    expect(find(settled, "aria-label", "Use triage").props.disabled).toBe(false);
    expect(find(settled, "aria-label", "Use summarise").props.disabled).toBe(false);
  });

  it("has a quiet line when there are no skills", () => {
    expect(panel(makeBot()).html).toContain("No skills yet.");
  });

  it("shows the Library empty state, and what the bot made when there is some", () => {
    const empty = makeBot();
    click(find(panel(empty), "data-simple-tab", "library"));
    expect(panel(empty).html).toContain("Pages, files, and apps Scout makes show up here.");

    const message = {
      id: "m1", role: "bot", kind: "text", at: Date.UTC(2026, 8, 30), text: "Done",
      attachments: [{ path: "/tmp/chart.png", kind: "image" }, { path: "/tmp/report.pdf", kind: "file", name: "report.pdf" }],
    } as Message;
    const made = makeBot({ messages: [message] });
    expect(botLibraryItems(made).map((item) => item.name)).toEqual(["chart.png", "report.pdf"]);
    const rendered = panel(made);
    expect(rendered.html).toContain("report.pdf");
    click(find(rendered, "data-library-item", "m1"));
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "focusMessage", threadId: "thread-scout", messageId: "m1" });
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
});

describe("the bot settings dialog", () => {
  it("opens on the Simple panel and reaches every section through All settings", () => {
    const bot = makeBot();
    const simple = dialog(bot);
    expect(isSimple(simple)).toBe(true);
    expect(simple.html).not.toContain("Search settings");

    const panelNode = simple.nodes.find((node) => node.type === SimpleBotPanel)!;
    (panelNode.props.onAllSettings as () => void)();
    const full = dialog(bot);
    expect(isSimple(full)).toBe(false);
    expect(full.html).toContain("Search settings");
    for (const label of ["Overview", "Identity", "Soul", "Skills", "Memory", "Routines", "Access", "Model", "Permissions", "Voice &amp; alerts", "History", "Usage"]) {
      expect(full.html).toContain(`>${label}</span>`);
    }

    click(find(full, "data-bot-settings-back"));
    expect(isSimple(dialog(bot))).toBe(true);
  });

  it("opens the full Skills row from Add skill", () => {
    const bot = makeBot();
    const panelNode = dialog(bot).nodes.find((node) => node.type === SimpleBotPanel)!;
    (panelNode.props.onAddSkill as () => void)();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "toggleSettings", open: true, section: "skills" });
    expect(isSimple(dialog(bot))).toBe(false);
  });

  it("follows a deep link to a section the Simple panel does not cover", () => {
    fixture.storeState = { settingsOpen: true, botSettingsSection: "model", botSettingsExpandAccordion: true };
    expect(isSimple(dialog(makeBot()))).toBe(false);
  });

  it("keeps Edit profile on the Simple panel", () => {
    fixture.storeState = { settingsOpen: true, botSettingsSection: "identity", botSettingsExpandAccordion: true };
    expect(isSimple(dialog(makeBot()))).toBe(true);
  });

  it("leaves Advanced mode on today's panel", () => {
    fixture.advanced = true;
    const rendered = dialog(makeBot());
    expect(isSimple(rendered)).toBe(false);
    expect(rendered.html).toContain("Search settings");
    expect(rendered.nodes.some((node) => node.props["data-bot-settings-back"])).toBe(false);
  });
});

describe("Switch them too beside the bot's model", () => {
  const opus = { instanceId: "claude", model: "claude-opus-5-5" };
  const onOwn = (count: number): Partial<Bot> => ({ tasks: [
    { threadId: "thread-scout", title: "Follows", createdAt: 1, modelSelection: opus, followsBotModel: true },
    ...Array.from({ length: count }, (_, index) => ({
      threadId: `own-${index}`, title: `Own ${index}`, createdAt: 1, modelSelection: { instanceId: "codex", model: "gpt-5.6" }, followsBotModel: false,
    })),
  ] });

  it("shows the line and its button under the Simple panel's model only while a thread runs on its own model", () => {
    expect(panel(makeBot(onOwn(0))).html).not.toContain("use their own model");
    const { html } = panel(makeBot(onOwn(1)));
    expect(html).toContain("1 thread uses its own model.");
    expect(html).toContain("Switch it too");
    expect(html.indexOf("Default model")).toBeLessThan(html.indexOf("1 thread uses its own model."));
    expect(html.indexOf("1 thread uses its own model.")).toBeLessThan(html.indexOf("Before Scout acts"));
  });

  it("shows it in the full Model section too, and its button switches them", () => {
    fixture.storeState = { settingsOpen: true, botSettingsSection: "model", botSettingsExpandAccordion: true };
    expect(dialog(makeBot(onOwn(0))).html).not.toContain("data-thread-models");
    const rendered = dialog(makeBot(onOwn(3)));
    expect(rendered.html).toContain("3 threads use their own model.");
    expect(rendered.html).toContain("Switch them too");
    // A fresh hook record: the section is captured on its own.
    fixture.values = [];
    fixture.own = 0;
    const section = capture(() => ModelSection({ bot: makeBot(onOwn(3)) }));
    const line = section.nodes.find((node) => node.type === ThreadModelsLine)!;
    click(capture(() => ThreadModelsLine(line.props as never)).nodes.find((node) => node.props["data-switch-them-too"] !== undefined)!);
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "followBotModel", botId: "scout" });
  });
});
