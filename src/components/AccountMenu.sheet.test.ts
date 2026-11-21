import { createElement, type EffectCallback } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// React's hooks are replayed by hand.
const f = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[] }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = initial; return [f.values[index], (next: unknown) => { f.values[index] = next; }]; },
  useEffect: (effect: EffectCallback) => { f.effects.push(effect); },
}));
import { useSheetOffered } from "./AccountMenu";

let result: boolean;
function render(enabled = true) {
  f.index = 0; f.effects = [];
  renderToStaticMarkup(createElement(() => { result = useSheetOffered(enabled); return null; }));
}
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

beforeEach(() => { f.values = []; f.index = 0; f.effects = []; });
afterEach(() => vi.unstubAllGlobals());

it("shows the accounts row only once main says it will open the sheet from this page", async () => {
  const offered = vi.fn().mockResolvedValue(true);
  vi.stubGlobal("window", { ogb: { accountSheet: { offered, open: vi.fn() } } });
  render();
  expect(result).toBe(false);
  f.effects[0]!(); await flush();
  render();
  expect(result).toBe(true);
});

it("hides the row on a page main refuses (a self-hosted VPS that isn't home), so the click never goes nowhere", async () => {
  vi.stubGlobal("window", { ogb: { accountSheet: { offered: vi.fn().mockResolvedValue(false), open: vi.fn() } } });
  render();
  f.effects[0]!(); await flush();
  render();
  expect(result).toBe(false);
});

it("stays hidden when asking fails, and never asks when it is not wanted or the bridge is missing", async () => {
  const offered = vi.fn().mockRejectedValue(new Error("no"));
  vi.stubGlobal("window", { ogb: { accountSheet: { offered, open: vi.fn() } } });
  render(); f.effects[0]!(); await flush(); render();
  expect(result).toBe(false);
  offered.mockClear(); f.values = [];
  render(false); f.effects[0]!(); await flush(); render(false);
  expect(result).toBe(false);
  expect(offered).not.toHaveBeenCalled();
  vi.stubGlobal("window", { ogb: {} });
  render(); f.effects[0]!(); await flush(); render();
  expect(result).toBe(false);
});

it("hides the row again when a later check fails after an earlier yes", async () => {
  const offered = vi.fn().mockResolvedValueOnce(true).mockRejectedValueOnce(new Error("no"));
  vi.stubGlobal("window", { ogb: { accountSheet: { offered, open: vi.fn() } } });
  render(); f.effects[0]!(); await flush(); render();
  expect(result).toBe(true);
  f.effects[0]!(); await flush(); render();
  expect(result).toBe(false);
});

it("drops an earlier yes while a new check is still pending", async () => {
  const offered = vi.fn().mockResolvedValueOnce(true).mockReturnValueOnce(new Promise(() => {}));
  vi.stubGlobal("window", { ogb: { accountSheet: { offered, open: vi.fn() } } });
  render(); f.effects[0]!(); await flush(); render();
  expect(result).toBe(true);
  f.effects[0]!(); render();
  expect(result).toBe(false);
});
