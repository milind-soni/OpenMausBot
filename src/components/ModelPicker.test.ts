import { Children, createElement, type ChangeEvent, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppState, Bot, InstanceInfo } from "@/state/store";
import type { EffortLevel } from "../../shared/wire";

// The picker reads the engine catalog off the store, and the store module
// touches window/localStorage at import time — the same shape
// ComputerPanel.browser.test.ts uses to render a store-backed component
// under vitest's "node" environment.
const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return { instances: [] as InstanceInfo[], modelVariantSessions: {} as AppState["modelVariantSessions"], dispatch: vi.fn() };
});
vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  useStore: () => ({
    state: { instances: fixture.instances, modelVariantSessions: fixture.modelVariantSessions },
    dispatch: fixture.dispatch,
    refreshInstances: vi.fn(),
    refreshModels: vi.fn(),
  }),
}));

const { ClaudeAccountSelect, EffortRow, ModelEngineRail, ModelPicker, ModelVariantRow, modelSelectionForPick } = await import("./ModelPicker");

afterAll(() => vi.unstubAllGlobals());

function engine(effortLevels?: readonly EffortLevel[]): InstanceInfo {
  return {
    instanceId: "codex",
    driverKind: "codex",
    displayName: "Codex",
    snapshot: { state: "available", version: "1.0.0" },
    models: { default: "gpt-5.6", options: [{ id: "gpt-5.6", label: "GPT-5.6" }] },
    ...(effortLevels ? { capabilities: { effortLevels } } : {}),
  };
}

function bot(effort?: EffortLevel): Bot {
  return {
    id: "atlas",
    threadId: "thread-atlas",
    name: "Atlas",
    title: "",
    description: "",
    notifications: true,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "codex", model: "gpt-5.6", ...(effort ? { effort } : {}) },
    messages: [],
  };
}

/** Every effort button as rendered, with the state a screen reader announces. */
function levelButtons(markup: string): Array<{ label: string; pressed: boolean }> {
  return [...markup.matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*>([^<]+)</g)].map((match) => ({
    label: match[2],
    pressed: match[1] === "true",
  }));
}

function renderEffort(instances: InstanceInfo[], effort?: EffortLevel): string {
  fixture.instances = instances;
  return renderToStaticMarkup(createElement(EffortRow, { bot: bot(effort) }));
}

describe("EffortRow", () => {
  it("can apply effort to the pinned thread and bot default together", () => {
    fixture.instances = [engine(["high"])];
    const row = EffortRow({ bot: bot(), threadId: "thread-atlas", updateBotDefault: true })!;
    const levels = Children.toArray(row.props.children).at(-1) as ReactElement<{ children: ReactNode }>;
    const high = Children.toArray(levels.props.children)[1] as ReactElement<{ onClick: () => void }>;
    high.props.onClick();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "setModel", botId: "atlas", threadId: "thread-atlas", updateBotDefault: true, selection: { instanceId: "codex", model: "gpt-5.6", effort: "high" } });
  });
  it("pins thread effort changes without changing profile defaults", () => {
    fixture.instances = [engine(["high"])];
    const row = EffortRow({ bot: bot(), threadId: "independent-thread" })!;
    const levels = Children.toArray(row.props.children).at(-1) as ReactElement<{ children: ReactNode }>;
    const high = Children.toArray(levels.props.children)[1] as ReactElement<{ onClick: () => void }>;
    high.props.onClick();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "setModel", botId: "atlas", threadId: "independent-thread", selection: { instanceId: "codex", model: "gpt-5.6", effort: "high" } });
  });
  it("renders nothing for an engine that declares no effort levels", () => {
    expect(renderEffort([engine()])).toBe("");
    // an engine that declares an empty list is the same promise as none
    expect(renderEffort([engine([])])).toBe("");
    // and so is a bot whose engine is not in the catalog at all
    expect(renderEffort([])).toBe("");
  });

  it("offers only the levels the selected engine accepts, plus Default", () => {
    const markup = renderEffort([engine(["low", "medium", "high"])]);

    expect(levelButtons(markup).map((button) => button.label)).toEqual(["Default", "Low", "Medium", "High"]);
    // the server rejects a level its engine does not offer, so one that is
    // never shown is one that can never be persisted
    expect(markup).not.toContain(">X-High<");
    expect(markup).not.toContain(">Max<");
  });

  it("keeps Default and None apart — Default sends no level, None sends one", () => {
    const markup = renderEffort([engine(["none", "low"])]);

    expect(levelButtons(markup).map((button) => button.label)).toEqual(["Default", "None", "Low"]);
  });

  it("marks the active level, and Default when the bot carries no level", () => {
    const pressed = (markup: string) => levelButtons(markup).find((button) => button.pressed)?.label;

    expect(pressed(renderEffort([engine(["low", "high"])], "high"))).toBe("High");
    expect(pressed(renderEffort([engine(["low", "high"])]))).toBe("Default");
  });

  it("renames xhigh, the one level that does not capitalize cleanly", () => {
    expect(renderEffort([engine(["xhigh"])])).toContain(">X-High<");
  });
});


