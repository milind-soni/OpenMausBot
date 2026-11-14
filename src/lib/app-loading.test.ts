import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { loadingLine } from "./app-loading";

afterEach(() => { vi.unstubAllGlobals(); });

const line = (connected: boolean, hydrated: boolean, { updating = false, developer = false } = {}) => loadingLine({ connected, hydrated, updating, developer });

it("says No bots yet only once the bots have loaded and there are none, never while they load after the move", () => {
  expect(line(true, false), "connected, bots not loaded yet").toEqual({ text: "app.loading.connecting", busy: true, command: false });
  expect(line(false, false).text).toBe("app.loading.connecting");
  expect(line(true, true)).toEqual({ text: "app.loading.noBots", busy: false, command: false });
});

it("says Updating My Cloud… while the page the window reloaded for its newer version loads", () => {
  expect(line(false, false, { updating: true })).toEqual({ text: "app.loading.updating", busy: true, command: false });
  expect(line(true, false, { updating: true }).text).toBe("app.loading.updating");
  expect(line(true, true, { updating: true }).text, "loaded: the update is over").toBe("app.loading.noBots");
});

it("learns from the desktop app that the window reloaded My Cloud's page for its newer version", () => {
  vi.stubGlobal("window", { ogb: { home: { updating: true } } });
  expect(loadingLine({ connected: false, hydrated: false, developer: false }).text).toBe("app.loading.updating");
  vi.stubGlobal("window", { ogb: { home: { updating: false } } });
  expect(loadingLine({ connected: false, hydrated: false, developer: false }).text).toBe("app.loading.connecting");
  vi.stubGlobal("window", {});
  expect(loadingLine({ connected: false, hydrated: false, developer: false }).text, "a browser").toBe("app.loading.connecting");
});

it("names the command that starts a server only in a developer's build, while nothing answers", () => {
  expect(line(false, false).command).toBe(false);
  expect(line(false, false, { updating: true, developer: true }).command).toBe(true);
  expect(line(false, false, { developer: true }).command).toBe(true);
  expect(line(true, false, { developer: true }).command).toBe(false);
});

it("the app's main area says what loadingLine says, and the command only when it says so", () => {
  const app = readFileSync(join(process.cwd(), "src", "App.tsx"), "utf8");
  expect(app).toContain("{t(loading.text)}");
  expect(app).toMatch(/\{loading\.command && \(\s*<div[^]*?pnpm dev:server/u);
  expect(app).not.toContain("app.loading.noBots");
});
