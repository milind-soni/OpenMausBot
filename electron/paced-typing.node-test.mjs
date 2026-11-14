import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_PACED_CHARACTERS, typeOneCharacterAtATime, typesInOneBurst, typingUnits, withoutLeakedToolTags } from "./paced-typing.mjs";

const NOTEPAD = { pid: 4242, window: 0x30a5c };
const CHAT = { pid: 77, window: 0x1f00 };
const hex = (value) => `0x${value.toString(16)}`;

/** Notepad behind cua-driver 0.28.2, as the reporter saw it: in one SendInput burst the first character lands and every
 * later one becomes the burst's last. */
function windowsDriver({ front = CHAT.window, onType } = {}) {
  const owners = new Map([[NOTEPAD.window, NOTEPAD.pid], [CHAT.window, CHAT.pid]]);
  const firstWindow = (pid) => [...owners].find(([, owner]) => owner === pid)?.[0];
  const state = { front, document: "", calls: [] };
  state.call = async (name, args) => {
    state.calls.push({ name, args });
    if (name === "bring_to_front") {
      const target = args.window_id ?? firstWindow(args.pid);
      const previous = state.front;
      state.front = target;
      return { content: [{ type: "text", text: "✅ bring_to_front" }],
        structuredContent: { previous_fg_hwnd: hex(previous), now_fg_hwnd: hex(target), target_hwnd: hex(target), landed_on_target: true } };
    }
    if (name === "list_windows") {
      return { content: [{ type: "text", text: "windows" }], structuredContent: { windows: [...owners].map(([window_id, pid]) => ({ window_id, pid })) } };
    }
    if (name !== "type_text") throw new Error(`unexpected ${name}`);
    const target = args.scope === "desktop" ? state.front : args.window_id ?? firstWindow(args.pid);
    if (target !== NOTEPAD.window) return { content: [{ type: "text", text: "typed elsewhere" }], isError: true };
    const previous = state.front;
    state.front = target;
    const text = args.text === "\r\n" || args.text === "\r" ? "\n" : args.text;
    state.document += text.length < 2 ? text : text[0] + text.at(-1).repeat(text.length - 1);
    if (previous !== target) state.front = previous;
    onType?.(state);
    return { content: [{ type: "text", text: `✅ Typed ${[...args.text].length} char(s) on pid ${args.pid} via SendInput (delivery_mode:foreground).` }],
      structuredContent: { effect: "unverifiable", route: "global_input", delivery: { mode: "foreground" } } };
  };
  return state;
}

const foreground = (text, extra = {}) => ({ pid: NOTEPAD.pid, window_id: NOTEPAD.window, delivery_mode: "foreground", text, ...extra });
const named = (state, name) => state.calls.filter((call) => call.name === name);
const said = (result) => result.content.map((part) => part.text).join("\n");

test("only a burst-typing driver on Windows gets its foreground text one character at a time", () => {
  const args = foreground("abc");
  assert.equal(typesInOneBurst("win32", "0.28.2", "type_text", args), true);
  assert.equal(typesInOneBurst("win32", "0.34.9", "type_text", { ...args, delivery_mode: "Foreground" }), true);
  assert.equal(typesInOneBurst("win32", "0.28.2", "type_text", { scope: "desktop", text: "abc" }), true);
  for (const [platform, version, name, given] of [
    ["darwin", "0.28.2", "type_text", args], ["linux", "0.28.2", "type_text", args],
    // The driver paces this itself from 0.35.0 on; an unknown driver keeps its own behaviour.
    ["win32", "0.35.0", "type_text", args], ["win32", "1.0.0", "type_text", args], ["win32", undefined, "type_text", args], ["win32", "nightly", "type_text", args],
    ["win32", "0.28.2", "press_key", args],
    // Background typing posts characters to the window or sets its value: no burst.
    ["win32", "0.28.2", "type_text", { ...args, delivery_mode: "background" }], ["win32", "0.28.2", "type_text", { pid: NOTEPAD.pid, text: "abc" }],
    ["win32", "0.28.2", "type_text", { scope: "desktop", pid: NOTEPAD.pid, text: "abc" }],
    ["win32", "0.28.2", "type_text", { delivery_mode: "foreground", element_token: "t-1", pid: NOTEPAD.pid, text: "abc" }],
    ["win32", "0.28.2", "type_text", { ...args, pid: "4242" }], ["win32", "0.28.2", "type_text", { ...args, text: 7 }],
  ]) assert.equal(typesInOneBurst(platform, version, name, given), false, `${platform} ${version} ${name} ${JSON.stringify(given)}`);
});

