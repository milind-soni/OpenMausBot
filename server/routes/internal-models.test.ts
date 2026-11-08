import { describe, expect, it, vi } from "vitest";

import type { ModelSelection } from "../../shared/wire.ts";
import { MENU_FOUND, MENU_SHORT, modelMenu as menuOf, type MenuEngine } from "./internal-models.ts";

const engine = (instanceId: string, ids: readonly string[], extra: Partial<MenuEngine> = {}): MenuEngine => ({
  instanceId, driverKind: instanceId, displayName: instanceId[0]!.toUpperCase() + instanceId.slice(1),
  models: { default: ids[0] ?? "", options: ids.map((id) => ({ id, label: id })) },
  adapter: { capabilities: {} },
  ...extra,
});
const current: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
const opens = () => null;
const modelMenu = (input: Omit<Parameters<typeof menuOf>[0], "down"> & { down?: (engine: MenuEngine) => boolean }) => menuOf({ down: () => false, ...input });

describe("modelMenu", () => {
  it("keeps a 2,000-model catalog to a short list, its current model first, and counts the rest", () => {
    const huge = engine("opencode", Array.from({ length: 2_000 }, (_, i) => `provider/model-${i}`));
    const refusal = vi.fn(opens);
    const menu = modelMenu({ engines: [huge], current: { instanceId: "opencode", model: "provider/model-1500" }, pinned: [], refusal });
    expect(menu.engines).toEqual([{ instanceId: "opencode", name: "Opencode",
      models: ["provider/model-1500", "provider/model-0", ...Array.from({ length: MENU_SHORT - 2 }, (_, i) => `provider/model-${i + 1}`)], more: 2_000 - MENU_SHORT }]);
    expect(refusal).toHaveBeenCalledTimes(MENU_SHORT);
    expect(JSON.stringify(menu).length).toBeLessThan(400);
  });

  it("lists a small catalog whole, without what the organization turned off, with efforts and only the labels that add something", () => {
    const claude = engine("claude", [], {
      models: { default: "claude-sonnet-5", options: [
        { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
        { id: "claude-opus-5", label: "Claude Opus 5" },
        { id: "claude-haiku-5", label: "Haiku", orgBlocked: true },
        { id: "default", label: "Default (recommended)" },
      ] },
      adapter: { capabilities: { effortLevels: ["low", "high", "max"] } },
    });
    expect(modelMenu({ engines: [claude], current, pinned: [], refusal: opens })).toEqual({ current, engines: [{
      instanceId: "claude", name: "Claude", models: ["claude-sonnet-5", "claude-opus-5", { id: "default", label: "Default (recommended)" }], efforts: ["low", "high", "max"],
    }] });
  });

  it("marks an engine unusable with start_thread's own reason after a few refusals, without checking the rest of a big catalog", () => {
    const grok = engine("grok", Array.from({ length: 500 }, (_, i) => `grok-${i}`));
    const refusal = vi.fn((selection: ModelSelection) => selection.instanceId === "grok" ? "Grok · grok-0 can't run now: it is signed out." : null);
    const menu = modelMenu({ engines: [grok, engine("claude", ["claude-sonnet-5"])], current, pinned: [], refusal });
    expect(menu.engines).toEqual([
      { instanceId: "grok", name: "Grok", unusable: "Grok · grok-0 can't run now: it is signed out." },
      { instanceId: "claude", name: "Claude", models: ["claude-sonnet-5"] },
    ]);
    expect(refusal.mock.calls.filter(([selection]) => selection.instanceId === "grok")).toHaveLength(3);
  });

  it("stops after a few refusals in a row even when the current model passed, instead of checking a whole catalog", () => {
    const opencode = engine("opencode", Array.from({ length: 2_000 }, (_, i) => `provider/model-${i}`));
    const mine = { instanceId: "opencode", model: "provider/model-7" };
    const refusal = vi.fn((selection: ModelSelection) => selection.model === mine.model ? null : "OpenCode can't run now: its engine is unavailable.");
    const menu = modelMenu({ engines: [opencode], current: mine, pinned: [], refusal });
    expect(menu.engines).toEqual([{ instanceId: "opencode", name: "Opencode", models: ["provider/model-7"], more: 2_000 - 4 }]);
    expect(refusal).toHaveBeenCalledTimes(4);
  });

  it("names engines that can't run anything in one list instead of a row each, and search finds them by name", () => {
    const engines = [engine("claude", ["claude-sonnet-5"]), engine("cursor", ["auto"]), engine("mistral", ["mistral-large"])];
    const down = (row: MenuEngine) => row.instanceId !== "claude";
    const refusal = vi.fn((_selection: ModelSelection) => null);
    expect(modelMenu({ engines, current, pinned: [], refusal, down })).toEqual({ current,
      engines: [{ instanceId: "claude", name: "Claude", models: ["claude-sonnet-5"] }], unavailable: ["Cursor", "Mistral"] });
    expect(refusal.mock.calls.every(([selection]) => selection.instanceId === "claude")).toBe(true);
    expect(modelMenu({ engines, current, pinned: [], refusal: opens, down, search: "mistral" })).toEqual({ current, engines: [], unavailable: ["Mistral"] });
  });

  it("leaves out a single model start_thread would refuse and keeps the engine", () => {
    const menu = modelMenu({ engines: [engine("codex", ["gpt-5.5", "gpt-5.5-pro", "gpt-5.5-mini"])], current, pinned: [],
      refusal: (selection) => selection.model === "gpt-5.5-pro" ? "This account's organization turned that model off." : null });
    expect(menu.engines).toEqual([{ instanceId: "codex", name: "Codex", models: ["gpt-5.5", "gpt-5.5-mini"] }]);
  });

  it("search matches engine names, ids and labels across engines, drops engines with no match, and caps what it returns", () => {
    const engines = [
      engine("claude", ["claude-sonnet-5", "claude-opus-5"]),
      engine("opencode", Array.from({ length: 300 }, (_, i) => `anthropic/claude-opus-${i}`)),
      engine("codex", ["gpt-5.5"]),
    ];
    const menu = modelMenu({ engines, current, pinned: [], refusal: opens, search: "  OPUS " });
    expect(menu.engines.map((row) => row.instanceId)).toEqual(["claude", "opencode"]);
    expect(menu.engines[0]!.models).toEqual(["claude-opus-5"]);
    expect(menu.engines[1]!.models).toHaveLength(MENU_FOUND - 1);
    expect(menu.engines[1]!.more).toBe(300 - (MENU_FOUND - 1));
    expect(modelMenu({ engines, current, pinned: [], refusal: opens, search: "codex" }).engines).toEqual([{ instanceId: "codex", name: "Codex", models: ["gpt-5.5"] }]);
  });
});
