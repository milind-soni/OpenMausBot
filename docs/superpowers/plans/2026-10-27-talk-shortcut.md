# Talk Shortcut Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On macOS, hold ⌃⌥Space in any app, speak, let go of ⌃⌥, and the words go to MausBot's "Quick asks" chat on this Mac's server while a small box that never takes focus shows the live words and then the reply.

**Architecture:** `globalShortcut` sees the press; the existing speech helper sees the release (`--finish-on-release`, polling `CGEventSource.flagsState`). Small injected-dependency modules in Electron main do the rest: `talk-keys` (presets), `talk-shortcut` (registration and call presence), `talk-server` (find MausBot, keep the Quick asks chat, send, follow `/api/events`), `talk-panel` (the non-activating box), `talk-session` (the ask state machine). `speech.mjs` gains sinks so main can own a speech session without a window.

**Tech Stack:** Electron ^43.5.0 main (ESM `.mjs`, preload `.cjs`), Swift helper (`swiftc`), Node `node:test` for `electron/*.node-test.mjs`, vitest (+ happy-dom) for `electron/*.test.mjs`, `server/`, `src/`; React settings row.

**Spec:** `docs/superpowers/specs/2026-10-27-talk-shortcut-design.md`

## Global Constraints

- macOS only. Elsewhere nothing registers, `state().available` is false and the Settings row is hidden. A desktop running as a remote client of another computer (`desktopRemoteAccess`) has no local server: unavailable too.
- Keys, exactly: `ctrl-opt-space` → `Control+Alt+Space`, release `control,option`, label `⌃⌥Space` (default); `ctrl-shift-space` → `Control+Shift+Space`, `control,shift`, `⌃⇧Space`; `opt-shift-space` → `Alt+Shift+Space`, `option,shift`, `⌥⇧Space`.
- `desktop-prefs.json` gains `talkShortcut` (absent = on), `talkKey`, `quickAsks` (per server). Only fields that were set are written.
- Asks always go to this computer's own server, never the Cloud or team page the window shows. The chat is titled exactly `Quick asks`, created on first use with `select: false`, reused, recreated when gone.
- The box never takes focus and never raises the MausBot window: `type:"panel"`, `focusable:false`, `showInactive()`, never `show()`/`focus()`.
- Timings: reply box hides 12 s after it settles unless the pointer is over it; no answer in 120 s → "Still working · Open chat"; reply text is plain, at most 400 characters.
- Copy fixed by the spec: `Talk to MausBot from any app`, `Hold {key}, speak, let go`, `{key} is used by another app`, `Voice is in use in MausBot`, `Open MausBot to talk`, `Still working · Open chat`. Settings strings go in `src/locales/en.json` only (other languages fall back; `pnpm i18n:check` must pass). The box's own copy is English in v1: main has no locale catalogs.
- New bridge keys (`talkShortcut`, `callActive`) stay out of `REMOTE_SAFE`; their IPC is `localOnly` (`call:active`: `localOrHome`, see Task 8).
- No new dependencies. Modules under `node --test` never import `electron`: inject it.
- AGENTS.md: comments only for what code cannot say (OS/Electron facts, public contracts, security invariants). No narration.
- Never push. One commit per task.

## Review Focus

- A tap let go before any word is heard (the recognizer then reports `recognition-error` with nothing heard): the box closes silently, never an error. Pinned in Task 7.
- A second ask while MausBot is still answering the first in the same chat: each box shows its own answer; the first turn's deltas and `turn.completed` never end the second box. Pinned in Task 5.
- The Quick asks chat was deleted, or two presses race on first use: exactly one new chat, and the chat open in the MausBot window never switches. Pinned in Tasks 1 and 5.
- The page reloads or its renderer crashes during a call: afterwards the shortcut works again instead of saying "Voice is in use" forever. Pinned in Tasks 4 and 9.
- A reply with markup or Markdown (`<img src=x onerror=…>`, `**bold**`, links): shown as plain text, never parsed as HTML. Pinned in Task 6.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `server/routes/tasks.ts` (modify) | `POST /api/bots/:id/tasks` accepts `select: false` |
| `electron/resources/speech-helper.swift` (modify) | `--finish-on-release <mods>`, `--release-check <mods> <flags>` |
| `electron/speech.mjs` (modify) | sinks, owner-scoped stop/finish, `speechBusy()`, `finishOnRelease` option |
| `electron/talk-keys.mjs` (new) | the three presets |
| `electron/desktop-prefs.mjs`, `.d.mts` (modify) | talk prefs, Quick asks chat per server, injectable store |
| `electron/talk-shortcut.mjs`, `.d.mts` (new) | register/unregister with prefs; call presence |
| `electron/talk-server.mjs`, `.d.mts` (new) | find MausBot, Quick asks chat, SSE reading, reply tracking, ask |
| `electron/talk-panel.mjs`, `electron/talk-panel-preload.cjs` (new) | the box window, its `data:` page, `isTalkPanel` |
| `electron/talk-session.mjs` (new) | the ask state machine |
| `electron/main.mjs`, `electron/preload.cjs`, `src/types/ogb.d.ts` (modify) | wiring, `appWindows()`, IPC, bridge |
| `src/lib/call-presence.ts`, `src/components/LiveCallHost.tsx` | tell main when a call runs |
| `src/components/TalkShortcutRow.tsx`, `SettingsModal.tsx`, `src/locales/en.json` | Settings → General row |
| `docs/verification/talk-shortcut.md`, `docs/verification/README.md` | verification recipe |

---

### Task 1: Create a chat without selecting it

`POST /api/bots/:id/tasks` always passes `activate = true` (`server/routes/tasks.ts:194` → `server/store.ts:2205`), so creating Quick asks would switch the chat the MausBot window shows.

**Files:**
- Modify: `server/routes/tasks.ts:162-198`
- Test: `server/task-select.test.ts` (new)

**Interfaces:**
- Produces: `POST /api/bots/:id/tasks` body `{ title?: string, select?: boolean, … }`; `select: false` creates without selecting; non-boolean `select` → 400 `{ error: "select must be a boolean" }`. Response unchanged: 201 `{ bot, task }`.

- [ ] **Step 1: Write the failing test** (`launchVerificationServer` from `scripts/control-omb.ts`, same `api()` helper as `server/bot-projects-api.test.ts:12-21`, `beforeAll` 90 s timeout)

```ts
it("creates a chat without switching the bot's open chat when select is false", async () => {
  const bot = (await api("POST", "/api/bots", { name: "Select fixture" })).body.bot;
  const created = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Quick asks", select: false });
  expect(created.status).toBe(201);
  expect(created.body.task.title).toBe("Quick asks");
  const after = (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id);
  expect(after.threadId).toBe(bot.threadId);
  expect(after.tasks.map((t: any) => t.threadId)).toContain(created.body.task.threadId);
});
it("still selects a new chat by default", async () => {
  const bot = (await api("POST", "/api/bots", { name: "Default select" })).body.bot;
  const created = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Picked" });
  expect((await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id).threadId).toBe(created.body.task.threadId);
});
it("refuses a select that is not a boolean", async () => {
  const bot = (await api("POST", "/api/bots", { name: "Bad select" })).body.bot;
  expect(await api("POST", `/api/bots/${bot.id}/tasks`, { select: "no" })).toEqual({ status: 400, body: { error: "select must be a boolean" } });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm exec vitest run server/task-select.test.ts`
Expected: FAIL on the first test (`after.threadId` equals the new chat) and the third (201 instead of 400).

- [ ] **Step 3: Implement** — validate `body.select` right after the body-object check; pass `body.select !== false` as `createTask`'s third argument at line 194.

- [ ] **Step 4: Run it to see it pass**

Run: `pnpm exec vitest run server/task-select.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/routes/tasks.ts server/task-select.test.ts
git commit -m "feat(server): create a chat without selecting it"
```

---

### Task 2: The speech helper finishes when the keys are let go

**Files:**
- Modify: `electron/resources/speech-helper.swift` (header comment 1-13, imports 14-16, after `finishFile` 48-52, finish timer 72-82)
- Test: `electron/speech-helper-release.node-test.mjs` (new)

**Interfaces:**
- Produces (CLI): `--finish-on-release <mods>` where `<mods>` is a comma list of `control`, `option`, `shift`, `command`; an invalid list fails at start with `{"error":"bad-modifiers"}`. `--release-check <mods> <rawFlags>` prints `{"released":true|false}` and exits 0 before anything touches Speech or the microphone; bad mods → `{"error":"bad-modifiers"}`, exit 1.

- [ ] **Step 1: Write the failing test** (skipped unless macOS with `xcrun --find swiftc`; compiles single-arch `-Onone` into a temp dir and runs the loose binary, which is fine because `--release-check` exits before any TCC-protected call)

