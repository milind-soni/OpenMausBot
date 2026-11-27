import { describe, expect, it } from "vitest";
import type { Message } from "../store.ts";
import { recordedWindowState, textEditJournal } from "../testing/saved-steps-fixtures.ts";
import type { SlimResult, SlimStructured, WireElement } from "./driver-wire.ts";
import type { RecordedCall, RequestJournal } from "./journal.ts";
import { buildRecipe, personTextRequest, recipeFitsRequest, stepLabel, type Recipe } from "./rules.ts";

const REQUEST = "Open TextEdit and type hello world";
const build = (journal = textEditJournal(), request = REQUEST) => buildRecipe({ request, journal, id: "r1", now: 1_000 });

const ok: SlimResult = { isError: false };
const action = (tool: string, args: Record<string, unknown>, result: SlimResult = ok): RecordedCall => ({ tool, arguments: args, result, generation: "g1" });
const observation = (tool: string, result: Partial<SlimResult> & { structured?: SlimResult["structured"] }): RecordedCall =>
  ({ tool, arguments: {}, result: { isError: false, ...result }, generation: "g1" });
const CLICK_S1_E2 = action("click", { element_token: "s1-e2" });
const withCall = (call: RecordedCall): RequestJournal => {
  const base = textEditJournal();
  return { ...base, calls: [...base.calls, call] };
};
const snapshotThenClick = ({ refreshBeforeClick, token }: { refreshBeforeClick: boolean; token: string }): RequestJournal => {
  const base = textEditJournal();
  const calls = base.calls.slice(0, 3);
  if (refreshBeforeClick) calls.push(action("get_window_state", { pid: 4242, window_id: 7 }, { isError: false, structured: recordedWindowState(2) }));
  calls.push(action("click", { element_token: token }));
  return { ...base, calls };
};
const observationsOnly = (): RequestJournal => ({ ...textEditJournal(), calls: textEditJournal().calls.slice(0, 3) });
const clicks = (count: number): RequestJournal => ({ ...textEditJournal(), calls: [...textEditJournal().calls.slice(0, 3), ...Array.from({ length: count }, () => CLICK_S1_E2)] });

