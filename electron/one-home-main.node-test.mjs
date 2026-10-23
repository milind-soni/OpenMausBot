import assert from "node:assert/strict";
import test from "node:test";

import { installOneHome } from "./one-home-main.mjs";

const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

/** A main window whose page takes keys: `type()` is the person pressing one. */
function fakeWindow() {
  const listeners = [];
  const webContents = { on: (event, listener) => { if (event === "before-input-event") listeners.push(listener); }, id: 1 };
  return { isDestroyed: () => false, webContents, type: () => { for (const listener of listeners) listener({}, { type: "keyDown", key: "a" }); } };
}

test("the move's quiet moment counts keys pressed before it first asks, so it never freezes this computer mid-sentence", async () => {
  // Seen in the real app on Oct 22: real keys every second in a bot's message box, and this computer froze 1 s after one,
  // because the key watch was only set up the first time the wait asked, which then read "never typed".
  const win = fakeWindow();
  let kept = null;
  const main = installOneHome({
    ipcMain: { handle: () => {} }, cloudPage: () => "local", server: () => null, home: () => null, cookieFetch: async () => json({}, 401),
    reconnect: async () => false, power: { asleep: () => false }, file: () => "/nonexistent/cloud-send.json", window: () => win, localOrigin: () => "http://127.0.0.1:4100",
    fetch: async () => json({}, 404), localRequest: async () => json({}, 404), account: () => null, journalFile: () => "/nonexistent/one-home.json",
    tempRoot: () => "/nonexistent", journal: { read: () => kept, write: (value) => { kept = value; } },
  });
  try {
    await main.kick();
    const before = Date.now();
    win.type();
    assert.ok(main.lastInput() >= before, `a key pressed once the move has looked is counted: ${main.lastInput()}`);
  } finally { main.close(); }
});

test("a key watch set up only as it is first asked knows nothing yet, so it counts as a key just now and the reload or freeze waits its quiet time", () => {
  // The window can open after the launch's first look; then My Cloud's version reload asks first. Seen in the real app:
  // the reload came 2 s after a key, mid-sentence, and the draft was lost.
  const win = fakeWindow();
  let kept = null;
  const main = installOneHome({
    ipcMain: { handle: () => {} }, cloudPage: () => "local", server: () => null, home: () => null, cookieFetch: async () => json({}, 401),
    reconnect: async () => false, power: { asleep: () => false }, file: () => "/nonexistent/cloud-send.json", window: () => win, localOrigin: () => "http://127.0.0.1:4100",
    fetch: async () => json({}, 404), localRequest: async () => json({}, 404), account: () => null, journalFile: () => "/nonexistent/one-home.json",
    tempRoot: () => "/nonexistent", journal: { read: () => kept, write: (value) => { kept = value; } },
  });
  try {
    const before = Date.now();
    assert.ok(main.lastInput() >= before, `never "typed long ago": ${main.lastInput()}`);
  } finally { main.close(); }
});

test("the switch that keeps this computer's bots here: only on this app's pages, and shown only to someone with a Cloud of their own the move applies to", async () => {
  const handlers = new Map();
  let state = null, kept = null, choice = null;
  const main = installOneHome({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, cloudPage: (event) => event.page ?? null, server: () => null, home: () => null,
    cookieFetch: async () => json({}, 401), reconnect: async () => false, power: { asleep: () => false }, file: () => "/nonexistent/cloud-send.json", window: () => null,
    localOrigin: () => "http://127.0.0.1:4100", fetch: async () => json({}, 404), localRequest: async () => json({ frozen: false }), account: () => (state ? { state: () => state } : null),
    journalFile: () => "/nonexistent/one-home.json", tempRoot: () => "/nonexistent", journal: { read: () => kept, write: (value) => { kept = value; } },
    keep: { read: () => choice, write: (value) => { choice = value; } },
  });
  const ask = (channel, page, ...args) => handlers.get(channel)({ page }, ...args);
  const hidden = { shown: false, on: false, moved: false, coming: false };
  const account = { id: "acct-1", email: "person@example.test" };
  const machine = { status: "ready", origin: "https://omb-t-1.fly.dev", moves: true };
  try {
    for (const channel of ["one-home:keep", "one-home:keep-set"]) assert.throws(() => ask(channel, null, true), /only available/u, channel);
    assert.deepEqual(ask("one-home:keep", "local"), hidden, "signed out");
    state = { status: "connected", account, entitlement: { plan: "free", status: "inactive" } };
    assert.deepEqual(ask("one-home:keep", "local"), hidden, "no Cloud");
    state = { status: "connected", account, entitlement: { plan: "pro", tier: "team", status: "active" }, teams: [{ id: "team-1", name: "Acme", role: "owner", machine }] };
    assert.deepEqual(ask("one-home:keep", "cloud"), hidden, "only a team's Cloud");
    assert.throws(() => ask("one-home:keep-set", "local", true), /no My Cloud/u);
    assert.equal(choice, null);
    state = { status: "connected", account, entitlement: { plan: "pro", tier: "personal", status: "active" }, machine: { ...machine, moves: false } };
    assert.deepEqual(ask("one-home:keep", "local"), hidden, "a Cloud the move doesn't apply to yet");
    state = { ...state, machine };
    assert.deepEqual(ask("one-home:keep", "local"), { shown: true, on: false, moved: false, coming: false });
    assert.deepEqual(ask("one-home:keep-set", "cloud", true), { shown: true, on: true, moved: false, coming: false });
    assert.equal(choice.on, true, "kept on this computer");
    await main.oneHome.kick();
    assert.equal(kept, null, "and no move starts");
    state = { ...state, machine: { ...machine, moves: false } };
    assert.deepEqual(ask("one-home:keep", "local"), { shown: true, on: true, moved: false, coming: false }, "switched on, it stays shown, so it can be switched off");
  } finally { main.close(); }
});