```js
const CONTROL = 0x40000, OPTION = 0x80000, SHIFT = 0x20000, COMMAND = 0x100000;
test("the helper finishes when any of the chosen modifiers is let go", { skip: !swiftc && "needs macOS with swiftc" }, () => {
  // build bin from new URL("./resources/speech-helper.swift", import.meta.url) with xcrun swiftc -Onone, timeout 180_000
  const check = (mods, flags) => JSON.parse(execFileSync(bin, ["--release-check", mods, String(flags)], { encoding: "utf8", timeout: 10_000 }));
  assert.deepEqual(check("control,option", CONTROL | OPTION), { released: false });
  assert.deepEqual(check("control,option", CONTROL | OPTION | SHIFT), { released: false });
  assert.deepEqual(check("control,option", CONTROL), { released: true });
  assert.deepEqual(check("control,option", 0), { released: true });
  assert.deepEqual(check("option,shift", OPTION | SHIFT), { released: false });
  assert.deepEqual(check("option,shift", SHIFT | COMMAND), { released: true });
  const bad = spawnSync(bin, ["--release-check", "control,hyper", "0"], { encoding: "utf8", timeout: 10_000 });
  assert.equal(bad.status, 1);
  assert.deepEqual(JSON.parse(bad.stdout), { error: "bad-modifiers" });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test electron/speech-helper-release.node-test.mjs`
Expected: FAIL (`--release-check` unknown: the helper goes on to ask for speech authorization and is killed or times out after 10 s).

- [ ] **Step 3: Implement in `speech-helper.swift`**
  - `import CoreGraphics`.
  - `func releaseModifiers(_ list: String) -> CGEventFlags?` — map names to `.maskControl`, `.maskAlternate`, `.maskShift`, `.maskCommand`; nil for an empty list or any unknown name.
  - `func released(_ required: CGEventFlags, _ current: CGEventFlags) -> Bool` — `!current.contains(required)`.
  - `--release-check` handled right after these, before the stop/finish timers and `requestAuthorization`.
  - `let finishOnRelease: CGEventFlags?` from `--finish-on-release` (absent → nil; invalid → `fail("bad-modifiers")`).
  - The finish timer's guard becomes: finish file exists **or** `finishOnRelease.map { released($0, CGEventSource.flagsState(.combinedSessionState)) } == true`, still requiring `finishHandler`, so a release before the audio engine exists finishes on a later tick.
  - One header line documenting `--finish-on-release`.

- [ ] **Step 4: Run it to see it pass**

Run: `node --test electron/speech-helper-release.node-test.mjs && node electron/build-speech-helper.mjs`
Expected: PASS, and the universal build still links.

- [ ] **Step 5: Commit**

```bash
git add electron/resources/speech-helper.swift electron/speech-helper-release.node-test.mjs
git commit -m "feat(speech): finish recognition when the talk keys are let go"
```

---

### Task 3: Speech sessions main can own

`speech.mjs` imports `app` from `electron` (line 15), so its tests live in the existing vitest file `electron/speech.test.mjs` (which mocks `electron` and `node:child_process`), not a node-test.

**Files:**
- Modify: `electron/speech.mjs` (whole file: `child`, `sendEnd`, `startSpeech` 49-169, `stopSpeech` 171-178, `finishSpeech` 180-185)
- Test: `electron/speech.test.mjs` (fixture records `args`; new tests in the darwin-only `describe`)

**Interfaces:**
- Produces:
  - `startSpeech(target, options = {})` — `target` is a `BrowserWindow` (has `webContents`: unchanged behaviour) or a `SpeechSink` `{ transcript(line), end(info), replaced() }`. `options`: `{ endpointMs?: number, finishOnRelease?: string[] }`; known names only, deduplicated, joined with `,`; none left → flag omitted.
  - A session replaced by another `startSpeech` calls the old target's `replaced()` (a window's is a no-op) and never its `end`.
  - `stopSpeech(owner?)`, `finishSpeech(owner?)` — `owner` omitted (`undefined`): the current session, as today; otherwise only when the current session was started by that same window or sink (`null` matches nothing).
  - `speechBusy(): boolean` — a session is running.

- [ ] **Step 1: Write the failing tests**

```js
const sinkOf = () => {
  const heard = { lines: [], ends: [], replaced: 0 };
  return { heard, sink: { transcript: line => heard.lines.push(line), end: info => heard.ends.push(info), replaced: () => { heard.replaced += 1; } } };
};
const flag = (session, name) => session.args.includes(name) ? session.args[session.args.indexOf(name) + 1] : undefined;

it("delivers a sink's session to the sink and tells the helper which keys end it", () => {
  const { heard, sink } = sinkOf();
  startSpeech(sink, { finishOnRelease: ["control", "option"] });
  const session = fixture.launches.at(-1);
  expect(flag(session, "--finish-on-release")).toBe("control,option");
  expect(speechBusy()).toBe(true);
  emit(session, { text: "what's on today", partial: false });
  session.proc.emit("close", 0);
  expect(heard.lines).toEqual([{ text: "what's on today", partial: false }]);
  expect(heard.ends).toEqual([{ code: 0, reason: "completed" }]);
  expect(speechBusy()).toBe(false);
});
it("tells a replaced sink, and never ends it", () => {
  const { heard, sink } = sinkOf();
  startSpeech(sink);
  const first = fixture.launches.at(-1);
  launch();
  expect(heard.replaced).toBe(1);
  first.proc.emit("close", 0);
  expect(heard.ends).toEqual([]);
});
it("a page's stop or finish never touches a session it did not start", () => {
  const { sink } = sinkOf();
  startSpeech(sink);
  const session = fixture.launches.at(-1);
  const page = { isDestroyed: () => false, webContents: { send: () => {} } };
  stopSpeech(page); finishSpeech(page); stopSpeech(null);
  expect(existsSync(session.stop)).toBe(false);
  expect(existsSync(session.finish)).toBe(false);
  finishSpeech(sink); expect(existsSync(session.finish)).toBe(true);
  stopSpeech(sink); expect(existsSync(session.stop)).toBe(true);
  expect(speechBusy()).toBe(false);
});
it("passes only known release modifiers", () => {
  startSpeech(sinkOf().sink, { finishOnRelease: ["control", "hyper", "control"] });
  expect(flag(fixture.launches.at(-1), "--finish-on-release")).toBe("control");
  startSpeech(sinkOf().sink, { finishOnRelease: ["hyper"] });
  expect(fixture.launches.at(-1).args).not.toContain("--finish-on-release");
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm exec vitest run electron/speech.test.mjs`
Expected: the four new tests FAIL (`speechBusy` is not exported); the four existing ones PASS.

