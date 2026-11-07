import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { createMoveInAsks, decodeMoveAsk, MOVE_ASK_TTL_MS, MOVE_IN_WORDS } from "./move-in-ask.mjs";

const NOW = 1_000_000;
const ASK = { deviceId: "phone-1", deviceName: "iPhone", bots: 4, expiresAt: NOW + 300_000 };

function fixture({ response = 1, locale = "en", now = () => NOW, show, platform = "win32", window = () => null, answer } = {}) {
  const shown = [];
  const answers = [];
  const logs = [];
  let windowAsked = 0;
  const dialog = {
    showMessageBox: (...args) => {
      shown.push(args);
      return show ? show(args.at(-1)) : Promise.resolve({ response });
    },
  };
  const asks = createMoveInAsks({
    dialog,
    locale: () => locale,
    answer: answer ?? (async (...args) => { answers.push(args); }),
    now,
    platform,
    window: () => { windowAsked += 1; return window(); },
    log: (line) => logs.push(line),
  });
  return { asks, shown, answers, logs, windowAsked: () => windowAsked };
}

test("asks with the phone's name and how many bots, and Don't Allow is the default", async () => {
  const { asks, shown, answers, windowAsked } = fixture();
  assert.equal(await asks.ask(ASK), false);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].length, 1, "a PC's box has no parent window, so it shows with the app in the tray");
  assert.equal(windowAsked(), 0, "and the window is never opened for it");
  const { signal, ...options } = shown[0][0];
  assert.deepEqual(options, {
    type: "question",
    message: "Your \u2068iPhone\u2069 wants to move 4 bots here. Allow?",
    detail: "Their chats, memory, skills and routines come too, with any API keys you picked on the phone. Nothing else here changes. The phone has 30 minutes to finish.",
    buttons: ["Allow", "Don't Allow"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, false);
  assert.deepEqual(answers, [["phone-1", false, ASK.expiresAt]]);
});

test("says bot for one", async () => {
  const { asks, shown } = fixture();
  await asks.ask({ ...ASK, bots: 1 });
  assert.equal(shown[0][0].message, "Your \u2068iPhone\u2069 wants to move 1 bot here. Allow?");
});

test("answers yes only for Allow", async () => {
  const { asks, answers } = fixture({ response: 0 });
  assert.equal(await asks.ask(ASK), true);
  assert.deepEqual(answers, [["phone-1", true, ASK.expiresAt]]);
});

test("asks one at a time", async () => {
  let release;
  const { asks, shown, answers } = fixture({
    show: () => (shown.length === 1 ? new Promise((resolve) => { release = () => resolve({ response: 1 }); }) : Promise.resolve({ response: 1 })),
  });
  const first = asks.ask(ASK);
  const second = asks.ask({ ...ASK, deviceId: "phone-2", deviceName: "iPad" });
  await delay(20);
  assert.equal(shown.length, 1, "the second dialog waits for the first");
  release();
  await Promise.all([first, second]);
  assert.deepEqual(shown.map(([options]) => options.message), [
    "Your \u2068iPhone\u2069 wants to move 4 bots here. Allow?",
    "Your \u2068iPad\u2069 wants to move 4 bots here. Allow?",
  ]);
  assert.deepEqual(answers, [["phone-1", false, ASK.expiresAt], ["phone-2", false, ASK.expiresAt]]);
});

test("speaks the app's language", async () => {
  const { asks, shown } = fixture({ locale: "pt-BR" });
  await asks.ask(ASK);
  assert.equal(shown[0][0].message, "Seu \u2068iPhone\u2069 quer mover 4 bots para cá. Permitir?");
  assert.deepEqual(shown[0][0].buttons, ["Permitir", "Não permitir"]);
});

test("never shows an ask that expired while it waited its turn", async () => {
  let clock = NOW;
  let release;
  const { asks, shown, answers } = fixture({
    now: () => clock,
    show: () => new Promise((resolve) => { release = () => resolve({ response: 1 }); }),
  });
  const first = asks.ask(ASK);
  const late = asks.ask({ ...ASK, deviceId: "phone-2", expiresAt: NOW + 1_000 });
  await delay(5);
  clock = NOW + 1_000;
  release();
  assert.equal(await first, false);
  assert.equal(await late, false);
  assert.equal(shown.length, 1);
  assert.deepEqual(answers, [["phone-1", false, ASK.expiresAt]]);
});

test("closes the dialog when its ask expires and answers nothing", async () => {
  const { asks, shown, answers } = fixture({
    // Electron 43 closes an aborted message box as if cancelled, with the cancel button's response.
    show: ({ signal }) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({ response: 1 }))),
  });
  const [allowed] = await Promise.all([asks.ask({ ...ASK, expiresAt: NOW + 30 }), delay(200)]);
  assert.equal(allowed, false);
  assert.equal(shown[0].at(-1).signal.aborted, true);
  assert.deepEqual(answers, []);
});

test("a click after the ask expired answers nothing, so a stale dialog never grants a newer ask", async () => {
  for (const response of [0, 1]) {
    let clock = NOW;
    const { asks, answers } = fixture({
      now: () => clock,
      show: async () => {
        clock = ASK.expiresAt;
        return { response };
      },
    });
    assert.equal(await asks.ask(ASK), false);
    assert.deepEqual(answers, [], `response ${response}`);
  }
});