test("a character is what the driver reads as one: a code point, or one line break for CRLF", () => {
  assert.deepEqual(typingUnits("a\r\nb\rc\nd"), ["a", "\r\n", "b", "\r", "c", "\n", "d"]);
  assert.deepEqual(typingUnits("\n\r"), ["\n", "\r"]);
  assert.deepEqual(typingUnits("🙂ä"), ["🙂", "ä"]);
  assert.deepEqual(typingUnits("é"), ["e", "́"]);
  assert.deepEqual(typingUnits(""), []);
});

test("tool-call closing tags a model leaked into the end of the text go, as the driver drops them", () => {
  const close = (name) => `\x3c/${name}\x3e`;
  assert.equal(withoutLeakedToolTags(`End of document.\n${close("text")}\n${close("invoke")}`), "End of document.");
  assert.equal(withoutLeakedToolTags(`Some body.\n${close("antml:parameter")}\n${close("antml:invoke")}\n${close("antml:function_calls")}`), "Some body.");
  assert.equal(withoutLeakedToolTags(`Hello <b>world</b>\n${close("text")}`), "Hello <b>world</b>");
  for (const kept of [`\x3ctext\x3efoo${close("text")}`, `\x3cparameter name="foo"\x3ebody${close("parameter")}`, "Hello world </div>",
    "Lorem ipsum dolor sit amet. ", "", "trailing spaces stay   "]) assert.equal(withoutLeakedToolTags(kept), kept);
});

test("the reported sentences land whole, each character after its window is confirmed in front, and the chat gets the front back", async () => {
  for (const text of [" Zeile Drei", " 28", " : , .", "Zeile 3: Vordergrund echt, Notiz, 28.10.2026"]) {
    const burst = windowsDriver({ front: NOTEPAD.window });
    await burst.call("type_text", foreground(text));
    assert.notEqual(burst.document, text, "one burst reproduces the report");

    const driver = windowsDriver();
    const result = await typeOneCharacterAtATime(driver.call, foreground(text, { element_index: 3, session: "bot-1" }));
    assert.equal(driver.document, text);
    assert.equal(result.isError, undefined);
    assert.equal(said(result), `✅ Typed ${[...text].length} char(s) on pid ${NOTEPAD.pid} via SendInput (delivery_mode:foreground), one character at a time.`);
    assert.deepEqual(result.structuredContent, { effect: "unverifiable", route: "global_input", delivery: { mode: "foreground" } });
    const typed = named(driver, "type_text");
    assert.deepEqual(typed.map((call) => call.args.text), [...text]);
    // The element is focused once; later characters name only the window, so nothing moves the caret.
    assert.deepEqual(typed[0].args, foreground(text[0], { element_index: 3, session: "bot-1" }));
    for (const call of typed.slice(1)) assert.deepEqual(call.args, foreground(call.args.text, { session: "bot-1" }));
    assert.deepEqual(driver.calls.map((call) => call.name), [...[...text].flatMap(() => ["bring_to_front", "type_text"]), "list_windows", "bring_to_front"]);
    assert.deepEqual(driver.calls.at(-1).args, { pid: CHAT.pid, window_id: CHAT.window });
    assert.equal(driver.front, CHAT.window);
  }
});

