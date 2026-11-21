import assert from "node:assert/strict";
import test from "node:test";

import { openComputerSettings } from "./open-computer-settings.mjs";

const LOCAL = "http://127.0.0.1:8799";
const CLOUD = "https://home.example";

/** The window and this computer's one server: `runs` is what that server runs (This computer's own copy, or a profile),
 * `shows` the address on screen. Settings opens on whatever runs once the window shows this computer's page, whether
 * it is asked by message or by address. `showLocal` is the switch to This computer, which may not land. */
function world({ runs, shows = CLOUD, lands = true }) {
  const w = { runs, shows, opened: [] };
  const window = { isDestroyed: () => false, webContents: { send: (channel, page) => { if (channel === "app:open-settings" && w.shows === LOCAL) w.opened.push([w.runs, page]); } } };
  w.deps = {
    window: () => window,
    onLocal: () => w.shows === LOCAL,
    showLocal: async () => { await Promise.resolve(); if (lands) { w.runs = "computer"; w.shows = LOCAL; } },
    origin: () => LOCAL,
    navigate: (url) => {
      const to = new URL(url);
      w.shows = to.origin;
      if (w.shows === LOCAL && to.searchParams.get("desktop-settings")) w.opened.push([w.runs, to.searchParams.get("desktop-settings")]);
    },
  };
  return w;
}

test("from a Cloud, with a profile running here, Settings opens on This computer once the switch has brought it back", async () => {
  const w = world({ runs: "profile" });
  await openComputerSettings(w.deps, "app");
  assert.deepEqual(w.opened, [["computer", "app"]]);
});

test("a switch that does not land opens no Settings, and the Cloud stays on screen", async () => {
  const w = world({ runs: "profile", lands: false });
  await openComputerSettings(w.deps, "account");
  assert.deepEqual(w.opened, []);
  assert.equal(w.shows, CLOUD);
});

test("already on This computer, Settings opens there on the page asked for", async () => {
  const w = world({ runs: "computer", shows: LOCAL });
  await openComputerSettings(w.deps, "phone");
  assert.deepEqual(w.opened, [["computer", "phone"]]);
});