describe("buildRecipe", () => {
  it("saves the TextEdit run with targets by identity", () => {
    const out = build(); if (!out.ok) throw new Error(out.reason);
    const target = { app: { bundleId: "com.apple.TextEdit", name: "TextEdit" }, window: { title: "Untitled" },
      element: { role: "AXTextArea", label: "Document", path: ["AXScrollArea:"] } };
    expect(out.recipe).toEqual({ id: "r1", key: "open textedit and type hello world", request: REQUEST,
      createdAt: 1_000, lastUsedAt: 1_000, steps: [{ tool: "click", args: {}, ...target }, { tool: "set_value", args: { value: "hello world" }, ...target }] });
    expect(JSON.stringify(out.recipe)).not.toMatch(/s1-e2|4242|"window_id"/);
  });

  it.each<[string, () => unknown]>([
    ["moment-words", () => build(textEditJournal(), "type hello world here")],
    ["incomplete-journal", () => build(textEditJournal({ complete: false }))],
    ["denied", () => build(textEditJournal({ tainted: true }))],
    ["several-turns", () => build(withCall({ ...CLICK_S1_E2, generation: "g2" }))],
    ["tool-error", () => build(withCall(observation("list_windows", { isError: true })))],
    ["tool-error", () => build(withCall(observation("list_windows", { isError: true, rpcError: true })))],
    ["tool-error", () => build(withCall(observation("get_window_state", { isError: false, structured: { refusal: { code: "x" } } })))],
    ["tool-error", () => build(withCall(action("click", { element_token: "s1-e2" }, { isError: false, structured: { refusal: { code: "denied" } } })))],
    ["unknown-tool", () => build(withCall(action("run_steps", {})))],
    ["pixel-or-drag", () => build(withCall(action("click", { x: 10, y: 20 })))],
    ["pixel-or-drag", () => build(withCall(action("drag", {})))],
    ["pixel-or-drag", () => build(withCall(action("browser_click", {})))],
    ["extra-arguments", () => build(withCall(action("launch_app", { name: "TextEdit", additional_arguments: ["--x"] })))],
    ["unknown-target", () => build(withCall(action("click", { element_token: "never-seen" })))],
    ["unknown-target", () => build(withCall(action("set_value", { value: "hello world", pid: 4242 })))],
    ["stale-element", () => build(snapshotThenClick({ refreshBeforeClick: true, token: "s1-e2" }))],
    ["unlabelled-element", () => build(withCall(action("click", { element_token: "s1-e1" })))],
    ["typed-text-not-in-request", () => build(withCall(action("set_value", { element_token: "s1-e2", value: "goodbye" })))],
    ["typing-appends", () => build(withCall(action("type_text", { element_token: "s1-e2", text: "hello world" })))],
    ["url-not-in-request", () => build(withCall(action("launch_app", { name: "Safari", urls: ["https://example.com"] })))],
    ["no-steps", () => build(observationsOnly())],
    ["no-steps", () => build(textEditJournal({ calls: [] }))],
    ["too-many-steps", () => build(clicks(41))],
  ])("refuses: %s", (reason, run) => expect(run()).toEqual({ ok: false, reason }));

  it("saves exactly 40 steps", () => expect(build(clicks(40)).ok).toBe(true));

  it("accepts a launch_app whose URLs are in the request", () => {
    const out = build(textEditJournal({ calls: [action("launch_app", { name: "Safari", urls: ["https://example.com"] })] }), "Open https://example.com in Safari");
    if (!out.ok) throw new Error(out.reason);
    expect(out.recipe.steps).toEqual([{ tool: "launch_app", args: { name: "Safari", urls: ["https://example.com"] } }]);
  });

  it("addresses element_index through the latest snapshot of its window", () => {
    const out = build(withCall(action("click", { element_index: 3, window_id: 7 })));
    if (!out.ok) throw new Error(out.reason);
    expect(out.recipe.steps.at(-1)).toEqual({
      tool: "click", args: {}, app: { bundleId: "com.apple.TextEdit", name: "TextEdit" }, window: { title: "Untitled" },
      element: { role: "AXButton", label: "Save", path: [] },
    });
  });

  const stateCall = (structured: SlimResult["structured"]) => action("get_window_state", { pid: 4242, window_id: 7 }, { isError: false, structured });
  const bare = (calls: RecordedCall[]) => build(textEditJournal({ calls }));
  const noApp = { ...recordedWindowState(1), app_name: undefined, bundle_id: undefined };
  const noTitle = { ...recordedWindowState(1), window_title: undefined };

  it("refuses an element from a snapshot that does not say it read the whole tree", () => {
    const structured = { ...recordedWindowState(1), elements_complete: undefined };
    expect(bare([stateCall(structured), action("click", { element_token: "s1-e2" })])).toEqual({ ok: false, reason: "partial-tree" });
    expect(bare([stateCall(structured), action("bring_to_front", { pid: 4242 })]).ok).toBe(true);
  });

  it("refuses an index with only a pid", () => {
    expect(build(withCall(action("click", { element_index: 3, pid: 4242 })))).toEqual({ ok: false, reason: "unknown-target" });
  });

  it("maps an index to the latest snapshot of its window, not another window's", () => {
    const other = { ...recordedWindowState(1), window_id: 8, window_title: "Other", elements: [{ element_index: 3, element_token: "o-e3", role: "AXButton", label: "Delete", parent_index: 0, depth: 1 }, recordedWindowState(1).elements![0]!] };
    const calls = [...textEditJournal().calls.slice(0, 3), action("get_window_state", { pid: 4242, window_id: 8 }, { isError: false, structured: other }),
      stateCall(recordedWindowState(2)), action("click", { element_index: 3, window_id: 7 })];
    const out = bare(calls);
    expect(out.ok && out.recipe.steps[0]?.element?.label).toBe("Save");
  });

  it("refuses an index after the whole tree was read another way", () => {
    const calls = [...textEditJournal().calls.slice(0, 3), observation("get_accessibility_tree", {}), action("click", { element_index: 3, window_id: 7 })];
    expect(bare(calls)).toEqual({ ok: false, reason: "unknown-target" });
  });

  it("refuses an app with neither bundle id nor name", () => {
    expect(bare([stateCall(noApp), action("click", { element_token: "s1-e2" })])).toEqual({ ok: false, reason: "unknown-target" });
    expect(bare([stateCall(noApp), action("bring_to_front", { pid: 4242 })])).toEqual({ ok: false, reason: "unknown-target" });
  });

  it("refuses an element step whose window has no known title", () => {
    expect(bare([stateCall(noTitle), action("click", { element_token: "s1-e2", window_id: 7 })])).toEqual({ ok: false, reason: "unknown-target" });
  });

  it.each([
    ["hotkey with an element token", action("hotkey", { element_token: "s1-e2", keys: ["cmd", "s"] })],
    ["launch_app with pid and window", action("launch_app", { name: "TextEdit", pid: 4242, window_id: 7 })],
    ["hotkey with a string pid", action("hotkey", { pid: "4242", keys: ["cmd", "s"] })],
    ["hotkey with a string window id", action("hotkey", { pid: 4242, window_id: "7", keys: ["cmd", "s"] })],
  ])("never drops addressing silently: %s", (_name, call) => expect(build(withCall(call))).toEqual({ ok: false, reason: "unknown-target" }));

  it.each([
    ["hotkey", action("hotkey", { keys: ["cmd", "s"], window_id: 7 })],
    ["press_key", action("press_key", { key: "return", window_id: 7 })],
  ])("refuses a %s with a window target but no app", (_name, call) => expect(build(withCall(call))).toEqual({ ok: false, reason: "unknown-target" }));

  it.each(["hello world\n", "\r\n hello world \n\n", " hello world", "hello\tworld"])("refuses typed text with whitespace or control characters %#", (text) => {
    expect(build(withCall(action("set_value", { element_token: "s1-e2", value: text })))).toEqual({ ok: false, reason: "typed-text-not-in-request" });
  });

  it("keeps app and window targets for bring_to_front and window hotkeys", () => {
    const out = build(withCall(action("bring_to_front", { pid: 4242, window_id: 7 })));
    if (!out.ok) throw new Error(out.reason);
    expect(out.recipe.steps.at(-1)).toEqual({ tool: "bring_to_front", args: {}, app: { bundleId: "com.apple.TextEdit", name: "TextEdit" }, window: { title: "Untitled" } });
    const hotkey = build(withCall(action("hotkey", { keys: ["cmd", "s"], pid: 4242, window_id: 7 })));
    expect(hotkey.ok && hotkey.recipe.steps.at(-1)).toEqual({
      tool: "hotkey", args: { keys: ["cmd", "s"] }, app: { bundleId: "com.apple.TextEdit", name: "TextEdit" }, window: { title: "Untitled" } });
    expect(build(withCall(action("bring_to_front", { pid: 4242 }))).ok).toBe(true);
    expect(build(withCall(action("bring_to_front", { pid: 9999 })))).toEqual({ ok: false, reason: "unknown-target" });
  });

  it.each([
    ["hotkey", action("hotkey", { keys: ["cmd", "w"], pid: 4242 })],
    ["press_key", action("press_key", { key: "return", pid: 4242 })],
  ])("refuses a %s sent to an app with no window, which lands in whichever window is in front", (_name, call) => {
    expect(build(withCall(call))).toEqual({ ok: false, reason: "key-without-window" });
  });

  it.each([
    ["hotkey", action("hotkey", { keys: ["cmd", "s"] })],
    ["press_key", action("press_key", { key: "return" })],
  ])("refuses a %s with no app to send it to", (_name, call) => expect(build(withCall(call))).toEqual({ ok: false, reason: "unknown-target" }));

  it.each<[string, Record<string, unknown>]>([
    ["hotkey", { keys: ["cmd", "s"], pid: 4242, window_id: 7 }],
    ["press_key", { key: "return", pid: 4242, window_id: 7 }],
    ["press_key", { key: "return", element_token: "s1-e2" }],
    ["click", { element_token: "s1-e2" }],
  ])("keeps a %s only when it is scoped to its window", (tool, args) => {
    expect(build(withCall(action(tool, { ...args, scope: "desktop" })))).toEqual({ ok: false, reason: "unknown-target" });
    expect(build(withCall(action(tool, { ...args, scope: "screen" })))).toEqual({ ok: false, reason: "unknown-target" });
    const scoped = build(withCall(action(tool, { ...args, scope: "window" })));
    expect(scoped.ok && scoped.recipe.steps.at(-1)?.args.scope).toBe("window");
    const unscoped = build(withCall(action(tool, args)));
    expect(unscoped.ok && unscoped.recipe.steps.at(-1)?.app).toEqual({ bundleId: "com.apple.TextEdit", name: "TextEdit" });
  });

  it("refuses an element whose role, label and path another row of its snapshot shares", () => {
    const rows = recordedWindowState(1).elements!;
    const twin = { ...rows[2]!, element_index: 4, element_token: "s1-e4" };
    expect(bare([stateCall({ ...recordedWindowState(1), elements: [...rows, twin] }), action("click", { element_token: "s1-e2" })]))
      .toEqual({ ok: false, reason: "ambiguous-element" });
    expect(bare([stateCall(recordedWindowState(1)), action("click", { element_token: "s1-e2" })]).ok).toBe(true);
  });

  const TOGGLES = ["AXCheckBox", "AXSwitch", "AXToggle", "AXRadioButton", "AXDisclosureTriangle", "AXMenuItemCheckbox"];
  const withToggle = (role: string) => {
    const rows = recordedWindowState(1).elements!;
    return stateCall({ ...recordedWindowState(1), elements: [...rows, { element_index: 4, element_token: "s1-e4", role, label: "Bold", parent_index: 0, depth: 1 }] });
  };

  it.each(TOGGLES.flatMap((role) => ["click", "double_click", "press_key"].map((tool) => [role, tool])))("refuses a %s that a %s flips", (role, tool) => {
    const args = tool === "press_key" ? { element_token: "s1-e4", key: "space" } : { element_token: "s1-e4" };
    expect(bare([withToggle(role), action(tool, args)])).toEqual({ ok: false, reason: "toggle-element" });
  });

  it("keeps a toggle step that does not flip it", () => {
    expect(bare([withToggle("AXCheckBox"), action("right_click", { element_token: "s1-e4" })]).ok).toBe(true);
    expect(bare([withToggle("AXButton"), action("click", { element_token: "s1-e4" })]).ok).toBe(true);
  });

  it("never lets a later source overwrite a known app field", () => {
    const calls = [...textEditJournal().calls, observation("launch_app", { structured: { pid: 4242, name: "Other", bundle_id: "x.other" } }), action("bring_to_front", { pid: 4242 })];
    const out = build({ ...textEditJournal(), calls });
    expect(out.ok && out.recipe.steps.at(-1)?.app).toEqual({ bundleId: "com.apple.TextEdit", name: "TextEdit" });
  });

  it("saves a launch without its new-copy flag, so a repeat finds the one copy it opened", () => {
    const out = build(textEditJournal({ calls: [action("launch_app", { name: "TextEdit", creates_new_application_instance: true })] }));
    if (!out.ok) throw new Error(out.reason);
    expect(out.recipe.steps).toEqual([{ tool: "launch_app", args: { name: "TextEdit" } }]);
  });

  const row = (index: number, role: string, label: string, more: Partial<WireElement> = {}): WireElement =>
    ({ element_index: index, element_token: `s1-e${index}`, role, label, parent_index: 0, depth: 1, ...more });
  const shown = (rows: WireElement[], extra: Partial<SlimStructured> = {}) =>
    stateCall({ ...recordedWindowState(1), elements: [...recordedWindowState(1).elements!, ...rows], ...extra });
  const LISTED = textEditJournal().calls.slice(0, 2);

  describe("final, can't-undo actions", () => {
    it.each([
      "Send", "Senden", "Envoyer", "Enviar", "Invia", "Wyślij", "Отправить", "Надіслати", "Gönder", "Gửi", "भेजें", "보내기", "送信", "发送", "傳送",
      "Delete", "Löschen", "Supprimer", "Usuń", "Удалить", "Sil", "Xóa", "삭제", "削除", "删除", "Buy now", "Jetzt kaufen", "Acheter", "Kup teraz", "구매하기", "購入",
      "Pay", "Bezahlen", "Pagar", "Оплатить", "Öde", "付款", "Publish", "Publier", "Pubblica", "公開", "Submit", "Absenden", "Place your order",
      "Zahlungspflichtig bestellen", "Sipariş ver", "Đặt hàng", "注文を確定する", "下单", "Transfer", "Überweisen", "Przelej", "转账", "Don’t Save", "Empty Trash",
    ])("never saves a click on %s", (label) => {
      expect(bare([shown([row(4, "AXButton", label)]), action("click", { element_token: "s1-e4" })])).toEqual({ ok: false, reason: "final-action" });
    });

    it.each(["Save a Copy", "Open", "Inbox", "Sent", "Drafts", "Cancel", "OK", "Speichern", "Ouvrir", "확인", "保存"])("still saves a click on %s", (label) => {
      expect(bare([shown([row(4, "AXButton", label)]), action("click", { element_token: "s1-e4" })]).ok).toBe(true);
    });

    it.each([
      ["a double click", "double_click", {}],
      ["a right click", "right_click", {}],
      ["a key pressed on it", "press_key", { key: "space" }],
    ])("never saves %s on a final action either", (_, tool, args) => {
      expect(bare([shown([row(4, "AXButton", "Send")]), action(tool, { element_token: "s1-e4", ...args })])).toEqual({ ok: false, reason: "final-action" });
    });

    it("never saves a click inside a final action's button, nor in a window titled with one", () => {
      const inside = [row(4, "AXButton", "Send message"), row(5, "AXStaticText", "Go", { parent_index: 4, depth: 2 })];
      expect(bare([shown(inside), action("click", { element_token: "s1-e5" })])).toEqual({ ok: false, reason: "final-action" });
      expect(bare([shown([], { window_title: "Confirm your purchase" }), action("click", { element_token: "s1-e3" })])).toEqual({ ok: false, reason: "final-action" });
    });

    it("never saves a pop-up choice that names a final action", () => {
      const menu = shown([row(4, "AXPopUpButton", "Action")]);
      expect(build(textEditJournal({ calls: [menu, action("set_value", { element_token: "s1-e4", value: "Delete" })] }), "choose Delete in Action"))
        .toEqual({ ok: false, reason: "final-action" });
      expect(build(textEditJournal({ calls: [menu, action("set_value", { element_token: "s1-e4", value: "Large" })] }), "choose Large in Action").ok).toBe(true);
    });

    it("never saves opening a link that names a final action", () => {
      const open = (url: string) => build(textEditJournal({ calls: [action("launch_app", { name: "Safari", urls: [url] })] }), `Open ${url} in Safari`);
      expect(open("https://example.com/unsubscribe?u=1")).toEqual({ ok: false, reason: "final-action" });
      expect(open("https://example.com/news").ok).toBe(true);
    });

    it("saves Return pressed into a window read whole that shows no final action", () => {
      expect(build(withCall(action("press_key", { key: "return", pid: 4242, window_id: 7 }))).ok).toBe(true);
    });

    it.each<[string, RecordedCall[]]>([
      ["holds a send button", [...LISTED, shown([row(4, "AXButton", "Send")]), action("press_key", { key: "return", pid: 4242, window_id: 7 })]],
      ["holds one in another language", [...LISTED, shown([row(4, "AXButton", "Отправить")]), action("press_key", { key: "return", element_token: "s1-e2" })]],
      ["shows one only after the key", [...textEditJournal().calls.slice(0, 3), action("press_key", { key: "return", pid: 4242, window_id: 7 }), shown([row(4, "AXButton", "Submit")])]],
      ["was never read", [...LISTED, action("press_key", { key: "return", pid: 4242, window_id: 7 })]],
      ["was read only in part", [...LISTED, shown([], { elements_complete: undefined }), action("press_key", { key: "return", pid: 4242, window_id: 7 })]],
    ])("never saves Return pressed into a window that %s", (_, calls) => {
      expect(bare(calls)).toEqual({ ok: false, reason: "final-action" });
    });

    it.each<[string, Record<string, unknown>]>([
      ["command-Return", { tool: "press_key", key: "return", modifiers: ["cmd"] }],
      ["control-Enter", { tool: "hotkey", keys: ["ctrl", "enter"] }],
      ["Delete", { tool: "press_key", key: "delete" }],
      ["command-Backspace", { tool: "hotkey", keys: ["cmd", "backspace"] }],
    ])("never saves %s, wherever it is pressed", (_, { tool, ...args }) => {
      expect(build(withCall(action(tool as string, { ...args, pid: 4242, window_id: 7 })))).toEqual({ ok: false, reason: "final-action" });
    });
  });

  describe("secret fields", () => {
    const typed = (field: WireElement, value = "hunter2") =>
      build(textEditJournal({ calls: [shown([field]), action("set_value", { element_token: "s1-e4", value })] }), `type ${value} in the field`);

    it("never saves typing into a secure field, so the password is kept nowhere", () => {
      expect(typed(row(4, "AXSecureTextField", "Password", { value_read: true }))).toEqual({ ok: false, reason: "secret-field" });
      expect(typed(row(4, "AXSecureTextField", "Code"))).toEqual({ ok: false, reason: "secret-field" });
      expect(bare([shown([row(4, "AXSecureTextField", "Password")]), action("click", { element_token: "s1-e4" })])).toEqual({ ok: false, reason: "secret-field" });
    });

    it.each(["Password", "Enter your password", "Passwort", "Mot de passe", "Contraseña", "Senha", "Hasło", "Пароль", "Şifre", "Mật khẩu", "पासवर्ड", "비밀번호",
      "パスワード", "密码", "密碼", "PIN", "Card number", "Verification code"])("never saves typing into a field labelled %s", (label) => {
      expect(typed(row(4, "AXTextField", label, { value_read: true }))).toEqual({ ok: false, reason: "secret-field" });
    });

    it("still saves a click on a button whose label only looks like one", () => {
      expect(bare([shown([row(4, "AXButton", "Pin")]), action("click", { element_token: "s1-e4" })]).ok).toBe(true);
    });
  });

  it("never saves typing into a field the driver could not say it read, since a repeat could not tell it is empty", () => {
    const { value_read: _read, ...unread } = recordedWindowState(1).elements![2]!;
    const state = { ...recordedWindowState(1), elements: recordedWindowState(1).elements!.map((element) => (element.element_index === 2 ? unread : element)) };
    expect(bare([stateCall(state), action("set_value", { element_token: "s1-e2", value: "hello world" })])).toEqual({ ok: false, reason: "unreadable-field" });
    expect(build(textEditJournal({ calls: [shown([row(4, "AXPopUpButton", "Size")]), action("set_value", { element_token: "s1-e4", value: "Large" })] }), "set Size to Large").ok)
      .toBe(true);
  });
});