describe("OpenCode model variants", () => {
  const variants = [
    { id: "none", label: "None" }, { id: "minimal", label: "Minimal" },
    { id: "default", label: "Default" }, { id: "deep/custom", label: "Deep custom" },
  ];
  const opencode = (): InstanceInfo => ({ ...engine(), instanceId: "opencode", driverKind: "opencodeGo",
    capabilities: { modelVariants: true }, models: { default: "provider/model", options: [{ id: "provider/model", label: "Model", variants }] } });
  const selected = (variant?: string): Bot => ({ ...bot(), modelSelection: { instanceId: "opencode", model: "provider/model", ...(variant !== undefined ? { variant } : {}) } });
  beforeEach(() => { fixture.instances = [opencode()]; fixture.modelVariantSessions = {}; fixture.dispatch.mockClear(); });
  const render = (variant?: string) => renderToStaticMarkup(createElement(ModelVariantRow, { bot: selected(variant), threadId: "thread-atlas" }));

  it("offers exact advertised ids without assuming that omission means none or default", () => {
    const markup = render();
    expect(levelButtons(markup)).toEqual([
      { label: "None", pressed: false }, { label: "Minimal", pressed: false },
      { label: "OpenCode default", pressed: false }, { label: "Deep custom", pressed: false },
    ]);
    expect(markup).toContain("No variant selected.");
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(levelButtons(render("none")).find((button) => button.pressed)?.label).toBe("None");
  });

  it.each(variants)("persists $id only to the pinned conversation and clears legacy effort", (option) => {
    const configured = selected();
    configured.modelSelection.effort = "high";
    const row = ModelVariantRow({ bot: configured, threadId: "independent-thread" })!;
    const group = Children.toArray(row.props.children).at(-1) as ReactElement<{ children: ReactNode }>;
    const button = Children.toArray(group.props.children)[variants.findIndex((candidate) => candidate.id === option.id)] as ReactElement<{ onClick: () => void }>;
    button.props.onClick();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "setModel", botId: "atlas", threadId: "independent-thread",
      selection: { instanceId: "opencode", model: "provider/model", variant: option.id } });
  });

  it.each(["none", "default", "minimal", "removed"])("can clear %s to omission without asking for a default or none", (variant) => {
    const row = ModelVariantRow({ bot: selected(variant), threadId: "thread-atlas" })!;
    const clear = Children.toArray(row.props.children).find((child) =>
      typeof child === "object" && "type" in child && child.type === "button") as ReactElement<{ onClick: () => void; title: string }>;
    expect(clear.props.title).toContain("keeps its session or configured setting");
    clear.props.onClick();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "setModel", botId: "atlas", threadId: "thread-atlas",
      selection: { instanceId: "opencode", model: "provider/model" } });
  });

  it("uses matching session choices, including an empty list, without changing the instance catalog", () => {
    fixture.modelVariantSessions["thread-atlas"] = { instanceId: "opencode", model: "provider/model", turnId: "turn", startedAt: "2026-09-15T00:00:00Z", acceptingUpdates: false,
      variants: { options: [{ id: "minimal", label: "Session minimal" }], currentValue: "minimal" } };
    expect(levelButtons(render()).map((button) => button.label)).toEqual(["Session minimal"]);
    expect(render()).toContain("No variant selected. Session: Session minimal.");
    expect(levelButtons(render()).some((button) => button.pressed)).toBe(false);
    expect(fixture.instances[0].models.options[0].variants).toEqual(variants);
    fixture.modelVariantSessions["thread-atlas"].variants = { options: [] };
    expect(render()).toBe("");
    expect(render("none")).toContain("is unavailable");
    expect(render("none")).not.toContain('aria-label="Reasoning variant"');
  });

  it("ignores another conversation, account, or model's session choices and preserves unavailable saved ids", () => {
    const session = { instanceId: "opencode", model: "provider/model", turnId: "turn", startedAt: "2026-09-15T00:00:00Z", acceptingUpdates: false, variants: { options: [] } };
    fixture.modelVariantSessions["other-thread"] = session;
    expect(levelButtons(render())).toHaveLength(4);
    fixture.modelVariantSessions["thread-atlas"] = { ...session, instanceId: "other-account" };
    expect(levelButtons(render())).toHaveLength(4);
    fixture.modelVariantSessions["thread-atlas"] = { ...session, model: "other-model" };
    expect(levelButtons(render())).toHaveLength(4);
    expect(render("removed")).toContain("Saved variant “removed” has not been checked in this session.");
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("does not invent default or expose a control on a model without variants", () => {
    fixture.instances[0].models.options[0].variants = [{ id: "minimal", label: "Minimal" }];
    expect(levelButtons(render()).map((button) => button.label)).toEqual(["Minimal"]);
    fixture.instances[0].models.options[0].variants = [];
    expect(render()).toBe("");
    fixture.instances[0].capabilities = {};
    expect(render("none")).toBe("");
  });

  it("does not declare a saved default invalid on reload before ACP announces its choices", () => {
    fixture.instances[0].models.options[0].variants = [{ id: "minimal", label: "Minimal" }];
    const markup = render("default");
    expect(markup).toContain("has not been checked in this session");
    expect(markup).not.toContain("is unavailable");
    expect(levelButtons(markup).map((button) => button.label)).toEqual(["Minimal"]);
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("keeps the saved choice after reload while allowing profile choices to update the profile", () => {
    expect(levelButtons(render("minimal")).find((button) => button.pressed)?.label).toBe("Minimal");
    const row = ModelVariantRow({ bot: selected(), updateBotDefault: true })!;
    const group = Children.toArray(row.props.children).at(-1) as ReactElement<{ children: ReactNode }>;
    (Children.toArray(group.props.children)[1] as ReactElement<{ onClick: () => void }>).props.onClick();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "setModel", botId: "atlas", threadId: undefined, updateBotDefault: true,
      selection: { instanceId: "opencode", model: "provider/model", variant: "minimal" } });
  });

  it("drops an opaque variant when switching models/accounts but keeps it when reselecting the same model", () => {
    const selection = selected("minimal").modelSelection;
    expect(modelSelectionForPick(selection, opencode(), "provider/other")).toEqual({ instanceId: "opencode", model: "provider/other" });
    expect(modelSelectionForPick(selection, { ...opencode(), instanceId: "other" }, "provider/model")).toEqual({ instanceId: "other", model: "provider/model" });
    expect(modelSelectionForPick(selection, opencode(), "provider/model")).toEqual(selection);
    expect(modelSelectionForPick({ ...selection, effort: "high" }, opencode(), "provider/other")).not.toHaveProperty("effort");
    expect(modelSelectionForPick(bot("high").modelSelection, engine(["high"]), "other")).toEqual({ instanceId: "codex", model: "other", effort: "high" });
  });
});