test("on a Mac the box is a sheet on the app's window, shown first, so it never stops the app and closes at expiry", async () => {
  let visible = false;
  let raised = 0;
  const win = { isDestroyed: () => false, isVisible: () => visible, show: () => { visible = true; raised += 1; } };
  const { asks, shown, answers } = fixture({ platform: "darwin", window: () => win });
  assert.equal(await asks.ask(ASK), false);
  assert.equal(raised, 1);
  assert.equal(shown[0].length, 2);
  assert.equal(shown[0][0], win);
  assert.ok(shown[0][1].signal instanceof AbortSignal);
  assert.deepEqual(answers, [["phone-1", false, ASK.expiresAt]]);

  const none = fixture({ platform: "darwin", window: () => null });
  assert.equal(await none.asks.ask(ASK), false);
  assert.deepEqual([none.shown, none.answers], [[], []], "no window to attach to: no box that would stop the app, and no answer");
});

test("a failed answer is logged without the phone's name", async () => {
  const { asks, logs } = fixture({ response: 0, answer: async () => { throw new Error("companion control 409"); } });
  assert.equal(await asks.ask(ASK), false);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /companion control 409/);
  assert.doesNotMatch(logs[0], /iPhone/);
});

test("the phone's name can't reorder or break the question", async () => {
  const good = { type: "openmausbot:companion-move-ask", deviceId: "phone-1", deviceName: "x", bots: 4, expiresAt: ASK.expiresAt };
  assert.equal(decodeMoveAsk({ ...good, deviceName: "Omkar\u202E's\u2028iPhone\u200B\u0085\u2029" }, NOW).deviceName, "Omkar'siPhone");
  assert.equal(decodeMoveAsk({ ...good, deviceName: "\u202E\u2066\u200B" }, NOW), null, "nothing left to show");
  const { asks, shown } = fixture();
  await asks.ask(decodeMoveAsk({ ...good, deviceName: "evil\u202Eenohp" }, NOW));
  assert.equal(shown[0][0].message, "Your \u2068evilenohp\u2069 wants to move 4 bots here. Allow?");
});

test("an ask lives no longer than the companion's", async () => {
  const source = await readFile(new URL("../companion/src/move-grants.ts", import.meta.url), "utf8");
  assert.equal(Number(/MOVE_ASK_TTL_MS = ([\d_]+);/.exec(source)?.[1].replaceAll("_", "")), MOVE_ASK_TTL_MS);
  const good = { type: "openmausbot:companion-move-ask", deviceId: "phone-1", deviceName: "iPhone", bots: 4 };
  assert.equal(decodeMoveAsk({ ...good, expiresAt: NOW + MOVE_ASK_TTL_MS + 10_000 }, NOW).expiresAt, NOW + MOVE_ASK_TTL_MS + 10_000);
  assert.equal(decodeMoveAsk({ ...good, expiresAt: NOW + MOVE_ASK_TTL_MS + 10_001 }, NOW), null);
  assert.equal(decodeMoveAsk({ ...good, expiresAt: 2 ** 31 + NOW }, NOW), null);
});

test("reads only a well-formed ask", () => {
  const good = { type: "openmausbot:companion-move-ask", deviceId: "phone-1", deviceName: "iPhone", bots: 4, expiresAt: ASK.expiresAt };
  assert.deepEqual(decodeMoveAsk(good, NOW), { deviceId: "phone-1", deviceName: "iPhone", bots: 4, expiresAt: ASK.expiresAt });
  for (const bad of [
    { type: "openmausbot:phone-secret-save" },
    { deviceId: "../x" },
    { deviceId: "a".repeat(129) },
    { bots: 0 },
    { bots: 201 },
    { bots: 2.5 },
    { bots: "4" },
    { deviceName: "" },
    { deviceName: "x".repeat(81) },
    { expiresAt: undefined },
    { expiresAt: Number.NaN },
    { expiresAt: Number.POSITIVE_INFINITY },
    { expiresAt: String(ASK.expiresAt) },
  ]) assert.equal(decodeMoveAsk({ ...good, ...bad }, NOW), null, JSON.stringify(bad));
  for (const bad of [null, undefined, "ask", []]) assert.equal(decodeMoveAsk(bad, NOW), null);
});

test("says what every language pack says, word for word", async () => {
  const dir = fileURLToPath(new URL("../src/locales/", import.meta.url));
  const en = JSON.parse(await readFile(path.join(dir, "en.json"), "utf8"));
  const keys = Object.keys(en).filter((key) => key.startsWith("moveIn."));
  assert.deepEqual(keys.sort(), Object.keys(MOVE_IN_WORDS.en).sort(), "every key main uses is in the catalog, and only those");
  for (const file of (await readdir(dir)).filter((name) => name.endsWith(".json") && name !== "source-hashes.json")) {
    const locale = file.slice(0, -".json".length);
    const pack = JSON.parse(await readFile(path.join(dir, file), "utf8"));
    assert.ok(MOVE_IN_WORDS[locale], `${locale}: main has no words for it`);
    for (const key of keys) assert.equal(MOVE_IN_WORDS[locale][key], pack[key] ?? en[key], `${locale} ${key}: copy src/locales/${file} into electron/move-in-ask.mjs`);
  }
});