- [ ] **Step 3: Implement** — normalise the target once into `{ owner, transcript, end, replaced }` (a window's `transcript`/`end` send `speech:transcript`/`speech:end` when not destroyed; `replaced` is a no-op); keep it on the session record; every existing `child === speechSession` guard stays. In `startSpeech`, capture the running session before `stopSpeech()` and call its `replaced()` after.

- [ ] **Step 4: Run to see them pass**

Run: `pnpm exec vitest run electron/speech.test.mjs`
Expected: PASS (8 tests on macOS; skipped elsewhere, as today).

- [ ] **Step 5: Commit**

```bash
git add electron/speech.mjs electron/speech.test.mjs
git commit -m "feat(speech): sessions owned by a sink, scoped stop and speechBusy"
```

---

### Task 4: The setting, its keys, and registration

**Files:**
- Create: `electron/talk-keys.mjs`, `electron/talk-shortcut.mjs`, `electron/talk-shortcut.d.mts`
- Modify: `electron/desktop-prefs.mjs` (`parse` 37-49, `createDesktopPrefs` 52-102, `registerDesktopPrefs` 113-116), `electron/desktop-prefs.d.mts` (`DesktopPrefs`, `registerDesktopPrefs` options)
- Test: `electron/desktop-prefs.node-test.mjs` (add), `electron/talk-shortcut.node-test.mjs` (new)

**Interfaces:**
- Produces (`talk-keys.mjs`): `TALK_KEYS` (frozen `{ [id]: { accelerator, release, label } }`, values in Global Constraints, in that order), `DEFAULT_TALK_KEY = "ctrl-opt-space"`, `isTalkKey(id: unknown): boolean` (own keys only), `talkKey(id): { accelerator, release, label }` (default for anything else).
- Produces (`DesktopPrefs`): `talkShortcut(): boolean` (true until set), `setTalkShortcut(enabled: boolean): void` (only `true` is on), `talkKey(): TalkKeyId`, `setTalkKey(id: unknown): boolean`, `quickAsksChat(server: string): { botId, threadId } | null`, `setQuickAsksChat(server: string, chat: { botId, threadId }): void`. Stored as `quickAsks: { [server]: { botId, threadId } }`; ids match `/^[\w-]{1,128}$/`, anything else is dropped on read. `registerDesktopPrefs({ prefs?: DesktopPrefs, … })` uses the given store instead of making one.
- Produces (`talk-shortcut.mjs`):
  - `createTalkShortcut({ globalShortcut, prefs, available: () => boolean, onPress: () => void })` → `{ state(): TalkShortcutState, set(change: { enabled?, key? }): TalkShortcutState, releaseModifiers(): string[], close(): void }`. `TalkShortcutState = { available, enabled, key, keys: [{ id, label }], taken }`; `taken`: on, but `register` returned false.
  - `createCallPresence()` → `{ set(sender, active: boolean): void, active(): boolean }`; a sender stops counting on its `destroyed`, `render-process-gone` or `did-navigate`, with at most one listener per event per sender.
- Produces (`talk-shortcut.d.mts`): `TalkKeyId`, `TalkShortcutState`, `TalkShortcutChange`, `TalkShortcutBridge { state(): Promise<TalkShortcutState>; set(change: TalkShortcutChange): Promise<TalkShortcutState> }`, and declarations for both factories.

- [ ] **Step 1: Write the failing prefs tests** (`desktop-prefs.node-test.mjs`)

```js
test("the talk shortcut is on with ⌃⌥Space until changed, and the choice survives a restart", () => {
  let saved = null;
  const prefs = createDesktopPrefs({ read: () => saved, write: value => { saved = structuredClone(value); } });
  assert.equal(prefs.talkShortcut(), true);
  assert.equal(prefs.talkKey(), "ctrl-opt-space");
  prefs.setTalkShortcut(false);
  assert.equal(prefs.setTalkKey("opt-shift-space"), true);
  for (const key of ["cmd-space", "__proto__", "toString", 7]) assert.equal(prefs.setTalkKey(key), false);
  const restarted = createDesktopPrefs({ read: () => saved, write: () => {} });
  assert.equal(restarted.talkShortcut(), false);
  assert.equal(restarted.talkKey(), "opt-shift-space");
  const junk = createDesktopPrefs({ read: () => ({ talkShortcut: "off", talkKey: "toString" }), write: () => {} });
  assert.equal(junk.talkShortcut(), true);
  assert.equal(junk.talkKey(), "ctrl-opt-space");
});
test("each server keeps its own Quick asks chat; nothing malformed is read back", () => {
  let saved = null;
  const prefs = createDesktopPrefs({ read: () => saved, write: value => { saved = structuredClone(value); } });
  prefs.setQuickAsksChat("/Users/a/.openmausbot", { botId: "bot-1", threadId: "t-1" });
  assert.deepEqual(createDesktopPrefs({ read: () => saved, write: () => {} }).quickAsksChat("/Users/a/.openmausbot"), { botId: "bot-1", threadId: "t-1" });
  assert.equal(prefs.quickAsksChat("/Users/a/.openmausbot-aprs"), null);
  const broken = createDesktopPrefs({ read: () => ({ quickAsks: { a: { botId: "../x", threadId: "t" }, b: "t-1", c: { botId: "b", threadId: "t", extra: 1 } } }), write: () => {} });
  assert.equal(broken.quickAsksChat("a"), null);
  assert.equal(broken.quickAsksChat("b"), null);
  assert.deepEqual(broken.quickAsksChat("c"), { botId: "b", threadId: "t" });
});
test("registerDesktopPrefs works on the store main hands it", async () => {
  const prefs = createDesktopPrefs({ read: () => null, write: () => {} });
  const handlers = new Map();
  registerDesktopPrefs({ prefs, ipcMain: { handle: (c, h) => handlers.set(c, h), on: () => {} }, read: () => null, write: () => {},
    page: () => "local", cloudOffered: async () => false });
  await handlers.get("desktop-analytics:set")({}, false);
  assert.equal(prefs.analytics(), false);
});
```

- [ ] **Step 2: Write the failing shortcut tests** (`talk-shortcut.node-test.mjs`; `memoryPrefs()` is a real `createDesktopPrefs` over an in-memory record: `let saved = null; createDesktopPrefs({ read: () => saved, write: v => { saved = structuredClone(v); } })`)

```js
const fakeShortcuts = (taken = []) => {
  const registered = new Map();
  return { registered, register: (accelerator, fn) => !taken.includes(accelerator) && Boolean(registered.set(accelerator, fn)),
    unregister: accelerator => { registered.delete(accelerator); } };
};
const KEYS = [{ id: "ctrl-opt-space", label: "⌃⌥Space" }, { id: "ctrl-shift-space", label: "⌃⇧Space" }, { id: "opt-shift-space", label: "⌥⇧Space" }];

test("registers the saved key when on; a press reaches onPress", () => {
  const shortcuts = fakeShortcuts(); let presses = 0;
  const talk = createTalkShortcut({ globalShortcut: shortcuts, prefs: memoryPrefs(), available: () => true, onPress: () => { presses += 1; } });
  assert.deepEqual([...shortcuts.registered.keys()], ["Control+Alt+Space"]);
  shortcuts.registered.get("Control+Alt+Space")();
  assert.equal(presses, 1);
  assert.deepEqual(talk.state(), { available: true, enabled: true, key: "ctrl-opt-space", keys: KEYS, taken: false });
  assert.deepEqual(talk.releaseModifiers(), ["control", "option"]);
});
test("a key another app holds is reported, and another key can be chosen", () => {
  const shortcuts = fakeShortcuts(["Control+Alt+Space"]); const prefs = memoryPrefs();
  const talk = createTalkShortcut({ globalShortcut: shortcuts, prefs, available: () => true, onPress: () => {} });
  assert.equal(talk.state().taken, true);
  assert.deepEqual(talk.set({ key: "ctrl-shift-space" }), { available: true, enabled: true, key: "ctrl-shift-space", keys: KEYS, taken: false });
  assert.deepEqual([...shortcuts.registered.keys()], ["Control+Shift+Space"]);
  assert.deepEqual(talk.releaseModifiers(), ["control", "shift"]);
  assert.equal(prefs.talkKey(), "ctrl-shift-space");
});
test("off lets the key go, on takes it again, close lets it go");      // set({enabled:false}) → registered empty, prefs.talkShortcut() false; set({enabled:true}) → ["Control+Alt+Space"]; close() → empty
test("an unknown key changes nothing");                                 // set({ key: "cmd-space" }) → registered still ["Control+Alt+Space"], prefs.talkKey() "ctrl-opt-space"
test("where Apple speech is unavailable nothing registers and nothing changes"); // available: () => false → registered empty; set({enabled:false}) → prefs.talkShortcut() true; state().available false
test("a reported call blocks until it ends, its page navigates, or its renderer goes away", () => {
  const presence = createCallPresence(), page = Object.assign(new EventEmitter(), { id: 1 });
  presence.set(page, true); assert.equal(presence.active(), true);
  presence.set(page, false); assert.equal(presence.active(), false);
  for (const event of ["did-navigate", "render-process-gone", "destroyed"]) {
    presence.set(page, true); page.emit(event); assert.equal(presence.active(), false, event);
  }
  for (let i = 0; i < 5; i += 1) presence.set(page, true);
  assert.ok(page.listenerCount("destroyed") <= 1);
});
```

- [ ] **Step 3: Run to see them fail**

Run: `node --test electron/desktop-prefs.node-test.mjs electron/talk-shortcut.node-test.mjs`
Expected: FAIL (`prefs.talkShortcut is not a function`; `talk-shortcut.mjs` missing).

- [ ] **Step 4: Implement** the three modules and the `.d.mts` changes. `set()` saves to prefs first, then unregisters the registered accelerator (if any) and registers the current one when enabled and available; `taken` is recomputed on each registration. `talk-shortcut.d.mts` comments: `available` (false hides the setting), `taken` (on, but another app holds the key).

- [ ] **Step 5: Run to see them pass**

Run: `node --test electron/desktop-prefs.node-test.mjs electron/talk-shortcut.node-test.mjs`
Expected: PASS (existing prefs tests unchanged; the file written by `setAnalytics(false)` is still exactly `{ seen: [], shown: {}, analytics: false }`).

- [ ] **Step 6: Commit**

```bash
git add electron/talk-keys.mjs electron/talk-shortcut.mjs electron/talk-shortcut.d.mts electron/talk-shortcut.node-test.mjs electron/desktop-prefs.mjs electron/desktop-prefs.d.mts electron/desktop-prefs.node-test.mjs
git commit -m "feat(talk): the talk shortcut setting, its keys and registration"
```

---

### Task 5: Talk to this computer's server

**Files:**
- Create: `electron/talk-server.mjs`, `electron/talk-server.d.mts`
- Test: `electron/talk-server.node-test.mjs` (new, fake `request`), `server/talk-server.e2e.test.ts` (new, real fixture as the packaged desktop calls it)

**Interfaces:**
- Consumes: `select: false` (Task 1); prefs `quickAsksChat`/`setQuickAsksChat` (Task 4).
- Produces:
  - `QUICK_ASKS_TITLE = "Quick asks"`; `class TalkServerError extends Error` with `code: "server-down" | "no-mausbot" | "refused" | "lost"`.
  - `findMausBot(bots)` → the bot with `defaultBot` and an empty `defaultBot.person`, else the first `chiefOfStaff` bot that is not `hidden`, else `null`.
  - `readFrames(body: ReadableStream<Uint8Array>, onFrame: (frame: object) => void): Promise<void>` — SSE: frames end at a blank line, `data:` lines joined, `:` comments and unparsable JSON skipped.
  - `createReplyTracker({ threadId, sendId })` → `(frame) => TalkUpdate | null`, `TalkUpdate = { kind: "thinking" } | { kind: "reply", text } | { kind: "needs-you" } | { kind: "done", ok, text }`.
  - `createTalkServer({ request: (route, init?) => Promise<Response>, prefs, serverKey: () => string })` → `{ prepare(): Promise<TalkChat>, ask({ chat, text, sendId, signal, onUpdate }): Promise<"done" | "needs-you" | "failed"> }`, `TalkChat = { botId, threadId }`.

Tracker rules (the algorithm the tests do not fully determine): frames for other threads, and every frame before `{ kind: "message", message: { role: "user", sendId } }` with this ask's `sendId`, return null; that frame returns `thinking`. After it: `runtime` `content.delta` (`streamKind: "assistant_text"`) appends to a buffer that restarts when `itemId` changes → `reply` with the buffer; `runtime` `item.completed` (`itemType: "assistant_text"`) and a `message` with `role: "bot", kind: "text"` replace the shown text → `reply`; a `message` with `role: "bot", kind: "options"` whose `card` is not `answered`, `dismissed` or `expired`, or a `runtime` `request.opened` → `needs-you`; `runtime` `turn.completed` → `done` with its `ok` and the last shown text.

`prepare()`: `GET /api/bots?messages=0` (a rejected request or non-2xx → `server-down`; no MausBot → `no-mausbot`); reuse `prefs.quickAsksChat(serverKey())` when its `botId` is MausBot's and MausBot's `tasks` still list its `threadId`; else `POST /api/bots/:id/tasks` with exactly `{ title: QUICK_ASKS_TITLE, select: false }`, save and return it. One prepare in flight at a time: a second call while one runs gets the same promise.

`ask()`: `GET /api/events?screens=off` first; wait for its `{ kind: "hello" }` frame; then `POST /api/bots/:botId/messages` with exactly `{ text, threadId, sendId }` (non-2xx → `refused`). Resolve on `done` (`"failed"` when `ok` is false and the text is empty) or `needs-you`; the stream ending first → `lost`; `signal` aborting → reject with `signal.reason` and cancel the stream. `content-type: application/json` on both POSTs.

- [ ] **Step 1: Write the failing unit tests** (frame builders: `userMessage(threadId, sendId)`, `delta(threadId, itemId, text)`, `botText(threadId, text)`, `card(threadId, cardFields)` (a `role: "bot", kind: "options"` message), `opened(threadId)`, `completed(threadId, ok)`. `fakeServer({ bots, saved = null, sendStatus = 202 })` returns `{ talk, calls, saves, events }`: `talk = createTalkServer({ request, serverKey: () => "server-a", prefs: { quickAsksChat: () => saved, setQuickAsksChat: (server, chat) => saves.push([server, chat]) } })`; `request` answers `GET /api/bots?messages=0` with `{ bots }`, `POST …/tasks` with 201 `{ task: { threadId: "t-new", title: "Quick asks" } }`, `GET /api/events?screens=off` with a `ReadableStream` the test drives through `events.push(frame)` / `events.end()`, `POST …/messages` with `sendStatus`; `calls` records `[method, route, parsedBody]`. `flush = () => new Promise(r => setImmediate(r))`)

```js
test("findMausBot picks this computer's MausBot, else the Chief of Staff", () => {
  const mine = { id: "m", defaultBot: {} }, member = { id: "p", defaultBot: { person: "a@b.test" } }, chief = { id: "c", chiefOfStaff: true };
  assert.equal(findMausBot([member, chief, mine]).id, "m");
  assert.equal(findMausBot([member, chief]).id, "c");
  assert.equal(findMausBot([{ id: "x" }, { ...chief, hidden: true }]), null);
});
test("prepare reuses the saved Quick asks chat while MausBot still has it");   // saved {botId:"m",threadId:"t1"}, tasks [{threadId:"t1"}] → returns saved; no POST in calls
test("prepare makes a Quick asks chat without selecting it when the saved one is gone, and keeps it", async () => {
  const server = fakeServer({ bots: [{ id: "m", defaultBot: {}, tasks: [] }], saved: { botId: "m", threadId: "t-gone" } });
  assert.deepEqual(await server.talk.prepare(), { botId: "m", threadId: "t-new" });
  assert.deepEqual(server.calls.at(-1), ["POST", "/api/bots/m/tasks", { title: "Quick asks", select: false }]);
  assert.deepEqual(server.saves, [["server-a", { botId: "m", threadId: "t-new" }]]);
});
test("two prepares at once make one chat");                                   // Promise.all([prepare(), prepare()]) → one POST
test("prepare says why it cannot ask");                                       // request rejects → code "server-down"; 503 → "server-down"; bots [] → "no-mausbot"
test("the reply tracker follows only this ask", () => {
  const track = createReplyTracker({ threadId: "t1", sendId: "s1" });
  for (const early of [delta("t1", "i0", "old answer"), completed("t1", true), userMessage("t1", "s0"), userMessage("t2", "s1")]) assert.equal(track(early), null);
  assert.deepEqual(track(userMessage("t1", "s1")), { kind: "thinking" });
  assert.deepEqual(track(delta("t1", "i1", "Let me ")), { kind: "reply", text: "Let me " });
  assert.deepEqual(track(delta("t1", "i1", "check")), { kind: "reply", text: "Let me check" });
  assert.deepEqual(track(delta("t1", "i2", "You have")), { kind: "reply", text: "You have" });
  assert.deepEqual(track(botText("t1", "You have two meetings.")), { kind: "reply", text: "You have two meetings." });
  assert.equal(track(delta("t2", "i9", "elsewhere")), null);
  assert.deepEqual(track(completed("t1", true)), { kind: "done", ok: true, text: "You have two meetings." });
});
test("a waiting card or an opened request means MausBot needs the person", () => {
  const track = createReplyTracker({ threadId: "t1", sendId: "s1" });
  track(userMessage("t1", "s1"));
  assert.equal(track(card("t1", { answered: "Allow" })), null);
  assert.deepEqual(track(card("t1", {})), { kind: "needs-you" });
  assert.deepEqual(track(opened("t1")), { kind: "needs-you" });
});
test("ask listens before it sends, posts to the Quick asks chat, and ends with the turn", async () => {
  const server = fakeServer({ bots: [] });
  const updates = [];
  const asking = server.talk.ask({ chat: { botId: "m", threadId: "t1" }, text: "hi", sendId: "s1", signal: new AbortController().signal, onUpdate: u => updates.push(u) });
  await flush();
  assert.deepEqual(server.calls.map(c => c[1]), ["/api/events?screens=off"]);
  server.events.push({ kind: "hello", cursor: "s:1", resumed: false });
  await flush();
  assert.deepEqual(server.calls[1], ["POST", "/api/bots/m/messages", { text: "hi", threadId: "t1", sendId: "s1" }]);
  for (const frame of [userMessage("t1", "s1"), botText("t1", "Hello"), completed("t1", true)]) server.events.push(frame);
  assert.equal(await asking, "done");
  assert.deepEqual(updates.map(u => u.kind), ["thinking", "reply", "done"]);
});
test("a refused send, a lost stream, a failed turn and an abort");           // sendStatus 409 → rejects code "refused"; events.end() after thinking → "lost"; completed ok:false with nothing shown → resolves "failed"; card → resolves "needs-you"; controller.abort() → rejects { name: "AbortError" }
test("readFrames joins frames split across chunks and skips heartbeats and junk", async () => {
  const chunks = [": heartbeat\n\n", "id: s:1\ndata: {\"kind\":\"he", "llo\"}\n\ndata: not json\n\n", "data: {\"kind\":\"x\"}\n\n"];
  const frames = [];
  await readFrames(ReadableStream.from(chunks.map(c => new TextEncoder().encode(c))), f => frames.push(f));
  assert.deepEqual(frames, [{ kind: "hello" }, { kind: "x" }]);
});
```

- [ ] **Step 2: Write the failing fixture test** (`server/talk-server.e2e.test.ts`; launch with `OMB_TEST_DESKTOP_OWNER_TOKEN: owner` and send `x-openmausbot-desktop-owner` on every request, as `server/chat-pages.e2e.test.ts:54-56` does, so it runs the packaged desktop's path)

```ts
it("asks MausBot in its own Quick asks chat, as the desktop app does, and follows the reply to the end", async () => {
  let saved: TalkChat | null = null;
  const talk = createTalkServer({ request, serverKey: () => "fixture", prefs: { quickAsksChat: () => saved, setQuickAsksChat: (_s, chat) => { saved = chat; } } });
  const before = (await (await request("/api/bots?messages=0")).json()).bots.find((b: any) => b.defaultBot);
  const chat = await talk.prepare();
  expect(chat.botId).toBe(before.id);
  const updates: TalkUpdate[] = [];
  expect(await talk.ask({ chat, text: "What can you do?", sendId: randomUUID(), signal: AbortSignal.timeout(60_000), onUpdate: u => updates.push(u) })).toBe("done");
  expect(updates[0]).toEqual({ kind: "thinking" });
  expect(updates.at(-1)).toMatchObject({ kind: "done", ok: true, text: expect.stringContaining("hello from fake claude") });
  const after = (await (await request("/api/bots?messages=0")).json()).bots.find((b: any) => b.id === chat.botId);
  expect(after.threadId).toBe(before.threadId);
  expect(after.tasks.find((t: any) => t.threadId === chat.threadId).title).toBe(QUICK_ASKS_TITLE);
  expect(await talk.prepare()).toEqual(chat);
}, 90_000);
```

- [ ] **Step 3: Run to see them fail**

Run: `node --test electron/talk-server.node-test.mjs && pnpm exec vitest run server/talk-server.e2e.test.ts`
Expected: FAIL (`talk-server.mjs` missing).

- [ ] **Step 4: Implement** `talk-server.mjs` and its `.d.mts`.

- [ ] **Step 5: Run to see them pass**

Run: `node --test electron/talk-server.node-test.mjs && pnpm exec vitest run server/talk-server.e2e.test.ts && pnpm typecheck`
Expected: PASS. If the fixture shows a wire shape the unit fakes assumed wrongly (the hello frame, `sendId` on the echoed user message, delta `itemId`), fix the fakes and the module, not the fixture test.

- [ ] **Step 6: Commit**

```bash
git add electron/talk-server.mjs electron/talk-server.d.mts electron/talk-server.node-test.mjs server/talk-server.e2e.test.ts
git commit -m "feat(talk): find MausBot, keep the Quick asks chat and follow the reply"
```

---

### Task 6: The box

**Files:**
- Create: `electron/talk-panel.mjs`, `electron/talk-panel-preload.cjs`
- Test: `electron/talk-panel.node-test.mjs` (new; `harness({ cursor, workArea })` builds a fake `BrowserWindow` class (each instance in `made`) recording `options`, `url`, `bounds` and `calls` (`setAlwaysOnTop`, `setVisibleOnAllWorkspaces`, `show`, `focus`, `showInactive`), whose `webContents` is an `EventEmitter` with `scripts`, `executeJavaScript` resolving `96`, and `setWindowOpenHandler`; a fake `screen` answering `cursor` and `workArea`; `opened`/`dismissed` arrays from `onOpen`/`onDismiss`. `pick(object, keys)` copies the named keys; `flush = () => new Promise(r => setImmediate(r))`)

**Interfaces:**
- Produces:
  - `TALK_PANEL = { width: 400, margin: 24, minHeight: 56, maxHeight: 240, fadeMs: 180 }` (frozen).
  - `TALK_LABELS` (frozen): `listening: "Listening…"`, `sending: "Sending to MausBot…"`, `thinking: "MausBot is thinking…"`, `reply: "MausBot"`, `"needs-you": "MausBot needs you · Open chat"`, `"still-working": "Still working · Open chat"`, `error: ""`.
  - `TalkView = { state: "listening" | "sending" | "thinking" | "reply" | "needs-you" | "still-working" | "error", text: string }`.
  - `talkPanelBounds(workArea, height)` → `{ x, y, width, height }`: centred, `margin` above the work area's bottom, height clamped to `[minHeight, maxHeight]`.
  - `replyPreview(text, limit = 400): string` — drop Markdown heading marks, list markers, `**`/`__`/`*`/`_` emphasis, backticks and fences; `[label](url)` → `label`; collapse whitespace; over `limit`, cut at the last space before it and add `…`.
  - `talkPanelHtml(iconBase64): string` — the page.
  - `isTalkPanel(win): boolean`.
  - `createTalkPanel({ BrowserWindow, screen, iconPath, onOpen, onDismiss })` → `{ render(view: TalkView): void, close(): void, hovered(): boolean }`.

Window (first `render` after creation or after `close`): `new BrowserWindow({ type: "panel", ...talkPanelBounds(workArea of screen.getDisplayNearestPoint(screen.getCursorScreenPoint()), TALK_PANEL.minHeight), frame: false, transparent: true, backgroundColor: "#00000000", focusable: false, skipTaskbar: true, hasShadow: false, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false, show: false, acceptFirstMouse: true, hiddenInMissionControl: true, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, preload } })`; then `excludedFromShownWindowsMenu = true`, `setAlwaysOnTop(true, "screen-saver")`, `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })`, deny `setWindowOpenHandler`, `preventDefault` on `will-navigate`, load `data:text/html;charset=utf-8,` + the page. `acceptFirstMouse` is the Electron/macOS fact that lets a click on an inactive window reach the page: say so in a one-line comment. `skipTransformProcessType` keeps the Dock icon: same.

Rendering: `render(view)` keeps the latest view; once the page has loaded, run `render(<JSON of { state, text: replyPreview(view.text) }>)` in the page; its return value is the card's height in px; `setBounds(talkPanelBounds(workArea, height))`; the first sized render calls `showInactive()`. `close()` runs `fadeOut()` in a loaded page and destroys the window `fadeMs` later (at once if not loaded); the next `render` makes a new window. `hovered()`: `screen.getCursorScreenPoint()` inside the window's bounds; false with no window. `ipc-message` on this window's `webContents`: `talk-panel:open` → `onOpen()`, `talk-panel:dismiss` → `onDismiss()`, anything else ignored.

Page: CSP `default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'`; dark card from the default skin's tokens (`--color-panel #111111` at 96%, border `#ffffff16`, radius 16 px, ink `#fcfcfc`, secondary `#fcfcfcbf`, accent `#1084fe` pulse ring on the mascot while listening, warning `#ff9800` for needs-you, danger `#ff5667` for error), `-apple-system` 13 px, the app icon (`electron/resources/app-icon.png`, as the splash inlines it) at 28 px, label from `TALK_LABELS`, text in a `role="status"` line written with `textContent` only, "Let go to send" while listening with no words yet, a × button (`stopPropagation` → `talk.dismiss()`), the card's click → `talk.open()`, a 160 ms opacity fade, `prefers-reduced-motion` respected. Preload: `contextBridge.exposeInMainWorld("talk", { open, dismiss })` over `ipcRenderer.send("talk-panel:open" | "talk-panel:dismiss")`, nothing else.

- [ ] **Step 1: Write the failing tests**

```js
test("talkPanelBounds sits the box bottom-centre of the work area, clamped", () => {
  assert.deepEqual(talkPanelBounds({ x: 0, y: 25, width: 1440, height: 875 }, 72), { x: 520, y: 804, width: 400, height: 72 });
  assert.deepEqual(talkPanelBounds({ x: 1440, y: 0, width: 1920, height: 1050 }, 500), { x: 2200, y: 786, width: 400, height: 240 });
  assert.equal(talkPanelBounds({ x: 0, y: 0, width: 800, height: 600 }, 10).height, 56);
});
test("the box is a non-activating panel on every Space, shown without focus on the display under the pointer", async () => {
  const { panel, made } = harness({ cursor: { x: 2000, y: 500 }, workArea: { x: 1440, y: 25, width: 1440, height: 875 } });
  panel.render({ state: "listening", text: "" });
  const win = made[0];
  assert.deepEqual(pick(win.options, ["type", "focusable", "transparent", "frame", "skipTaskbar", "hasShadow", "resizable", "show", "acceptFirstMouse", "hiddenInMissionControl"]),
    { type: "panel", focusable: false, transparent: true, frame: false, skipTaskbar: true, hasShadow: false, resizable: false, show: false, acceptFirstMouse: true, hiddenInMissionControl: true });
  assert.deepEqual(win.calls.filter(c => c[0] !== "setBounds"), [["setAlwaysOnTop", true, "screen-saver"], ["setVisibleOnAllWorkspaces", true, { visibleOnFullScreen: true, skipTransformProcessType: true }]]);
  assert.ok(win.url.startsWith("data:text/html"));
  win.webContents.emit("did-finish-load");
  await flush();
  assert.match(win.webContents.scripts[0], /^render\(\{"state":"listening","text":""\}\)$/);
  assert.deepEqual(win.bounds, { x: 1960, y: 780, width: 400, height: 96 });
  assert.deepEqual(win.calls.map(c => c[0]).filter(n => ["show", "focus", "showInactive"].includes(n)), ["showInactive"]);
});
test("the page shows reply text as plain text, never HTML", () => {
  assert.equal(replyPreview("## Today\n\n- **Standup** at 10\n- [Lunch](https://x.test) with `Sam`"), "Today Standup at 10 Lunch with Sam");
  assert.equal(replyPreview("<img src=x onerror=alert(1)>"), "<img src=x onerror=alert(1)>");
  const cut = replyPreview("word ".repeat(120));
  assert.ok(cut.length <= 401 && cut.endsWith("…") && !cut.endsWith(" …") && !cut.includes("wor…"));
  const html = talkPanelHtml("AAAA");
  assert.match(html, /default-src 'none'/);
  assert.match(html, /textContent/);
  assert.doesNotMatch(html, /innerHTML|insertAdjacentHTML|outerHTML|https?:\/\//);
});
test("the page's bridge is open and dismiss, and they count only from this box", async () => {
  const preload = readFileSync(new URL("./talk-panel-preload.cjs", import.meta.url), "utf8");
  assert.deepEqual([...preload.matchAll(/ipcRenderer\.(\w+)\("([^"]+)"/g)].map(m => [m[1], m[2]]), [["send", "talk-panel:open"], ["send", "talk-panel:dismiss"]]);
  const { panel, made, opened, dismissed } = harness();
  panel.render({ state: "reply", text: "Hi" });
  made[0].webContents.emit("ipc-message", {}, "talk-panel:open");
  made[0].webContents.emit("ipc-message", {}, "talk-panel:other");
  made[0].webContents.emit("ipc-message", {}, "talk-panel:dismiss");
  assert.deepEqual([opened.length, dismissed.length], [1, 1]);
});
test("navigation and new windows are refused");          // will-navigate event.defaultPrevented true; openHandler() → { action: "deny" }
test("close fades, then destroys; the next render makes a new box; hovered follows the pointer"); // mock.timers: close() → scripts.at(-1) "fadeOut()"; tick(179) not destroyed; tick(1) destroyed; render → made.length 2; cursor inside bounds → hovered() true, outside → false
test("isTalkPanel tells the box from app windows");      // isTalkPanel(made[0]) true; isTalkPanel({}) false
```

- [ ] **Step 2: Run to see them fail**

Run: `node --test electron/talk-panel.node-test.mjs`
Expected: FAIL (`talk-panel.mjs` missing).

- [ ] **Step 3: Implement** `talk-panel.mjs` and `talk-panel-preload.cjs`.

- [ ] **Step 4: Run to see them pass**

Run: `node --test electron/talk-panel.node-test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/talk-panel.mjs electron/talk-panel-preload.cjs electron/talk-panel.node-test.mjs
git commit -m "feat(talk): the floating box that never takes focus"
```

---

### Task 7: One ask, from press to reply

**Files:**
- Create: `electron/talk-session.mjs`
- Test: `electron/talk-session.node-test.mjs` (new; `mock.timers.enable({ apis: ["setTimeout"] })` per test and `mock.timers.reset()` after, `flush = () => new Promise(r => setImmediate(r))`, `pick(object, keys)` copies the named keys)

**Interfaces:**
- Consumes: `speech` `{ start(sink, { finishOnRelease }), stop(sink) }` (Task 3 via main); `server` `{ prepare, ask }` and `TalkServerError` codes (Task 5); `panel` `{ render(view), close(), hovered() }` and `TalkView` (Task 6).
- Produces:
  - `TALK_TIMING = { replyHideMs: 12_000, noticeHideMs: 4_000, stillWorkingMs: 120_000, hoverRecheckMs: 500 }` (frozen).
  - `TALK_TEXT` (frozen): `busy: "Voice is in use in MausBot"`, `serverDown: "Open MausBot to talk"`, `permission: "Talking needs Microphone + Speech Recognition access — System Settings → Privacy & Security."`, `dictationOff: "Turn on Dictation in System Settings → Keyboard, then try again."`, `unavailable: "Talking couldn't start. Try again."`, `failed: "MausBot couldn't take that · Open chat"`.
  - `createTalkSession({ speech, server, panel, voiceInUse: () => boolean, release: () => string[], openChat: (chat: TalkChat | null) => void, newSendId = randomUUID })` → `{ press(), open(), dismiss(), close() }`.

| Phase | `press()` | `open()` | `dismiss()` / `close()` |
| --- | --- | --- | --- |
| idle | `voiceInUse()` → error `busy`, hide in `noticeHideMs`; else render `listening ""`, `speech.start(sink, { finishOnRelease: release() })`, start `server.prepare()` | — | — |
| listening | ignored | `speech.stop(sink)`, `openChat(null)`, close box | `speech.stop(sink)`, close box |
| sending, thinking | ignored | abort ask, `openChat(chat)`, close box | abort ask, close box |
| reply, needs-you, still-working, error | abort ask, close box, start a new ask as from idle | abort ask, `openChat(chat ?? null)`, close box | abort ask, close box |

Each press makes a new sink and `AbortController`; callbacks from an older one are ignored. Sink: `transcript(line)` → render `listening` with `line.text`; `replaced()` → close box; `end(info)`: reason `speech-not-authorized`, `mic-failed` or `recognizer-unavailable` → error `permission`; `dictation-disabled` → `dictationOff`; `helper-build-failed`, `helper-start-failed` or `unsupported-platform` → `unavailable` (these three hide in `noticeHideMs`); otherwise nothing heard → close box silently; otherwise render `sending` with the words and ask. `prepare()` failing (`server-down`, `no-mausbot`) while listening stops speech and shows `serverDown`; at send time it shows the same. The ask: `thinking` → render `thinking` with the words; `reply` → render `reply`; `done` → render `reply`, hide in `replyHideMs`; `needs-you` → render `needs-you` with the last reply text, hide in `replyHideMs`; `"failed"` or `refused` → error `failed`, hide in `replyHideMs`; `lost`, or `stillWorkingMs` after sending with no outcome → abort, render `still-working` with the last reply text, hide in `replyHideMs`. Hiding: when the timer fires and `panel.hovered()`, check again every `hoverRecheckMs`.

- [ ] **Step 1: Write the failing tests**

```js
const CHAT = { botId: "m", threadId: "t1" };
function harness({ busy = false, prepare = async () => CHAT, ask } = {}) {
  const h = { views: [], closed: 0, hovered: false, starts: [], stops: [], opened: [], asks: [], sink: null };
  h.session = createTalkSession({
    speech: { start: (sink, options) => { h.sink = sink; h.starts.push(options); }, stop: sink => h.stops.push(sink === h.sink) },
    server: { prepare, ask: ask ?? (async input => { h.asks.push(input); input.onUpdate({ kind: "thinking" }); input.onUpdate({ kind: "reply", text: "Hi" }); input.onUpdate({ kind: "done", ok: true, text: "Hi" }); return "done"; }) },
    panel: { render: view => h.views.push(view), close: () => { h.closed += 1; }, hovered: () => h.hovered },
    voiceInUse: () => busy, release: () => ["control", "option"], openChat: chat => h.opened.push(chat), newSendId: () => "send-1",
  });
  return h;
}
const say = (h, text) => h.sink.transcript({ text, partial: true });
const release = (h, info = { code: 0, reason: "completed" }) => h.sink.end(info);

test("a press listens with the key's release modifiers and shows the live words", () => {
  const h = harness(); h.session.press(); say(h, "what's on");
  assert.deepEqual(h.starts, [{ finishOnRelease: ["control", "option"] }]);
  assert.deepEqual(h.views, [{ state: "listening", text: "" }, { state: "listening", text: "what's on" }]);
});
test("letting go sends the words to the Quick asks chat and shows the reply, which hides 12 s later", async () => {
  const h = harness(); h.session.press(); say(h, "what's on my calendar"); release(h); await flush();
  assert.deepEqual(pick(h.asks[0], ["chat", "text", "sendId"]), { chat: CHAT, text: "what's on my calendar", sendId: "send-1" });
  assert.deepEqual([...new Set(h.views.map(v => v.state))], ["listening", "sending", "thinking", "reply"]);
  assert.deepEqual(h.views.at(-1), { state: "reply", text: "Hi" });
  mock.timers.tick(11_999); assert.equal(h.closed, 0);
  mock.timers.tick(1); assert.equal(h.closed, 1);
});
test("a reply under the pointer stays until the pointer leaves");             // hovered = true; tick(12_000) closed 0; hovered = false; tick(500) closed 1
test("presses while listening, sending or thinking are ignored");             // ask pending forever: press ×2 while listening, release, press while sending → starts.length 1
test("a press while a reply shows closes it and starts a new ask");           // ask stays open after a reply update: press → its signal.aborted true, closed 1, starts.length 2, views.at(-1) listening ""
test("voice in use refuses without listening", () => {
  const h = harness({ busy: true }); h.session.press();
  assert.deepEqual(h.starts, []);
  assert.deepEqual(h.views, [{ state: "error", text: "Voice is in use in MausBot" }]);
  mock.timers.tick(4_000); assert.equal(h.closed, 1);
});
test("an empty transcript closes silently, even when the recognizer reports an error", async () => {
  for (const info of [{ code: 0, reason: "completed" }, { code: 1, reason: "recognition-error" }, { code: 1, reason: "helper-exited" }]) {
    const h = harness(); h.session.press(); release(h, info); await flush();
    assert.equal(h.closed, 1, info.reason); assert.equal(h.asks.length, 0);
    assert.ok(h.views.every(v => v.state === "listening"), info.reason);
  }
});
test("words heard before a recognizer error are still sent");                 // say "remind me", release {code:1, reason:"recognition-error"} → asks[0].text "remind me"
test("permission and setup problems say what to fix");                        // speech-not-authorized → TALK_TEXT.permission; dictation-disabled → dictationOff; helper-start-failed → unavailable; each hides after 4 s
test("the server not running says Open MausBot to talk and stops listening", async () => {
  const h = harness({ prepare: async () => { throw new TalkServerError("server-down"); } });
  h.session.press(); await flush();
  assert.deepEqual(h.stops, [true]);
  assert.deepEqual(h.views.at(-1), { state: "error", text: "Open MausBot to talk" });
  mock.timers.tick(4_000); assert.equal(h.closed, 1);
});
test("needs-you shows and hides like a reply");                               // ask: onUpdate reply "Checking", needs-you, resolve "needs-you" → views.at(-1) { state: "needs-you", text: "Checking" }; tick(12_000) closed 1
test("no answer in 120 s shows Still working · Open chat", async () => {
  let signal; const h = harness({ ask: async input => { signal = input.signal; input.onUpdate({ kind: "thinking" }); return new Promise(() => {}); } });
  h.session.press(); say(h, "book a table"); release(h); await flush();
  mock.timers.tick(119_999); assert.notEqual(h.views.at(-1).state, "still-working");
  mock.timers.tick(1);
  assert.deepEqual(h.views.at(-1), { state: "still-working", text: "" });
  assert.equal(signal.aborted, true);
  mock.timers.tick(12_000); assert.equal(h.closed, 1);
});
test("a lost stream shows Still working; a refused send shows the failure");  // ask rejects TalkServerError("lost") → still-working; TalkServerError("refused") → { state: "error", text: TALK_TEXT.failed }
test("replaced while listening closes the box and nothing is sent");         // sink.replaced() → closed 1; then release(h) after say → asks.length 0
test("clicking the box opens the chat; before the chat is known it only brings MausBot forward"); // open() while listening → opened [null], stops [true], closed 1; after a reply → opened [CHAT]
test("dismissing while listening cancels capture");                           // dismiss() → stops [true], closed 1
```

- [ ] **Step 2: Run to see them fail**

Run: `node --test electron/talk-session.node-test.mjs`
Expected: FAIL (`talk-session.mjs` missing).

- [ ] **Step 3: Implement** `createTalkSession` to the table above.

- [ ] **Step 4: Run to see them pass**

Run: `node --test electron/talk-session.node-test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/talk-session.mjs electron/talk-session.node-test.mjs
git commit -m "feat(talk): one ask from press to reply"
```

---

### Task 8: Wire it into the desktop app

**Files:**
- Modify: `electron/main.mjs` (electron import line 1, speech import line 11, the 12 `BrowserWindow.getAllWindows()` sites at 139, 269, 359, 945, 952, 1544, 1550, 1826, 2905, 3068, 3198, 3204; speech IPC 2477-2491; prefs at 3066; `before-quit` 3222), `electron/preload.cjs` (`HOME_PAGE` line 43, speech block 162-174), `src/types/ogb.d.ts` (after `speechFinish`, ~261)
- Test: `electron/talk-main.node-test.mjs` (new, reads `main.mjs` and `preload.cjs` source like `electron/local-only-hoist.node-test.mjs`), `electron/preload.node-test.mjs` (add)

**Interfaces:**
- Consumes: everything from Tasks 3-7.
- Produces: `window.ogb.talkShortcut?: TalkShortcutBridge` (this computer's page only) and `window.ogb.callActive?(active: boolean): Promise<void>` (this computer's page and My Cloud's own page). IPC `talk-shortcut:state`, `talk-shortcut:set` (`localOnly`), `call:active` (`localOrHome`: a Live call on My Cloud's page holds the microphone too; the worst a page can do with it is block the shortcut).

Wiring in `main.mjs`:
- `function appWindows() { return BrowserWindow.getAllWindows().filter((win) => !isTalkPanel(win)); }` (a hoisted declaration near the top) replaces every `BrowserWindow.getAllWindows()` call.
- `speech:stop` and `speech:finish` call `stopSpeech(BrowserWindow.fromWebContents(event.sender))` / `finishSpeech(…)`, so a page never stops the talk box's session.
- Next to the speech IPC: `const callPresence = createCallPresence();`, `let talkShortcut = null, talkSession = null;`, the three handlers (`talk-shortcut:set` passes only boolean `enabled` and string `key` through).
- In `whenReady`, at 3066: `const desktopPrefs = createDesktopPrefs(jsonFile(path.join(app.getPath("userData"), "desktop-prefs.json")));` passed as `prefs` to `registerDesktopPrefs`; then the panel (`createTalkPanel({ BrowserWindow, screen, iconPath: APP_ICON, onOpen: () => talkSession.open(), onDismiss: () => talkSession.dismiss() })`), `talkShortcut = createTalkShortcut({ globalShortcut, prefs: desktopPrefs, available: () => nativeActions.appleSpeech && !desktopRemoteAccess, onPress: () => talkSession.press() })` and `talkSession = createTalkSession({ speech: { start: startSpeech, stop: stopSpeech }, server: createTalkServer({ request: talkRequest, prefs: desktopPrefs, serverKey: () => (app.isPackaged ? runningDataDir : DEV_URL) ?? "local" }), panel, voiceInUse: () => speechBusy() || callPresence.active(), release: () => talkShortcut.releaseModifiers(), openChat: chat => (chat ? queueChatLink(`openmausbot://thread/${chat.threadId}?bot=${chat.botId}`) : revealForLink()) })`.
- `talkRequest(route, init)`: packaged → `localServerRequest(route, init)` (owner header; rejects while the server is down); dev → `fetch(new URL(route, DEV_URL), init)`, through Vite's `/api` proxy to `pnpm dev:server`, because dev never starts the server itself (`serverReady = !app.isPackaged`, line 313).
- `before-quit`, first lines: `talkSession?.close(); talkShortcut?.close();`.

- [ ] **Step 1: Write the failing tests**

```js
// talk-main.node-test.mjs
test("every list of the app's windows leaves the talk box out", () => {
  assert.equal(main.match(/BrowserWindow\.getAllWindows\(\)/g).length, 1);
  assert.match(main, /function appWindows\(\) \{\s*return BrowserWindow\.getAllWindows\(\)\.filter\(\(win\) => !isTalkPanel\(win\)\);/);
});
test("the talk setting answers only this computer's page; a call can be reported from My Cloud's page too", () => {
  for (const channel of ["talk-shortcut:state", "talk-shortcut:set"]) assert.match(main, new RegExp(`ipcMain\\.handle\\("${channel}", localOnly\\("${channel}"`));
  assert.match(main, /ipcMain\.handle\("call:active", localOrHome\("call:active"/);
  const list = name => preload.match(new RegExp(`const ${name} = (?:new Set\\()?\\[([^\\]]*)\\]`))[1];
  assert.doesNotMatch(list("REMOTE_SAFE"), /talkShortcut|callActive/);
  assert.match(list("HOME_PAGE"), /"callActive"/);
  assert.doesNotMatch(list("HOME_PAGE"), /talkShortcut/);
});
test("a page's speech stop and finish touch only the session that page started", () => {
  assert.match(main, /stopSpeech\(BrowserWindow\.fromWebContents\(event\.sender\)\)/);
  assert.match(main, /finishSpeech\(BrowserWindow\.fromWebContents\(event\.sender\)\)/);
});
// preload.node-test.mjs
test("the talk bridge asks main over its own channels with only what it understands", async () => {
  const before = invocations.length;
  await exposed.api.talkShortcut.state();
  await exposed.api.talkShortcut.set({ enabled: false, key: "ctrl-shift-space", extra: "x" });
  await exposed.api.callActive(true);
  await exposed.api.callActive("yes");
  assert.deepEqual(invocations.slice(before), [["talk-shortcut:state"], ["talk-shortcut:set", { enabled: false, key: "ctrl-shift-space" }], ["call:active", true], ["call:active", false]]);
});
```

- [ ] **Step 2: Run to see them fail**

Run: `node --test electron/talk-main.node-test.mjs electron/preload.node-test.mjs`
Expected: FAIL (12 `getAllWindows` sites; no talk channels; no `talkShortcut` in the bridge).

- [ ] **Step 3: Implement** the wiring above, the preload keys (`talkShortcut: { state, set }`, `callActive`; `"callActive"` added to `HOME_PAGE`), and `ogb.d.ts`: `talkShortcut?: import("../../electron/talk-shortcut.mjs").TalkShortcutBridge;` with a doc comment "This computer's page only: Settings → General's talk shortcut." and `callActive?(active: boolean): Promise<void>;` with "A call holds the microphone, so the talk shortcut waits."

- [ ] **Step 4: Run the checks**

Run: `node --test electron/talk-main.node-test.mjs electron/preload.node-test.mjs electron/local-only-hoist.node-test.mjs && pnpm typecheck && pnpm lint`
Expected: PASS, no type or lint errors.

- [ ] **Step 5: Commit**

```bash
git add electron/main.mjs electron/preload.cjs src/types/ogb.d.ts electron/talk-main.node-test.mjs electron/preload.node-test.mjs
git commit -m "feat(talk): wire the talk shortcut into the desktop app"
```

---

### Task 9: Settings row and call presence

**Files:**
- Create: `src/lib/call-presence.ts`, `src/components/TalkShortcutRow.tsx`
- Modify: `src/components/LiveCallHost.tsx` (call the hook), `src/components/SettingsModal.tsx` (General keywords line 85; render `<TalkShortcutRow />` right after `<DefaultBotSidebarRow />` at ~671), `src/locales/en.json` (beside `settings.analytics.*`, ~1228)
- Test: `src/lib/call-presence.test.ts`, `src/components/TalkShortcutRow.test.ts` (happy-dom, `createRoot` + `act`, with `settle`/`show`/`click` helpers as `src/components/UpdatesConsent.test.ts:14-27`; `toggle()` is `button[aria-label="Talk to MausBot from any app"]`; `bridge = { state: vi.fn(async () => current), set: vi.fn(async change => (current = { ...current, ...change })) }` on `window.ogb.talkShortcut`)

**Interfaces:**
- Consumes: `window.ogb.talkShortcut`, `window.ogb.callActive` (Task 8); `useOnCall`, `startCall`, `endCall` (`src/lib/call.ts`); `useLiveMedia`, `isLiveCallRunning`, `LiveMediaPhase` (`src/lib/live-call-media.ts`).
- Produces: `callInProgress(onCall: string | null, phase: LiveMediaPhase): boolean`; `useReportCallPresence(): void` (reports on mount and on every change, so a reloaded page clears a stale `true`); `TalkShortcutRow()`.
- Strings: `settings.talk.title` "Talk to MausBot from any app", `settings.talk.subtitle` "Hold {key}, speak, let go. MausBot answers in a small box at the bottom of the screen; click it to open the chat.", `settings.talk.aria` "Talk to MausBot from any app", `settings.talk.keyAria` "Talk shortcut", `settings.talk.taken` "{key} is used by another app. Pick another shortcut.". Keywords: `"talk"`, `"voice"`, `"shortcut"`, `"hotkey"`, `"hold to talk"`, `"push to talk"`, `"quick asks"`.
- Row: hidden without the bridge or when `!state.available`; `SettingRow` with the `Switch`; when on, a `Select size="sm"` of `state.keys` (labels) in the row's `message`, and under it `role="alert"` `settings.talk.taken` when `state.taken`; each change shows the state `set()` returns.

- [ ] **Step 1: Write the failing tests**

```ts
// call-presence.test.ts
it("a turn call or a running Live call is a call", () => {
  expect(callInProgress(null, "idle")).toBe(false);
  expect(callInProgress("bot-1", "idle")).toBe(true);
  for (const phase of ["starting", "live", "ending"] as const) expect(callInProgress(null, phase)).toBe(true);
  for (const phase of ["ended", "failed"] as const) expect(callInProgress(null, phase)).toBe(false);
});
it("tells main when a call starts and ends, and says none on mount", async () => {
  const callActive = vi.fn(async () => {});
  (window as any).ogb = { callActive };
  await act(async () => { root.render(createElement(() => { useReportCallPresence(); return null; })); });
  await act(async () => { startCall("bot-1"); });
  await act(async () => { endCall("bot-1"); });
  expect(callActive.mock.calls).toEqual([[false], [true], [false]]);
});
// TalkShortcutRow.test.ts — base state { available: true, enabled: true, key: "ctrl-opt-space", keys: KEYS, taken: false }
it("is not shown without the bridge or where Apple speech is unavailable");   // no ogb → host empty; available:false → host empty
it("shows the switch on with the key in its subtitle, and turns it off", async () => {
  await show();
  expect(host.textContent).toContain("Talk to MausBot from any app");
  expect(host.textContent).toContain("Hold ⌃⌥Space, speak, let go");
  await click(toggle());
  expect(bridge.set).toHaveBeenCalledWith({ enabled: false });
  expect(toggle().getAttribute("aria-checked")).toBe("false");
  expect(host.querySelector("select")).toBeNull();
});
it("changes the key and says so");                                            // change select to "ctrl-shift-space" → set({ key: "ctrl-shift-space" }); text contains "Hold ⌃⇧Space"
it("says when another app holds the key");                                    // taken: true → [role=alert] text "⌃⌥Space is used by another app. Pick another shortcut."
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm exec vitest run src/lib/call-presence.test.ts src/components/TalkShortcutRow.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement** the hook (call it in `LiveCallHost`), the row, its placement and keywords, and the strings.

- [ ] **Step 4: Run to see them pass**

Run: `pnpm exec vitest run src/lib/call-presence.test.ts src/components/TalkShortcutRow.test.ts src/locales && pnpm i18n:check && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/call-presence.ts src/lib/call-presence.test.ts src/components/TalkShortcutRow.tsx src/components/TalkShortcutRow.test.ts src/components/LiveCallHost.tsx src/components/SettingsModal.tsx src/locales/en.json
git commit -m "feat(talk): Settings row, and calls tell main they hold the microphone"
```

---

### Task 10: Verification recipe and the whole check

**Files:**
- Create: `docs/verification/talk-shortcut.md`
- Modify: `docs/verification/README.md` (a paragraph after the local-environments one, ~line 111: the recipe checks hold-to-talk, the box and the Quick asks chat by hand on a packaged side-by-side build; the control surface cannot drive a global shortcut or the microphone, so it is not in the map)

**Interfaces:**
- Consumes: everything above.

`talk-shortcut.md` sections (in this repo's recipe style, see `docs/verification/local-environments.md`):
1. **Floor: automated checks** — `node --test electron/talk-*.node-test.mjs electron/desktop-prefs.node-test.mjs electron/preload.node-test.mjs electron/speech-helper-release.node-test.mjs`; `pnpm exec vitest run electron/speech.test.mjs server/task-select.test.ts server/talk-server.e2e.test.ts src/lib/call-presence.test.ts src/components/TalkShortcutRow.test.ts --maxWorkers=1`; `pnpm typecheck && pnpm lint && pnpm i18n:check`. What they prove and what they do not (the real hotkey, the microphone, focus, Spaces).
2. **Setup** — a packaged build of the branch installed beside, never over, the installed OpenMausBot (maintainers: the OMB2 side-by-side build), launched with `OMB_DATA_DIR=$HOME/.openmausbot-test` unless the check needs real bots; only one running app may hold the key. Composer dictation used once first so Microphone and Speech Recognition are granted.
3. **By hand**, each with its expected result:
   - Settings → General shows the row, on, "Hold ⌃⌥Space, speak, let go".
   - In Safari's address bar: hold ⌃⌥, tap Space, say "what can you do", let go of ⌃⌥. Live words, then the reply, bottom-centre of that display. `osascript -e 'tell application "System Events" to name of first application process whose frontmost is true'` prints `Safari` before and after; the caret still blinks in Safari; the MausBot window stays behind.
   - The box hides 12 s after the reply; with the pointer on it, it stays until the pointer leaves.
   - Clicking it brings MausBot forward on the "Quick asks" chat; the chat open before the ask had not changed until then.
   - In a full-screen app and on another Space, the box shows there.
   - Tap and let go without speaking: the box closes, no error.
   - During a voice call, and while composer dictation is on: "Voice is in use in MausBot"; the call or dictation carries on.
   - Delete the Quick asks chat, ask again: a new Quick asks chat.
   - Switch to ⌃⇧Space: ⌃⌥Space does nothing in MausBot any more; ⌃⇧Space works and ends on letting go of ⌃ or ⇧.
   - Turn it off: the key does nothing.
   - With System Settings → Keyboard → Keyboard Shortcuts → Input Sources → "Select next source in Input menu" on (⌃⌥Space): note whether Settings shows "⌃⌥Space is used by another app" or the press never arrives; either way ⌃⇧Space must work.
   - Dev loop: `pnpm dev:server`, `pnpm dev`, `pnpm dev:desktop`: an ask reaches the dev server through Vite's `/api` proxy.

- [ ] **Step 1: Write the recipe and the README paragraph.**

- [ ] **Step 2: Run the whole check**

Run: `pnpm typecheck && pnpm lint && pnpm i18n:check && pnpm test:electron && pnpm exec vitest run electron/speech.test.mjs server/task-select.test.ts server/talk-server.e2e.test.ts src/lib/call-presence.test.ts src/components/TalkShortcutRow.test.ts src/components/UpdatesConsent.test.ts src/components/AppNotices.test.ts --maxWorkers=1`
Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
git add docs/verification/talk-shortcut.md docs/verification/README.md
git commit -m "docs(verification): talk shortcut recipe"
```

---

## Self-review

- **Spec coverage.** Key via `globalShortcut` + helper release (Tasks 2, 4); repeat presses ignored, press during a reply starts anew (7); registration failure shown in Settings (4, 9); speech sinks, `speechBusy`, `replaced()` (3); `call:active` and refusal during calls or dictation (4, 7, 8, 9); the box, its window flags, `data:` page with strict CSP, `open()`/`dismiss()` only, states, 12 s hide unless hovered, click opens the chat, panel skipped by every window list (6, 7, 8); local server, MausBot lookup, owner header, send with `sendId`, SSE follow, needs-you, 120 s, empty transcript, server down (5, 7, 8); prefs, Settings row, hidden without Apple speech, not in `REMOTE_SAFE` (4, 8, 9); Quick asks chat created, reused, recreated, per server (1, 4, 5); testing section (all tasks, 10). Dev reaching the dev server (8, 10).
- **Deviations from the spec, on purpose.** The ask posts `threadId` (the spec's `{text, sendId}` would land in MausBot's selected chat, `server/routes/bot-messages.ts:202`, against the Quick asks decision). Speech sink tests live in vitest `electron/speech.test.mjs`, not a node-test, because `speech.mjs` imports Electron's `app`. `call:active` is `localOrHome`, not `localOnly`, so a Live call on My Cloud's page also blocks the shortcut. The box's copy is English in v1.
- **Types.** `TalkView`, `TalkChat`, `TalkUpdate`, `TalkShortcutState`, `TalkKeyId` and every factory name are spelled the same in each task's Interfaces and tests.
- **Left open to the implementer.** Exact page markup and CSS within the tokens given; the Swift parsing style.
