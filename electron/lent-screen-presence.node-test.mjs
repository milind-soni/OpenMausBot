import assert from "node:assert/strict";
import { test } from "node:test";
import { createLentScreenPresence, PERSON_AWAY_SECONDS, personActiveText, takesForeground } from "./lent-screen-presence.mjs";

test("which lent screen calls would take the person's mouse, keyboard or front window", () => {
  const window = { pid: 42, window_id: 7 };
  for (const [name, args] of [
    ["get_window_state", {}], ["get_desktop_state", {}], ["list_windows", {}], ["zoom", {}], ["move_cursor", { x: 1, y: 1 }],
    ["start_session", { session: "s" }], ["launch_app", { name: "FreeShow" }], ["browser_click", { ref: "e1" }],
    ["click", { ...window, element_index: 3 }], ["click", { ...window, x: 4, y: 4 }], ["type_text", { ...window, element_index: 2, text: "hi" }],
    ["press_key", { ...window, key: "return" }], ["hotkey", { ...window, keys: ["cmd", "s"] }], ["scroll", { ...window, direction: "down" }],
    ["set_value", { ...window, element_index: 1, value: "x" }], ["click", { ...window, element_index: 3, delivery_mode: "background" }],
  ]) assert.equal(takesForeground(name, args), false, `${name} ${JSON.stringify(args)} stays in the background`);
  for (const [name, args] of [
    ["bring_to_front", window], ["drag", { ...window, from_x: 1, from_y: 1, to_x: 2, to_y: 2 }],
    ["click", { ...window, element_index: 3, delivery_mode: "foreground" }], ["press_key", { ...window, key: "a", scope: "desktop" }],
    // No window: it lands on whatever app or field the person has in front.
    ["click", { x: 4, y: 4 }], ["type_text", { text: "hi" }], ["press_key", { key: "return" }], ["hotkey", { keys: ["cmd", "q"] }],
    ["click", undefined], ["click", { pid: "42" }],
  ]) assert.equal(takesForeground(name, args), true, `${name} ${JSON.stringify(args)} takes the foreground`);
});

test("a foreground call waits while the person is using the computer; background calls never wait", () => {
  let idle = 0, clock = 1_000_000;
  const presence = createLentScreenPresence({ idleSeconds: () => idle, now: () => clock });
  assert.equal(presence.refusal("click", { pid: 42, window_id: 7, element_index: 3 }), null);
  assert.equal(presence.refusal("click", { x: 1, y: 1 }), personActiveText("click"));
  idle = PERSON_AWAY_SECONDS - 1;
  assert.equal(presence.refusal("drag", {}), personActiveText("drag"));
  idle = PERSON_AWAY_SECONDS;
  assert.equal(presence.refusal("drag", {}), null);
  // A system that cannot tell idle time waits for nothing, as before.
  for (const unknown of [null, undefined, Number.NaN]) {
    assert.equal(createLentScreenPresence({ idleSeconds: () => unknown }).refusal("bring_to_front", {}), null);
  }
  assert.equal(createLentScreenPresence().refusal("bring_to_front", {}), null);
});

test("the bot's own foreground input is not mistaken for the person; the person's next touch is", () => {
  let idle = PERSON_AWAY_SECONDS, clock = 1_000_000;
  const presence = createLentScreenPresence({ idleSeconds: () => idle, now: () => clock });
  assert.equal(presence.refusal("click", { x: 1, y: 1 }), null);
  clock += 400; presence.acted("click", { x: 1, y: 1 });
  // The click itself reset the system's idle time.
  clock += 600; idle = 0;
  assert.equal(presence.refusal("type_text", { text: "a" }), null, "the bot's own click");
  clock += 3_000; idle = 3;
  assert.equal(presence.refusal("type_text", { text: "a" }), null, "still the bot's click, three seconds on");
  // The person touched the trackpad well after the bot's last foreground action.
  clock += 5_000; idle = 0;
  assert.equal(presence.refusal("type_text", { text: "a" }), personActiveText("type_text"));
  // A background action is never counted as the bot's own touch, however often it runs.
  presence.acted("click", { pid: 42, window_id: 7, element_index: 1 });
  assert.equal(presence.refusal("type_text", { text: "a" }), personActiveText("type_text"));
});