describe("ModelPicker trigger", () => {
  const renderTrigger = (effort?: EffortLevel) => {
    fixture.instances = [engine(["low", "high"])];
    return renderToStaticMarkup(createElement(ModelPicker, { bot: bot(effort) }));
  };

  /** The visible effort suffix, not the tooltip that also names the level. */
  const effortChip = (markup: string) =>
    markup.match(/<span data-model-effort[^>]*>(.*?)<\/span>/s)?.[1].replace(/<!--.*?-->/g, "").trim();

  it("names the thread in busy header help and the bot in profile settings", () => {
    fixture.instances = [engine()];
    for (const threadId of ["independent-thread", undefined]) {
      const markup = renderToStaticMarkup(createElement(ModelPicker, { bot: { ...bot(), busy: true }, threadId }));
      expect(markup).toContain(`Stop this ${threadId ? "thread" : "bot"}&#x27;s turn before changing its model`);
    }
  });

  it("shows the model and its effort together in the header", () => {
    const markup = renderTrigger("high");

    expect(markup).toContain("GPT-5.6");
    expect(effortChip(markup)).toBe("· High");
    expect(markup).toContain("Codex · GPT-5.6 · High effort");
  });

  it("says nothing about effort when the bot sends no level", () => {
    const markup = renderTrigger();

    expect(markup).toContain("GPT-5.6");
    expect(effortChip(markup)).toBeUndefined();
    expect(markup).not.toContain("effort");
    expect(markup).toContain("@max-4xl/chathead:size-[30px]");
    expect(markup).not.toContain("data-model-account-compact");
  });

  it("visibly identifies the selected account when Claude has multiple instances", () => {
    fixture.instances = [
      { ...engine(), instanceId: "claude-personal", driverKind: "claudeAgent", displayName: "Personal" },
      { ...engine(), instanceId: "claude-work", driverKind: "claudeAgent", displayName: "Work" },
    ];
    const markup = renderToStaticMarkup(createElement(ModelPicker, {
      bot: { ...bot(), modelSelection: { instanceId: "claude-work", model: "gpt-5.6" } },
    }));
    expect(markup).toMatch(/<span data-model-account[^>]*>Work · <\/span>/);
    expect(markup).not.toMatch(/<span data-model-account[^>]*>Personal/);
    // The account remains a compact-only sibling of the hidden model label,
    // and its button no longer squeezes into the icon-only 30px square.
    expect(markup).toMatch(/<span data-model-account-compact="true" class="hidden max-w-20 truncate @max-4xl\/chathead:inline">Work<\/span><span class="[^"]*@max-4xl\/chathead:hidden"/);
    expect(markup).not.toContain("@max-4xl/chathead:size-[30px]");
  });
});

