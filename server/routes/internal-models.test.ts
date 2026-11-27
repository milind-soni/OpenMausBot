import { describe, expect, it, vi } from "vitest";

import type { ModelSelection } from "../../shared/wire.ts";
import type { EngineHint } from "../host/engine-hints.ts";
import { MENU_FOUND, MENU_SHORT, modelMenu as menuOf, type MenuEngine } from "./internal-models.ts";

const engine = (instanceId: string, ids: readonly string[], extra: Partial<MenuEngine> = {}): MenuEngine => ({
  instanceId, driverKind: instanceId, displayName: instanceId[0]!.toUpperCase() + instanceId.slice(1),
  models: { default: ids[0] ?? "", options: ids.map((id) => ({ id, label: id })) },
  adapter: { capabilities: {} },
  ...extra,
});
const current: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
const opens = () => null;
const modelMenu = (input: Omit<Parameters<typeof menuOf>[0], "down"> & { down?: (engine: MenuEngine) => EngineHint | null }) => menuOf({ down: () => null, ...input });
const notInstalled: EngineHint = { why: "not installed", connect: "install it in Settings → AI → Providers" };

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

  it("lists a small catalog whole, with efforts and only the labels that add something, and says what the organization turned off", () => {
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
      blocked: [{ id: "claude-haiku-5", why: "turned off by this account's organization" }],
    }] });
  });

  it("scopes engine efforts in the menu to listed models' per-model effortLevels", () => {
    const noUltra = engine("codex", [], {
      models: { default: "gpt-5.3", options: [{ id: "gpt-5.3", label: "GPT-5.3", effortLevels: ["low", "medium", "high", "xhigh", "max"] }] },
      adapter: { capabilities: { effortLevels: ["low", "medium", "high", "xhigh", "max", "ultra"] } },
    });
    expect(modelMenu({ engines: [noUltra], current, pinned: [], refusal: opens }).engines[0]).toMatchObject({
      efforts: ["low", "medium", "high", "xhigh", "max"],
    });
    const withUltra = engine("codex", [], {
      models: {
        default: "gpt-5.4",
        options: [
          { id: "gpt-5.4", label: "GPT-5.4", effortLevels: ["low", "medium", "high", "xhigh", "max", "ultra"] },
          { id: "gpt-5.3", label: "GPT-5.3", effortLevels: ["low", "medium", "high", "xhigh", "max"] },
        ],
      },
      adapter: { capabilities: { effortLevels: ["low", "medium", "high", "xhigh", "max", "ultra"] } },
    });
    expect(modelMenu({ engines: [withUltra], current, pinned: [], refusal: opens }).engines[0]).toMatchObject({
      efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    });
  });

  it("names a model the installed CLI is too old for, with the version it needs, instead of dropping it (Fable 5.2 'gone' after an update)", () => {
    const claude = engine("claude", [], {
      models: { default: "claude-sonnet-5", options: [
        { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
        { id: "claude-fable-5-2", label: "Claude Fable 5.2", needsCliUpdate: "2.1.321" },
      ] },
    });
    const why = "needs Claude CLI 2.1.321 or newer: update it";
    expect(modelMenu({ engines: [claude], current, pinned: [], refusal: opens }).engines).toEqual([{
      instanceId: "claude", name: "Claude", models: ["claude-sonnet-5"], blocked: [{ id: "claude-fable-5-2", why }],
    }]);
    expect(modelMenu({ engines: [claude], current, pinned: [], refusal: opens, search: "fable 5.2" }).engines).toEqual([{
      instanceId: "claude", name: "Claude", blocked: [{ id: "claude-fable-5-2", why }],
    }]);
  });

  it("keeps the reason on an engine whose only matching model is a gated current one that start_thread refuses", () => {
    const claude = engine("claude", [], {
      models: { default: "claude-sonnet-5", options: [{ id: "claude-fable-5-2", label: "Claude Fable 5.2", needsCliUpdate: "2.1.321" }] },
    });
    const fable: ModelSelection = { instanceId: "claude", model: "claude-fable-5-2" };
    const refused = "Claude · claude-fable-5-2 can't run now: update Claude Code.";
    expect(modelMenu({ engines: [claude], current: fable, pinned: [], refusal: () => refused, search: "claude-fable-5-2" }).engines).toEqual([{
      instanceId: "claude", name: "Claude", unusable: refused, blocked: [{ id: "claude-fable-5-2", why: "needs Claude CLI 2.1.321 or newer: update it" }],
    }]);
  });

  it("marks an engine unusable with start_thread's own reason after a few refusals, without checking the rest of a big catalog", () => {
    const grok = engine("grok", Array.from({ length: 500 }, (_, i) => `grok-${i}`));
    const refusal = vi.fn((selection: ModelSelection) => selection.instanceId === "grok" ? "Grok · grok-0 can't run now: it is signed out." : null);
    const signedOut = (row: MenuEngine) => row.instanceId === "grok" ? { why: "not signed in", connect: "sign in with your Grok account in Settings → AI → Providers" } : null;
    const menu = modelMenu({ engines: [grok, engine("claude", ["claude-sonnet-5"])], current, pinned: [], refusal, signedOut });
    expect(menu.engines).toEqual([
      { instanceId: "grok", name: "Grok", unusable: "Grok · grok-0 can't run now: it is signed out.", connect: "sign in with your Grok account in Settings → AI → Providers" },
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
    const down = (row: MenuEngine) => row.instanceId !== "claude" ? notInstalled : null;
    const refusal = vi.fn((_selection: ModelSelection) => null);
    expect(modelMenu({ engines, current, pinned: [], refusal, down })).toEqual({ current,
      engines: [{ instanceId: "claude", name: "Claude", models: ["claude-sonnet-5"] }], unavailable: [{ engines: ["Cursor", "Mistral"], ...notInstalled }] });
    expect(refusal.mock.calls.every(([selection]) => selection.instanceId === "claude")).toBe(true);
    expect(modelMenu({ engines, current, pinned: [], refusal: opens, down, search: "mistral" })).toEqual({ current, engines: [], unavailable: [{ engines: ["Mistral"], ...notInstalled }] });
  });

  it("names an engine with no models yet and one whose settings can't be read, each with why and how to connect", () => {
    const signIn: EngineHint = { why: "not signed in", connect: "sign in with your Google account in Settings → AI → Providers" };
    const engines = [engine("claude", ["claude-sonnet-5"]), engine("antigravity", []), engine("kimi", [])];
    const down = (row: MenuEngine) => row.instanceId === "antigravity" ? signIn : row.instanceId === "kimi" ? notInstalled : null;
    const broken = [{ name: "Mine", hint: { why: "its saved settings can't be read", connect: "fix or remove it in Settings → AI → Providers" } }];
    expect(modelMenu({ engines, current, pinned: [], refusal: opens, down, broken }).unavailable).toEqual([
      { engines: ["Antigravity"], ...signIn }, { engines: ["Kimi"], ...notInstalled }, { engines: ["Mine"], ...broken[0]!.hint },
    ]);
    expect(modelMenu({ engines, current, pinned: [], refusal: opens, down, broken, search: "kimi" }).unavailable).toEqual([{ engines: ["Kimi"], ...notInstalled }]);
    // An engine that can run but has nothing to list stays out, as before; signed out, it is named with why.
    expect(modelMenu({ engines: [engine("kimi", [])], current, pinned: [], refusal: opens })).toEqual({ current, engines: [] });
    const signIn2 = { why: "not signed in", connect: "run `kimi login` in a terminal" };
    expect(modelMenu({ engines: [engine("kimi", [])], current, pinned: [], refusal: opens, signedOut: () => signIn2 }).unavailable).toEqual([{ engines: ["Kimi"], ...signIn2 }]);
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