test("a line break goes as one Return, a window named by the driver alone is kept, and the front stays when it was the window's", async () => {
  const driver = windowsDriver({ front: NOTEPAD.window });
  await typeOneCharacterAtATime(driver.call, { pid: NOTEPAD.pid, delivery_mode: "foreground", text: "a\r\nb" });
  assert.equal(driver.document, "a\nb");
  assert.deepEqual(named(driver, "type_text").map((call) => [call.args.text, call.args.window_id]), [["a", undefined], ["\r\n", NOTEPAD.window], ["b", NOTEPAD.window]]);
  assert.equal(named(driver, "list_windows").length, 0);
});

test("someone else taking the front stops the typing and keeps it theirs", async () => {
  const driver = windowsDriver({ onType: (state) => { if (state.document.length === 3) state.front = CHAT.window; } });
  const result = await typeOneCharacterAtATime(driver.call, foreground("Hello"));
  assert.equal(driver.document, "Hel");
  assert.equal(result.isError, true);
  assert.match(said(result), /^Only the first 3 of 5 characters were typed; the rest were not sent\. The window being typed into was no longer in front/);
  assert.deepEqual(driver.calls.at(-1), { name: "bring_to_front", args: { pid: CHAT.pid, window_id: CHAT.window } });
  assert.equal(driver.front, CHAT.window);
});

test("a failed character ends the typing with what was typed and the driver's own reason", async () => {
  const driver = windowsDriver();
  const failing = async (name, args) => (name === "type_text" && args.text === "l"
    ? { content: [{ type: "text", text: "foreground_unavailable: … no input was sent" }], isError: true, structuredContent: { code: "tool_invocation_failed" } }
    : driver.call(name, args));
  const result = await typeOneCharacterAtATime(failing, foreground("Hello"));
  assert.equal(driver.document, "He");
  assert.equal(result.isError, true);
  assert.deepEqual(result.content.map((part) => part.text), [
    "Only the first 2 of 5 characters were typed; the rest were not sent. Typing the next one failed. Read the field again with get_window_state before typing the rest. The failure:",
    "foreground_unavailable: … no input was sent",
  ]);
  assert.equal(driver.front, CHAT.window);

  const first = await typeOneCharacterAtATime(async (name, args) => (name === "type_text" ? { content: [{ type: "text", text: "window_id is required" }], isError: true } : driver.call(name, args)), foreground("Hi"));
  assert.deepEqual(first, { content: [{ type: "text", text: "window_id is required" }], isError: true });
  const thrown = await typeOneCharacterAtATime(async (name, args) => { if (name === "type_text") throw new Error("Computer control is disconnected"); return driver.call(name, args); }, foreground("Hi"));
  assert.deepEqual(thrown, { content: [{ type: "text", text: "Computer control is disconnected" }], isError: true });
});

test("desktop scope types into whatever is in front without bringing anything forward", async () => {
  const driver = windowsDriver({ front: NOTEPAD.window });
  const result = await typeOneCharacterAtATime(driver.call, { scope: "desktop", text: "abc" });
  assert.equal(driver.document, "abc");
  assert.deepEqual(driver.calls.map((call) => [call.name, call.args]), [["type_text", { scope: "desktop", text: "a" }], ["type_text", { scope: "desktop", text: "b" }], ["type_text", { scope: "desktop", text: "c" }]]);
  assert.equal(said(result), "Typed 3 character(s) into the foreground application (scope:desktop), one at a time.");
});

test("one character, an over-long text and leaked tags", async () => {
  const one = windowsDriver({ front: NOTEPAD.window });
  await typeOneCharacterAtATime(one.call, foreground("x", { element_index: 2 }));
  assert.deepEqual(one.calls, [{ name: "type_text", args: foreground("x", { element_index: 2 }) }]);

  const long = windowsDriver();
  const refused = await typeOneCharacterAtATime(long.call, foreground("a".repeat(MAX_PACED_CHARACTERS + 1)));
  assert.equal(refused.isError, true);
  assert.match(said(refused), /^type_text was not performed: .* at most 300 characters; this text has 301\. Type it in parts/);
  assert.deepEqual(long.calls, []);

  const leaked = windowsDriver();
  await typeOneCharacterAtATime(leaked.call, foreground("ok\n\x3c/parameter\x3e"));
  assert.equal(leaked.document, "ok");
});