describe("Claude provider and account selection", () => {
  const personal: InstanceInfo = { ...engine(), instanceId: "claude-personal", driverKind: "claudeAgent", displayName: "Personal" };
  const work: InstanceInfo = { ...engine(), instanceId: "claude-work", driverKind: "claudeAgent", displayName: "Work", access: "custom" };

  it("shows engine status beside its name and keeps active separate from browsing", () => {
    const missing: InstanceInfo = { ...engine(), instanceId: "qwen", displayName: "Qwen", cliDefault: "qwen", cliCandidates: [], snapshot: { state: "unavailable" } };
    const markup = renderToStaticMarkup(createElement(ModelEngineRail, {
      instances: [engine(), missing], selectedInstance: missing, activeInstanceId: "codex", onSelect: () => {},
    }));
    expect(markup).toContain(">Codex</span>");
    expect(markup).toContain(">Active</span>");
    expect(markup).toContain(">Not installed</span>");
    expect(markup).toContain('title="Qwen · Not installed"');
  });

  it("renders one Claude provider across Cloud and Local, pressed for either account", () => {
    for (const selectedInstance of [personal, work]) {
      const markup = renderToStaticMarkup(createElement(ModelEngineRail, {
        instances: [engine(), personal, work], selectedInstance, claudeInstance: work, onSelect: () => {},
      }));
      expect(markup.match(/aria-label="Claude"/g)).toHaveLength(1);
      expect(markup).toContain('aria-label="Claude" aria-pressed="true"');
      expect(markup).toContain('aria-label="Codex" aria-pressed="false"');
      expect(markup).not.toContain('aria-label="Personal"');
      expect(markup).not.toContain('aria-label="Work"');
    }
  });

  it("opens the remembered concrete Claude account, falling back to the first account", () => {
    const onSelect = vi.fn();
    for (const claudeInstance of [work, undefined]) {
      const rail = ModelEngineRail({ instances: [personal, work], claudeInstance, onSelect });
      const button = Children.toArray(rail.props.children).find((child) => (child as ReactElement).type === "button") as ReactElement<{ onClick: () => void }>;
      button.props.onClick();
      expect(onSelect).toHaveBeenLastCalledWith(claudeInstance ?? personal);
    }
  });

  it("maps named native options to concrete instances without committing a model", () => {
    const onSelect = vi.fn();
    const dropdown = ClaudeAccountSelect({ accounts: [personal, work], selectedId: work.instanceId, onSelect });
    const markup = renderToStaticMarkup(dropdown);
    expect(markup).toContain('aria-label="Account"');
    expect(markup).toContain('<option value="claude-personal">Personal</option>');
    expect(markup).toContain('<option value="claude-work" selected="">Work</option>');
    const select = Children.toArray(dropdown.props.children)[1] as ReactElement<{ onChange: (event: ChangeEvent<HTMLSelectElement>) => void }>;
    select.props.onChange({ target: { value: personal.instanceId } } as ChangeEvent<HTMLSelectElement>);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(personal);
  });
});
