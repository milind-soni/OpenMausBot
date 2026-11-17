// The always-on home's switch with the real login item (open-at-login.mjs) and lending's own use of it, against fakes of
// each system's login items: macOS keeps one item with no arguments, Windows one Run entry per name (read as on only for
// the arguments asked about), Linux one autostart file.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createAlwaysOnHome } from "./always-on-home.mjs";
import { createOpenAtLogin, HIDDEN_ARG } from "./open-at-login.mjs";

const blocker = { start: () => 1, stop() {}, isStarted: () => true };
const CHOSEN = "OpenMausBot at login";

function world(t, platform) {
  const dir = mkdtempSync(path.join(tmpdir(), "omb-always-on-login-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const items = new Map();
  let macOn = false;
  const app = platform === "win32"
    ? {
      isPackaged: true,
      getLoginItemSettings: (asked = {}) => ({
        openAtLogin: [...items.values()].some(item => JSON.stringify(item.args) === JSON.stringify(asked.args ?? [])),
        launchItems: [...items].map(([name, item]) => ({ name, args: item.args, enabled: true })),
      }),
      setLoginItemSettings: ({ openAtLogin, args = [], name = "app" }) => { if (openAtLogin) items.set(name, { args }); else items.delete(name); },
    }
    : { isPackaged: true, getLoginItemSettings: () => ({ openAtLogin: macOn }), setLoginItemSettings: ({ openAtLogin }) => { macOn = openAtLogin; } };
  const loginFile = path.join(dir, "open-at-login.json");
  const login = createOpenAtLogin({ app, file: loginFile, platform, home: dir, env: { XDG_CONFIG_HOME: path.join(dir, "config") }, execPath: "/opt/omb/omb" });
  let lent = false;
  const make = () => createAlwaysOnHome({ file: path.join(dir, "always-on-home.json"), loginItem: login, blocker, isOnBattery: () => false, lending: () => lent, platform, lookMs: 3_600_000 });
  const autostart = path.join(dir, "config", "autostart", "openmausbot.desktop");
  return {
    login, items, make, home: make(),
    /** Lending starts or stops: its own login item follows, as main's sharing onChange does. */
    lend(on) { lent = on; login.follow(on); },
    macOn: () => macOn,
    names: () => [...items.keys()].sort(),
    declined: () => { try { return JSON.parse(readFileSync(loginFile, "utf8")).declined; } catch { return undefined; } },
    autostart: () => (existsSync(autostart) ? readFileSync(autostart, "utf8") : null),
  };
}
const marked = text => text !== null && text.includes("X-OpenMausBot-Lending=true") && text.includes(HIDDEN_ARG);

test("Windows: off removes only the switch's own entry, so lending can add its hidden one afterwards", t => {
  const w = world(t, "win32");
  assert.equal(w.home.set(true).openAtLogin, true);
  assert.deepEqual(w.names(), [CHOSEN]);
  w.home.set(false);
  assert.deepEqual(w.names(), []);
  w.lend(true);
  assert.deepEqual(w.names(), ["app"], "lending's entry, as if the switch had never been on");
  assert.deepEqual(w.items.get("app").args, [HIDDEN_ARG]);
});

test("Windows: the person's earlier Off is put back when the switch goes off", t => {
  const w = world(t, "win32");
  w.login.choose(false);
  assert.equal(w.declined(), true);
  w.home.set(true);
  assert.deepEqual(w.names(), [CHOSEN]);
  assert.equal(w.declined(), false);
  w.make().set(false);
  assert.equal(w.declined(), true, "what it saved is still known after a restart");
  w.lend(true);
  assert.deepEqual(w.names(), [], "lending still adds nothing, as before the switch");
});

test("Windows: off while lending leaves lending's entry; on while lending adds none of its own", t => {
  const w = world(t, "win32");
  w.home.set(true);
  w.lend(true);
  assert.deepEqual(w.names(), [CHOSEN, "app"]);
  w.home.set(false);
  assert.deepEqual(w.names(), ["app"]);
  w.lend(false);
  assert.deepEqual(w.names(), []);

  const v = world(t, "win32");
  v.lend(true);
  assert.equal(v.home.set(true).openAtLogin, true, "lending's entry already starts the app: counted as on");
  assert.deepEqual(v.names(), ["app"]);
  v.lend(false);
  assert.deepEqual(v.names(), ["app"], "while the switch is on, lending stopping leaves the entry");
  v.home.set(false);
  assert.deepEqual(v.names(), [], "off: lending's own bookkeeping takes it away");
});

test("Windows: the person's own change while the switch is on is kept at off", t => {
  const w = world(t, "win32");
  w.home.set(true);
  w.login.choose(false);
  w.home.set(false);
  assert.equal(w.declined(), true, "their Off stays");
  w.lend(true);
  assert.deepEqual(w.names(), []);

  const v = world(t, "win32");
  v.home.set(true);
  v.login.choose(false);
  v.login.choose(true);
  v.home.set(false);
  assert.deepEqual(v.names(), [CHOSEN], "their On stays");
});

test("macOS: on and off with lending to a server of the person's own leaves lending's login item", t => {
  const m = world(t, "darwin");
  m.lend(true);
  assert.equal(m.home.set(true).openAtLogin, true);
  assert.equal(m.login.chosen(), false, "still lending's, not taken over");
  m.home.set(false);
  assert.equal(m.macOn(), true);
  m.lend(false);
  assert.equal(m.macOn(), false);
});

test("macOS: off while lending hands the item to lending, which removes it once it stops", t => {
  const m = world(t, "darwin");
  m.home.set(true);
  assert.equal(m.macOn(), true);
  m.lend(true);
  m.home.set(false);
  assert.deepEqual([m.macOn(), m.login.chosen()], [true, false]);
  m.lend(false);
  assert.deepEqual([m.macOn(), m.login.chosen()], [false, false]);
});

test("macOS: lending stopping while the switch is on leaves the item; off then takes it away", t => {
  const m = world(t, "darwin");
  m.lend(true);
  m.home.set(true);
  m.lend(false);
  assert.equal(m.macOn(), true);
  assert.equal(m.make().state().openAtLogin, true, "after a restart too");
  m.home.set(false);
  assert.equal(m.macOn(), false);
});

test("macOS: the person's own login item stays, and so does one they chose while the switch was on", t => {
  const m = world(t, "darwin");
  m.login.choose(true);
  m.home.set(true);
  m.home.set(false);
  assert.deepEqual([m.macOn(), m.login.chosen()], [true, true]);

  const n = world(t, "darwin");
  n.home.set(true);
  n.login.choose(false);
  n.login.choose(true);
  n.home.set(false);
  assert.deepEqual([n.macOn(), n.login.chosen()], [true, true]);

  const o = world(t, "darwin");
  o.home.set(true);
  o.home.set(false);
  assert.equal(o.macOn(), false, "the item the switch added goes");
});

test("Linux: the switch's own entry goes at off; lending's marked file is never overwritten, and is handed back", t => {
  const l = world(t, "linux");
  l.home.set(true);
  assert.equal(marked(l.autostart()), false);
  assert.ok(l.autostart()?.includes("Exec="));
  l.home.set(false);
  assert.equal(l.autostart(), null);

  const k = world(t, "linux");
  k.lend(true);
  k.home.set(true);
  assert.equal(marked(k.autostart()), true, "lending's file stays lending's");
  k.lend(false);
  assert.equal(marked(k.autostart()), true, "kept while the switch is on");
  k.home.set(false);
  assert.equal(k.autostart(), null);

  const j = world(t, "linux");
  j.home.set(true);
  j.lend(true);
  j.home.set(false);
  assert.equal(marked(j.autostart()), true, "off while lending: now lending's");
  j.lend(false);
  assert.equal(j.autostart(), null);
});