describe("recipeFitsRequest", () => {
  it("checks a recipe's typed text against new words", () => {
    const recipe = (build() as { ok: true; recipe: Recipe }).recipe;
    expect(recipeFitsRequest(recipe, REQUEST)).toBe(true);
    expect(recipeFitsRequest(recipe, "open textedit and type hello, world")).toBe(false);
    for (const text of ["hello world\n", "\r\n hello world \n\n"]) {
      expect(recipeFitsRequest({ ...recipe, steps: [{ tool: "set_value", args: { value: text } }] }, REQUEST)).toBe(false);
    }
  });

  const learned = (request: string, value: string) => {
    const out = build({ ...observationsOnly(), calls: [...observationsOnly().calls, action("set_value", { element_token: "s1-e2", value })] }, request);
    if (!out.ok) throw new Error(out.reason);
    return out.recipe;
  };

  it("stores the request word for word", () => expect(learned("  type   HELLO  ", "HELLO").request).toBe("type HELLO"));

  it.each([
    ["a doubled inner space", "type hello  world", "hello  world"],
    ["full-width letters", "type ＨＥＬＬＯ", "ＨＥＬＬＯ"],
  ])("refuses typed words that the request holds only before evening out %s, so a saved recipe always reads back", (_, request, value) => {
    const journal = { ...observationsOnly(), calls: [...observationsOnly().calls, action("set_value", { element_token: "s1-e2", value })] };
    expect(build(journal, request)).toEqual({ ok: false, reason: "typed-text-not-in-request" });
  });

  it("saves only recipes that fit their own stored request", () => {
    for (const [request, value] of [["type  HELLO   now", "HELLO"], ["type ＨＥＬＬＯ", "HELLO"], ["Type “hi friend”.", "hi friend"]]) {
      const recipe = learned(request!, value!);
      expect(recipeFitsRequest(recipe, recipe.request)).toBe(true);
    }
  });

  it.each([
    ["a sign", "set the offset field to 5", "5", "set the offset field to -5"],
    ["a dropped filler", "type call me", "call me", "type call me now"],
    ["a filler added", "type call me", "call me", "please type call me"],
    ["case", "type HELLO", "HELLO", "type hello"],
    ["punctuation", "type hello world", "hello world", "type hello world!"],
  ])("repeats typed words only for the exact request, not one differing by %s", (_, request, value, other) => {
    const recipe = learned(request, value);
    expect(recipeFitsRequest(recipe, request)).toBe(true);
    expect(recipeFitsRequest(recipe, ` ${request.replace(/ /g, "  ")} `)).toBe(true);
    expect(recipeFitsRequest(recipe, other)).toBe(false);
  });

  it("repeats a link only for the exact request", () => {
    const out = build(textEditJournal({ calls: [action("launch_app", { name: "Safari", urls: ["https://example.com"] })] }), "Open https://example.com in Safari");
    if (!out.ok) throw new Error(out.reason);
    expect(recipeFitsRequest(out.recipe, "Open https://example.com in Safari")).toBe(true);
    expect(recipeFitsRequest(out.recipe, "open https://example.com in safari")).toBe(false);
  });

  it("lets clicks alone repeat for the same key", () => {
    const recipe = (build(clicks(1)) as { ok: true; recipe: Recipe }).recipe;
    expect(recipeFitsRequest(recipe, "please OPEN TextEdit and type hello world.")).toBe(true);
  });
});

