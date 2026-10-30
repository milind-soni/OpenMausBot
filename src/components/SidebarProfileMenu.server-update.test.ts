import { createElement, type EffectCallback } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ServerUpdateCheck } from "@/lib/server-update";

// React's hooks are replayed by hand.
const f = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[], check: null as unknown }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = initial; return [f.values[index], (next: unknown) => { f.values[index] = next; }]; },
  useEffect: (effect: EffectCallback) => { f.effects.push(effect); },
}));
vi.mock("@/state/store", () => ({ api: vi.fn(async () => f.check), useStore: () => ({ state: { config: {} }, dispatch: vi.fn() }) }));
import { useServerUpdateItem } from "./SidebarProfileMenu";

// The server the window shows, on 0.1.116 from npm, while 0.1.127 is out.
const npmServer: ServerUpdateCheck = {
  current: "0.1.116", install: "npm", latest: "0.1.127", available: true, command: "npm install -g openmausbot@latest", restart: true,
};
let entry: ReturnType<typeof useServerUpdateItem>;
function render() {
  f.index = 0; f.effects = [];
  renderToStaticMarkup(createElement(() => { entry = useServerUpdateItem(true); return null; }));
}
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
async function checkedRow(page: object) {
  f.values = [];
  vi.stubGlobal("window", page);
  render();
  for (const effect of f.effects) effect();
  await flush();
  render();
  entry!.item.onSelect?.();
  await flush();
  render();
  return { label: entry!.item.label, subtitle: entry!.item.subtitle, attention: entry!.item.attention };
}

beforeEach(() => { f.check = npmServer; });
afterEach(() => vi.unstubAllGlobals());

it("in the app on another server, says the update is that server's, for whoever runs it", async () => {
  const workspaces = { state: vi.fn(async () => ({ local: false, name: "Office Mac", origin: "https://bots.example.test" })) };
  expect(await checkedRow({ ogb: { app: { version: "0.1.127", ownPage: false }, workspaces }, location: { host: "bots.example.test" } })).toEqual({
    label: "Office Mac can update to 0.1.127",
    subtitle: "Whoever runs that server updates it with: npm install -g openmausbot@latest, then restarts it",
    attention: true,
  });
});

it("names the server by its address until the app says its saved name", async () => {
  const workspaces = { state: vi.fn(() => new Promise(() => {})) };
  expect((await checkedRow({ ogb: { app: { version: "0.1.127", ownPage: false }, workspaces }, location: { host: "bots.example.test" } })).label)
    .toBe("bots.example.test can update to 0.1.127");
});

it("keeps today's row in a browser on that server and in the app on this computer", async () => {
  const today = {
    label: "Version 0.1.127 available (release notes)",
    subtitle: "Update with: npm install -g openmausbot@latest, then restart the app",
    attention: true,
  };
  expect(await checkedRow({ location: { host: "bots.example.test" } })).toEqual(today);
  expect(await checkedRow({ ogb: { app: { version: "0.1.127", ownPage: true } }, location: { host: "127.0.0.1:8799" } })).toEqual(today);
});