describe("personTextRequest", () => {
  it.each<[Record<string, unknown>, boolean]>([
    [{}, true], [{ via: "call" }, false], [{ relayed: true }, false], [{ replyToId: "m0" }, false], [{ dataContext: { cardId: "c" } }, false],
    [{ fromApp: {} }, false], [{ pointed: [] }, false], [{ peerAsk: {} }, false], [{ setupRequest: true }, false], [{ steered: true }, false],
    [{ aside: true }, false], [{ reaction: "x" }, false], [{ text: "  " }, false],
    [{ attachments: [{ kind: "file", path: "/a", mime: "text/plain", name: "a" }] }, false], [{ text: 'see <attached-image path="/a.png" />' }, false],
  ])("person text request %#", (extra, expected) =>
    expect(personTextRequest({ id: "u1", at: 1, role: "user", kind: "text", text: REQUEST, ...extra } as Message)).toBe(expected));
});

describe("stepLabel", () => {
  it("names the element, the window, the app or the screen", () => {
    const app = { bundleId: "com.apple.TextEdit", name: "TextEdit" };
    expect(stepLabel({ tool: "click", args: {}, app, element: { role: "AXButton", label: "Save", path: [] } })).toBe('"Save" in TextEdit');
    expect(stepLabel({ tool: "hotkey", args: {}, app: { bundleId: "b.id" }, element: { role: "AXButton", label: "Save", path: [] } })).toBe('"Save" in b.id');
    expect(stepLabel({ tool: "hotkey", args: {}, app, window: { title: "Untitled" } })).toBe("Untitled");
    expect(stepLabel({ tool: "bring_to_front", args: {}, app })).toBe("TextEdit");
    expect(stepLabel({ tool: "launch_app", args: { bundle_id: "com.x" } })).toBe("com.x");
    expect(stepLabel({ tool: "launch_app", args: { name: "Safari" } })).toBe("Safari");
    expect(stepLabel({ tool: "hotkey", args: {} })).toBe("the screen");
  });
});
