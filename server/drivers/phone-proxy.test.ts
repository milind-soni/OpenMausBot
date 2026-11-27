import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PHONE_STEP_TOOLS } from "../../shared/phone-steps.ts";
import { createPhoneHold } from "../phone-screen/hold.ts";
import { createPhoneGate } from "../routes/phone-gate.ts";
import { TurnResources } from "../turn-resources.ts";
import { TOOLS, callPhoneTool, createPhoneClaim, findPackages, launchTarget, parseDevices, parseLaunchablePackages, parseSteps, parseUiNodes, runSteps, typePhoneText, type PhoneStep } from "./phone-proxy.ts";

describe("phone MCP parsing", () => {
  it("keeps physical USB devices distinguishable from network and emulator transports", () => {
    expect(parseDevices(`List of devices attached
USB123 device product:husky model:Pixel_8 usb:1-2 transport_id:4
emulator-5554 device product:sdk model:Emulator transport_id:6
192.0.2.4:5555 device product:remote model:Remote transport_id:7
`)).toEqual([
      { serial: "USB123", state: "device", connection: "usb", model: "Pixel 8" },
      { serial: "emulator-5554", state: "device", connection: "emulator", model: "Emulator" },
      { serial: "192.0.2.4:5555", state: "device", connection: "network", model: "Remote" },
    ]);
  });

  it("extracts unique launchable packages", () => {
    expect(parseLaunchablePackages(`2 activities found:
      com.ubercab/.presidio.RootActivity
      net.skyscanner.android.main/net.skyscanner.shell.SplashActivity
      com.ubercab/.presidio.RootActivity
    `)).toEqual(["com.ubercab", "net.skyscanner.android.main"]);
  });

  it("resolves common human app names before using package-name heuristics", () => {
    const packages = ["com.ubercab", "net.skyscanner.android.main", "com.example.other"];
    expect(findPackages("Uber", packages)).toEqual(["com.ubercab"]);
    expect(findPackages("Skyscanner", packages)).toEqual(["net.skyscanner.android.main"]);
  });

  it("tells the bot to pass a package name when no app name matches", () => {
    const packages = ["com.taobao.idlefish", "com.ubercab"];
    expect(() => launchTarget("闲鱼", packages)).toThrow("call list_apps without a query and pass the package name");
    expect(launchTarget("com.taobao.idlefish", packages)).toBe("com.taobao.idlefish");
  });

  it("keeps naming the candidates when an app name is ambiguous", () => {
    expect(() => launchTarget("taobao", ["com.taobao.idlefish", "com.taobao.taobao"])).toThrow("App name is ambiguous: com.taobao.idlefish, com.taobao.taobao");
  });

  it("offers keys that turn the screen on and off", () => {
    const press = TOOLS.find((tool) => tool.name === "press") as { inputSchema: { properties: { key: { enum: string[] } } } } | undefined;
    expect(press?.inputSchema.properties.key.enum).toEqual(expect.arrayContaining(["wakeup", "sleep"]));
  });

  it("turns Android UI XML into tap-ready visible nodes", () => {
    expect(parseUiNodes(`<?xml version="1.0"?><hierarchy><node text="Where to?" resource-id="com.ubercab:id/input" class="android.widget.TextView" content-desc="Destination" bounds="[12,100][400,180]" /></hierarchy>`)).toEqual([
      { text: "Where to?", description: "Destination", id: "com.ubercab:id/input", className: "android.widget.TextView", bounds: [12, 100, 400, 180] },
    ]);
  });
});

// Lines cut, in their order, from five `dumpsys input_method` outputs of a Huawei Mate 9 (Android 9). Three are from a switch from the Baidu keyboard to ADBKeyBoard with a search
// field taking input: before `ime set`, right after it (ADBKeyBoard is not bound yet, so the dump has no section for it) and once it shows. The fourth is the home screen with ADBKeyBoard as the keyboard.
// The fifth is 0.3 s after a tap on a search field, with the Baidu keyboard not up yet.
const BEFORE_THE_SWITCH = [
  "  mCurMethodId=com.baidu.input_huawei/.ImeService",
  "  mCurId=com.baidu.input_huawei/.ImeService mHaveConnect=true mBoundToMethod=true",
  "  mShowRequested=true mShowExplicitlyRequested=false mShowForced=false mInputShown=true",
  "  mServedInputConnectionWrapper=ControlledInputConnectionWrapper{connection=com.android.internal.widget.EditableInputConnection@c49480f finished=false mParentInputMethodManager.mActive=true}",
  "Input method service state for com.baidu.input_huawei.ImeService@ca25e11:",
  "  mWindowCreated=true mWindowAdded=true",
  "  mWindowVisible=true mWindowWasVisible=true mInShowWindow=false",
  "  mExtractedToken=0",
  "  mIsInputViewShown=true mStatusIcon=0",
  "Last computed insets:",
  "",
].join("\n");
const SWITCHED_BUT_NOT_BOUND = [
  "  mCurMethodId=com.android.adbkeyboard/.AdbIME",
  "  mCurId=com.android.adbkeyboard/.AdbIME mHaveConnect=true mBoundToMethod=false",
  "  mShowRequested=true mShowExplicitlyRequested=false mShowForced=false mInputShown=true",
  "  mServedInputConnectionWrapper=ControlledInputConnectionWrapper{connection=com.android.internal.widget.EditableInputConnection@9c2709c finished=false mParentInputMethodManager.mActive=true}",
  "",
].join("\n");
const SWITCHED_AND_SHOWN = [
  "  mCurMethodId=com.android.adbkeyboard/.AdbIME",
  "  mCurId=com.android.adbkeyboard/.AdbIME mHaveConnect=true mBoundToMethod=true",
  "  mShowRequested=true mShowExplicitlyRequested=false mShowForced=false mInputShown=true",
  "  mServedInputConnectionWrapper=ControlledInputConnectionWrapper{connection=com.android.internal.widget.EditableInputConnection@9c2709c finished=false mParentInputMethodManager.mActive=true}",
  "Input method service state for com.android.adbkeyboard.AdbIME@a07f2f1:",
  "  mWindowCreated=true mWindowAdded=true",
  "  mWindowVisible=true mWindowWasVisible=true mInShowWindow=false",
  "  mExtractedToken=0",
  "  mIsInputViewShown=true mStatusIcon=0",
  "Last computed insets:",
  "",
].join("\n");
const AFTER_A_TAP = [
  "  mCurMethodId=com.baidu.input_huawei/.ImeService",
  "  mCurId=com.baidu.input_huawei/.ImeService mHaveConnect=true mBoundToMethod=true",
  "  mShowRequested=false mShowExplicitlyRequested=false mShowForced=false mInputShown=false",
  "  mServedInputConnectionWrapper=ControlledInputConnectionWrapper{connection=com.android.internal.widget.EditableInputConnection@bddcaea finished=false mParentInputMethodManager.mActive=true}",
  "Input method service state for com.baidu.input_huawei.ImeService@31a5ebb:",
  "  mWindowCreated=true mWindowAdded=true",
  "  mWindowVisible=true mWindowWasVisible=true mInShowWindow=false",
  "  mExtractedToken=0",
  "  mIsInputViewShown=true mStatusIcon=0",
  "Last computed insets:",
  "",
].join("\n");
const ON_THE_HOME_SCREEN = [
  "  mCurMethodId=com.android.adbkeyboard/.AdbIME",
  "  mCurId=com.android.adbkeyboard/.AdbIME mHaveConnect=true mBoundToMethod=true",
  "  mShowRequested=false mShowExplicitlyRequested=false mShowForced=false mInputShown=false",
  "  mServedInputConnectionWrapper=null",
  "Input method service state for com.android.adbkeyboard.AdbIME@3f66c6f:",
  "  mWindowCreated=false mWindowAdded=false",
  "  mWindowVisible=false mWindowWasVisible=false mInShowWindow=false",
  "  mExtractedToken=0",
  "  mIsInputViewShown=false mStatusIcon=0",
  "Last computed insets:",
  "",
].join("\n");

describe("phone MCP text input", () => {
  const ADB_KEYBOARD = "com.android.adbkeyboard/.AdbIME";
  const VENDOR_KEYBOARD = "com.baidu.input_huawei/.ImeService";
  const SENT = "Sent the text to ADBKeyBoard. Use read_screen to check that it reached the field.";
  // From `dumpsys input_method` on a Huawei Mate 9 (Android 9): an app with a text field taking input, and the home screen.
  const FIELD = [
    "  mServedConnecting=false",
    "  mCurrentTextBoxAttribute:",
    "    inputType=0x90001 imeOptions=0x3 privateImeOptions=null",
    "    actionLabel=null actionId=0",
    "  mServedInputConnectionWrapper=ControlledInputConnectionWrapper{connection=com.android.internal.widget.EditableInputConnection@c54836f finished=false mParentInputMethodManager.mActive=true}",
    "  mCompletions=null",
    "",
  ].join("\n");
  const NO_FIELD = [
    "  mServedConnecting=false",
    "  mCurrentTextBoxAttribute:",
    "    inputType=0x0 imeOptions=0x0 privateImeOptions=null",
    "    actionLabel=null actionId=0",
    "  mServedInputConnectionWrapper=null",
    "  mCompletions=null",
    "",
  ].join("\n");
  // Android 13 and later print the same value under this name, followed by its handler.
  const NO_FIELD_13 = "  mServedInputConnection=null\n  mServedInputConnectionHandler=null\n";
  /** A phone whose default keyboard is `keyboard`, the only one switched on in its keyboard list. */
  const device = (keyboard: string, inputState = FIELD) => {
    const commands: string[][] = [];
    const shell = async (...command: string[]) => {
      commands.push(command);
      return command[0] === "settings" || command[1] === "list" ? `${keyboard}\n` : command[0] === "dumpsys" ? inputState : "";
    };
    return { commands, shell };
  };

  it.each([ADB_KEYBOARD, VENDOR_KEYBOARD])("types basic ASCII with Android input whatever the keyboard (%s)", async (keyboard) => {
    const phone = device(keyboard);
    await expect(typePhoneText(phone.shell, "iPad mini_6")).resolves.toBe("Typed text into the focused Android field");
    expect(phone.commands).toEqual([["input", "text", "iPad%smini_6"]]);
  });

  it("types any other text through ADBKeyBoard as Base64 UTF-8", async () => {
    const phone = device(ADB_KEYBOARD);
    await expect(typePhoneText(phone.shell, "二手 iPad +86 😀")).resolves.toBe(SENT);
    expect(phone.commands).toEqual([
      ["settings", "get", "secure", "default_input_method"],
      ["am", "broadcast", "-a", "ADB_INPUT_B64", "-p", "com.android.adbkeyboard", "--es", "msg", "5LqM5omLIGlQYWQgKzg2IPCfmIA="],
    ]);
  });

  it.each(["二".repeat(256), "😀".repeat(256)])("types up to 256 characters of other text, counting each emoji once", async (text) => {
    const phone = device(ADB_KEYBOARD);
    await expect(typePhoneText(phone.shell, text)).resolves.toBe(SENT);
    expect(phone.commands.map((command) => command[0])).toEqual(["settings", "am"]);
  });

  it.each(["iPad", "二手"])("reports a failed adb command instead of claiming it typed (%s)", async (text) => {
    const shell = async (...command: string[]) => {
      if (command[0] === "settings") return `${ADB_KEYBOARD}\n`;
      throw new Error("error: closed");
    };
    await expect(typePhoneText(shell, text)).rejects.toThrow("error: closed");
  });

  it("asks for ADBKeyBoard and types nothing when it is not switched on in the phone's keyboard list", async () => {
    const phone = device(VENDOR_KEYBOARD);
    await expect(typePhoneText(phone.shell, "二手 iPad")).rejects.toThrow("Only letters, digits, spaces and _.,@- can be typed until ADBKeyBoard (https://github.com/senzhk/ADBKeyBoard) is installed and switched on in the phone's keyboard list");
    expect(phone.commands).toEqual([["settings", "get", "secure", "default_input_method"], ["ime", "list", "-s"]]);
  });

  const CLEAR = ["am", "broadcast", "-a", "ADB_CLEAR_TEXT", "-p", "com.android.adbkeyboard"];

  it.each([["二手 iPad", "5LqM5omLIGlQYWQ="], ["iPad mini_6", "aVBhZCBtaW5pXzY="]])("clears the field through ADBKeyBoard, then sends the text the same way (%s)", async (text, base64) => {
    const phone = device(ADB_KEYBOARD);
    await expect(typePhoneText(phone.shell, text, true)).resolves.toBe("Asked ADBKeyBoard to clear the field and sent the text. Use read_screen to check that the field holds only this text.");
    expect(phone.commands).toEqual([
      ["settings", "get", "secure", "default_input_method"],
      ["dumpsys", "input_method"],
      CLEAR,
      ["am", "broadcast", "-a", "ADB_INPUT_B64", "-p", "com.android.adbkeyboard", "--es", "msg", base64],
    ]);
  });

  it.each([
    ["the home screen", NO_FIELD],
    ["the name Android 13 prints", NO_FIELD_13],
    ["the first app listed when a second one follows", NO_FIELD + FIELD],
  ])("clears nothing and types nothing when no field is taking input (%s)", async (_state, dump) => {
    const phone = device(ADB_KEYBOARD, dump);
    await expect(typePhoneText(phone.shell, "二手", true)).rejects.toThrow("No text field is taking input, so nothing was cleared or typed. Tap the field first, then call type_text again.");
    expect(phone.commands).toEqual([["settings", "get", "secure", "default_input_method"], ["dumpsys", "input_method"]]);
  });

  it("goes by the first app listed when a second one has no field", async () => {
    const phone = device(ADB_KEYBOARD, FIELD + NO_FIELD);
    await expect(typePhoneText(phone.shell, "二手", true)).resolves.toContain("Asked ADBKeyBoard to clear the field");
    expect(phone.commands.map((command) => command[3])).toEqual(["default_input_method", undefined, "ADB_CLEAR_TEXT", "ADB_INPUT_B64"]);
  });

  it("clears nothing and types nothing when the input state cannot be read", async () => {
    const commands: string[][] = [];
    const shell = async (...command: string[]) => {
      commands.push(command);
      if (command[0] === "settings") return `${ADB_KEYBOARD}\n`;
      throw new Error("error: closed");
    };
    await expect(typePhoneText(shell, "二手", true)).rejects.toThrow("error: closed");
    expect(commands).toEqual([["settings", "get", "secure", "default_input_method"], ["dumpsys", "input_method"]]);
  });

  it("still clears on a phone whose dump does not say", async () => {
    const phone = device(ADB_KEYBOARD, "");
    await expect(typePhoneText(phone.shell, "二手", true)).resolves.toContain("Asked ADBKeyBoard to clear the field");
    expect(phone.commands.map((command) => command[3])).toEqual(["default_input_method", undefined, "ADB_CLEAR_TEXT", "ADB_INPUT_B64"]);
  });

  it.each(["二手 iPad", "iPad"])("asks for ADBKeyBoard and neither clears nor types when it is not switched on in the phone's keyboard list (%s)", async (text) => {
    const phone = device(VENDOR_KEYBOARD);
    const refused = typePhoneText(phone.shell, text, true);
    await expect(refused).rejects.toThrow("A field can be cleared only when ADBKeyBoard (https://github.com/senzhk/ADBKeyBoard) is installed and switched on in the phone's keyboard list");
    await expect(refused).rejects.toThrow("call type_text without clear and remove the old text with press delete");
    expect(phone.commands).toEqual([["settings", "get", "secure", "default_input_method"], ["ime", "list", "-s"]]);
  });

  it("sends no text after a clear that failed", async () => {
    const commands: string[][] = [];
    const shell = async (...command: string[]) => {
      commands.push(command);
      if (command[0] === "settings") return `${ADB_KEYBOARD}\n`;
      if (command[0] === "dumpsys") return FIELD;
      throw new Error("error: closed");
    };
    await expect(typePhoneText(shell, "二手", true)).rejects.toThrow("error: closed");
    expect(commands).toEqual([["settings", "get", "secure", "default_input_method"], ["dumpsys", "input_method"], CLEAR]);
  });

  it("offers clear as an optional plain boolean beside the text", () => {
    const schema = TOOLS.find((tool) => tool.name === "type_text")?.inputSchema;
    expect(schema?.properties).toMatchObject({ clear: { type: "boolean" } });
    expect(schema?.required).toEqual(["text"]);
  });

  it.each(["", "a".repeat(257), "😀".repeat(257)])("refuses empty or over-long text without touching the phone", async (text) => {
    for (const clear of [false, true]) {
      const phone = device(ADB_KEYBOARD);
      await expect(typePhoneText(phone.shell, text, clear)).rejects.toThrow("Android text must be 1 to 256 characters");
      expect(phone.commands).toEqual([]);
    }
  });

  describe("with another keyboard as the default", () => {
    const KEYBOARD = ["settings", "get", "secure", "default_input_method"];
    const KEYBOARDS = ["ime", "list", "-s"];
    const SWITCH = ["ime", "set", ADB_KEYBOARD];
    const INPUT_STATE = ["dumpsys", "input_method"];
    const INPUT = ["am", "broadcast", "-a", "ADB_INPUT_B64", "-p", "com.android.adbkeyboard", "--es", "msg", "5LqM5omLIGlQYWQ="];
    const RESTORE = ["ime", "set", VENDOR_KEYBOARD];
    /** A phone whose keyboard list holds `switchedOn`, and whose input state reads as each of `dumps` in turn, then as the last of them. */
    const switching = (dumps: string[], keyboard = VENDOR_KEYBOARD, switchedOn = [VENDOR_KEYBOARD, ADB_KEYBOARD]) => {
      const phone = device(keyboard);
      let reads = 0;
      const shell = async (...command: string[]) => {
        const reply = await phone.shell(...command);
        if (command[0] === "dumpsys") return dumps[Math.min(reads++, dumps.length - 1)];
        return command[1] === "list" ? `${switchedOn.join("\n")}\n` : reply;
      };
      return { commands: phone.commands, shell };
    };

    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it.each([
      { clear: false, sends: [INPUT], says: SENT },
      { clear: true, sends: [INPUT_STATE, CLEAR, INPUT], says: "Asked ADBKeyBoard to clear the field and sent the text. Use read_screen to check that the field holds only this text." },
    ])("switches to ADBKeyBoard to type, then back to the person's keyboard (clear: $clear)", async ({ clear, sends, says }) => {
      const phone = switching([BEFORE_THE_SWITCH, SWITCHED_AND_SHOWN]);
      await expect(typePhoneText(phone.shell, "二手 iPad", clear)).resolves.toBe(says);
      expect(phone.commands).toEqual([KEYBOARD, KEYBOARDS, INPUT_STATE, SWITCH, INPUT_STATE, ...sends, RESTORE]);
    });

    it.each([
      ["ADBKeyBoard is not in the phone's keyboard list", VENDOR_KEYBOARD, [VENDOR_KEYBOARD]],
      ["the default keyboard is not in that list", "com.example.keys/.Ime", [VENDOR_KEYBOARD, ADB_KEYBOARD]],
      ["the default keyboard is not in that list and its id would run a command in the phone's shell", "a/b;reboot", [VENDOR_KEYBOARD, ADB_KEYBOARD]],
      ["the phone's shell would not read the default keyboard's id as written", "com.x/.Ime$Inner", ["com.x/.Ime$Inner", ADB_KEYBOARD]],
      ["the phone's shell would not read the package name in the default keyboard's id as written", "com.x$y/.Ime", ["com.x$y/.Ime", ADB_KEYBOARD]],
    ])("asks for ADBKeyBoard and switches nothing when %s", async (_case, keyboard, switchedOn) => {
      const phone = switching([SWITCHED_AND_SHOWN], keyboard, switchedOn);
      await expect(typePhoneText(phone.shell, "二手 iPad")).rejects.toThrow(new Error("Only letters, digits, spaces and _.,@- can be typed until ADBKeyBoard (https://github.com/senzhk/ADBKeyBoard) is installed and switched on in the phone's keyboard list. Ask the person to set it up, or type only those characters."));
      expect(phone.commands).toEqual([KEYBOARD, KEYBOARDS]);
    });

    it("reads the input state again 200 ms later while ADBKeyBoard is not bound, and types once it shows", async () => {
      const phone = switching([BEFORE_THE_SWITCH, SWITCHED_BUT_NOT_BOUND, SWITCHED_AND_SHOWN]);
      const typed = typePhoneText(phone.shell, "二手 iPad");
      await vi.advanceTimersByTimeAsync(199);
      expect(phone.commands).toEqual([KEYBOARD, KEYBOARDS, INPUT_STATE, SWITCH, INPUT_STATE]);
      await vi.advanceTimersByTimeAsync(1);
      await expect(typed).resolves.toBe(SENT);
      expect(phone.commands).toEqual([KEYBOARD, KEYBOARDS, INPUT_STATE, SWITCH, INPUT_STATE, INPUT_STATE, INPUT, RESTORE]);
    });

    it("switches only once the tapped field's keyboard is up, reading the input state again 200 ms later", async () => {
      const phone = switching([AFTER_A_TAP, BEFORE_THE_SWITCH, SWITCHED_AND_SHOWN]);
      const typed = typePhoneText(phone.shell, "二手 iPad");
      await vi.advanceTimersByTimeAsync(199);
      expect(phone.commands).toEqual([KEYBOARD, KEYBOARDS, INPUT_STATE]);
      await vi.advanceTimersByTimeAsync(1);
      await expect(typed).resolves.toBe(SENT);
      expect(phone.commands).toEqual([KEYBOARD, KEYBOARDS, INPUT_STATE, INPUT_STATE, SWITCH, INPUT_STATE, INPUT, RESTORE]);
    });

    it("neither clears, types nor switches when at the tenth read, 1.8 s after the first, no keyboard is up", async () => {
      const phone = switching([AFTER_A_TAP]);
      const refused = expect(typePhoneText(phone.shell, "二手 iPad", true)).rejects.toThrow(new Error("No text field is taking input, so nothing was cleared or typed. Tap the field first, then call type_text again."));
      await vi.advanceTimersByTimeAsync(1_799);
      expect(phone.commands).toEqual([KEYBOARD, KEYBOARDS, ...Array(9).fill(INPUT_STATE)]);
      await vi.advanceTimersByTimeAsync(1);
      await refused;
      expect(phone.commands).toEqual([KEYBOARD, KEYBOARDS, ...Array(10).fill(INPUT_STATE)]);
    });

    it("does not hold the switch back on a phone whose dump does not say whether a keyboard is up", async () => {
      const phone = switching(["", SWITCHED_AND_SHOWN]);
      const typed = typePhoneText(phone.shell, "二手 iPad");
      await vi.advanceTimersByTimeAsync(0);
      expect(phone.commands).toEqual([KEYBOARD, KEYBOARDS, INPUT_STATE, SWITCH, INPUT_STATE, INPUT, RESTORE]);
      await expect(typed).resolves.toBe(SENT);
    });

    it("still types when ADBKeyBoard shows only at the tenth read, 1.8 s after the first", async () => {
      const phone = switching([BEFORE_THE_SWITCH, ...Array(9).fill(SWITCHED_BUT_NOT_BOUND), SWITCHED_AND_SHOWN]);
      const typed = typePhoneText(phone.shell, "二手 iPad");
      await vi.advanceTimersByTimeAsync(1_799);
      expect(phone.commands).toEqual([KEYBOARD, KEYBOARDS, INPUT_STATE, SWITCH, ...Array(9).fill(INPUT_STATE)]);
      await vi.advanceTimersByTimeAsync(1);
      await expect(typed).resolves.toBe(SENT);
      expect(phone.commands).toEqual([KEYBOARD, KEYBOARDS, INPUT_STATE, SWITCH, ...Array(10).fill(INPUT_STATE), INPUT, RESTORE]);
    });

    const MADE_UP_DUMP_WITH_A_LATER_SECTION = [
      "Input method service state for com.android.adbkeyboard.AdbIME@a:",
      "Input method service state for com.baidu.input_huawei.ImeService@b:",
      "  mIsInputViewShown=true",
      "",
    ].join("\n");

    it.each([
      ["is not bound", SWITCHED_BUT_NOT_BOUND],
      ["does not show, as on the home screen", ON_THE_HOME_SCREEN],
      ["has not taken over, though the other keyboard shows", BEFORE_THE_SWITCH],
      ["does not show in its own section, though another keyboard's section after it does (a made-up dump: no phone has printed one)", MADE_UP_DUMP_WITH_A_LATER_SECTION],
    ])("types nothing and switches back when at the tenth read, 1.8 s after the switch, ADBKeyBoard still %s", async (_state, dump) => {
      const phone = switching([BEFORE_THE_SWITCH, dump]);
      const refused = expect(typePhoneText(phone.shell, "二手 iPad")).rejects.toThrow(new Error("No text field is taking input, so nothing was cleared or typed. Tap the field first, then call type_text again."));
      await vi.advanceTimersByTimeAsync(1_799);
      expect(phone.commands).toEqual([KEYBOARD, KEYBOARDS, INPUT_STATE, SWITCH, ...Array(9).fill(INPUT_STATE)]);
      await vi.advanceTimersByTimeAsync(1);
      await refused;
      expect(phone.commands).toEqual([KEYBOARD, KEYBOARDS, INPUT_STATE, SWITCH, ...Array(10).fill(INPUT_STATE), RESTORE]);
    });
  });
});

describe("phone MCP lazy claim gate", () => {
  const harnessEnv = { OMB_HARNESS_URL: "http://127.0.0.1:8799", OMB_PHONE_TOKEN: "tok" };
  const stub = (handler: (request: Request) => Promise<{ ok: boolean; status: number }>) => {
    const calls: Request[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = new Request(input, init);
      calls.push(request);
      return handler(request);
    }) as typeof fetch;
    return { calls, fetchImpl };
  };

  it("proceeds without a harness when the proxy runs standalone", async () => {
    const { calls, fetchImpl } = stub(async () => ({ ok: true, status: 200 }));
    const ensure = createPhoneClaim({}, fetchImpl);
    await expect(ensure()).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(0);
  });

  it("claims lazily and revalidates ownership on every call", async () => {
    const { calls, fetchImpl } = stub(async () => ({ ok: true, status: 200 }));
    const ensure = createPhoneClaim(harnessEnv, fetchImpl);
    expect(calls).toHaveLength(0);
    await expect(ensure()).resolves.toEqual({ ok: true });
    await expect(ensure()).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(calls[0].headers.get("authorization")).toBe("Bearer tok");
  });

  it("tells the harness which claim comes from the middle of a call", async () => {
    const { calls, fetchImpl } = stub(async () => ({ ok: true, status: 200 }));
    const ensure = createPhoneClaim(harnessEnv, fetchImpl);
    await ensure();
    await ensure(true);
    expect(await Promise.all(calls.map((call) => call.json()))).toEqual([{}, { wait: false }]);
  });

  it.each([401, 403, 409])("rejects a previously successful caller after ownership is lost (%s)", async (status) => {
    let active = true;
    const { calls, fetchImpl } = stub(async () => active ? { ok: true, status: 200 } : { ok: false, status });
    const ensure = createPhoneClaim(harnessEnv, fetchImpl);
    await expect(ensure()).resolves.toEqual({ ok: true });
    active = false;
    await expect(ensure()).resolves.toMatchObject({ ok: false });
    expect(calls).toHaveLength(2);
  });

  it("returns the blocked text on conflict and retries on a later call", async () => {
    let busy = true;
    const { calls, fetchImpl } = stub(async () => (busy ? { ok: false, status: 409 } : { ok: true, status: 200 }));
    const ensure = createPhoneClaim(harnessEnv, fetchImpl);
    const first = await ensure();
    expect(first).toEqual({ ok: false, message: "Another thread is using the phone. This call was not performed. Pause phone work until that thread finishes, then read the screen again before acting." });
    busy = false;
    await expect(ensure()).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it("names the ended turn when the capability is gone and stays honest on transport failure", async () => {
    let reject = false;
    const { fetchImpl } = stub(async () => (reject
      ? Promise.reject(new Error("fetch failed"))
      : Promise.resolve({ ok: false, status: 401 })));
    const ensure = createPhoneClaim(harnessEnv, fetchImpl);
    await expect(ensure()).resolves.toEqual({ ok: false, message: "This turn no longer has phone access. Start a new turn to use the phone." });
    reject = true;
    await expect(ensure()).resolves.toMatchObject({ ok: false, message: expect.stringContaining("could not be reached") });
  });
});

const SCREEN = '0: "Search" bounds=0,100,200,180 class=android.widget.TextView';
const EARLIER_AND_LATER = "Steps before it were done; do not repeat them. Later steps were not performed.";

describe("phone batch step parsing", () => {
  it.each([
    { case: "coerces named fields", raw: [{ action: "Tap", x: "540", y: 1200 }], steps: [{ action: "tap", x: 540, y: 1200 }] },
    { case: "keeps a numeric code a string", raw: [{ action: "type_text", text: "10001" }, { action: "type_text", text: 10001 }], steps: [{ action: "type_text", text: "10001" }, { action: "type_text", text: "10001" }] },
    { case: "coerces a match index and exact", raw: [{ action: "tap_text", text: "Search", index: "1", exact: "true" }, { action: "tap_text", text: "Search", exact: "false" }], steps: [{ action: "tap_text", text: "Search", index: 1, exact: true }, { action: "tap_text", text: "Search", exact: false }] },
    { case: "treats null and empty fields as absent", raw: [{ action: "tap_text", text: "Search", index: null, exact: "", seconds: null }, { action: "wait", seconds: "" }], steps: [{ action: "tap_text", text: "Search" }, { action: "wait" }] },
    { case: "lowercases action, key and direction", raw: [{ action: "PRESS", key: "Enter" }, { action: "swipe", direction: "UP" }], steps: [{ action: "press", key: "enter" }, { action: "swipe", direction: "up" }] },
    { case: "ignores fields no action takes", raw: [{ action: "read_screen", verify: true }, { action: "open_app", name: "Settings", why: "check" }], steps: [{ action: "read_screen" }, { action: "open_app", name: "Settings" }] },
    { case: "parses steps given as JSON text", raw: '[{"action":"read_screen"}]', steps: [{ action: "read_screen" }] },
    { case: "parses a step given as JSON text", raw: ['{"action":"press","key":"back"}'], steps: [{ action: "press", key: "back" }] },
    { case: "accepts waits from 0 and above 60", raw: [{ action: "wait" }, { action: "wait", seconds: 0 }, { action: "wait", seconds: "75" }], steps: [{ action: "wait" }, { action: "wait", seconds: 0 }, { action: "wait", seconds: 75 }] },
    { case: "accepts 10 steps", raw: Array(10).fill({ action: "read_screen" }), steps: Array(10).fill({ action: "read_screen" }) },
    { case: "coerces both coordinates", raw: [{ action: "tap", x: "540", y: "1200" }], steps: [{ action: "tap", x: 540, y: 1200 }] },
    { case: "counts text to type in characters, as type_text does", raw: [{ action: "type_text", text: "😀".repeat(256) }], steps: [{ action: "type_text", text: "😀".repeat(256) }] },
    { case: "treats a null or empty serial on a step as absent", raw: [{ action: "read_screen", serial: null }, { action: "read_screen", serial: "" }], steps: [{ action: "read_screen" }, { action: "read_screen" }] },
    { case: "coerces clear on text to type", raw: [{ action: "type_text", text: "x", clear: true }, { action: "type_text", text: "x", clear: "true" }], steps: [{ action: "type_text", text: "x", clear: true }, { action: "type_text", text: "x", clear: true }] },
    { case: "ignores fields named like an object's built-ins", raw: '[{"action":"read_screen","constructor":"x","toString":"y","__proto__":{"action":"tap"}}]', steps: [{ action: "read_screen" }] },
  ])("$case", ({ raw, steps }) => {
    expect(parseSteps(raw)).toEqual(steps);
  });

  it.each([
    { case: "a wait field on another action", raw: [{ action: "tap", x: 1, y: 2, seconds: 5 }], error: 'Step 1 (tap) does not take seconds; put a separate {"action":"wait","seconds":5} step after it. No step was performed.' },
    { case: "a field of another action", raw: [{ action: "tap", x: 1, y: 2, text: "Go" }], error: 'Step 1 (tap) does not take text, which belongs to tap_text or type_text; write it like {"action":"tap","x":540,"y":1200}. No step was performed.' },
    { case: "missing fields", raw: [{ action: "tap" }], error: 'Step 1 (tap) needs x and y, e.g. {"action":"tap","x":540,"y":1200}. No step was performed.' },
    { case: "a missing field in a later step", raw: [{ action: "read_screen" }, { action: "type_text", text: "" }], error: 'Step 2 (type_text) needs text, e.g. {"action":"type_text","text":"iPad mini"}. No step was performed.' },
    { case: "a screenshot step", raw: [{ action: "screenshot" }], error: "Step 1: screenshot returns an image and cannot be a batch step; use read_screen, or call screenshot after the batch. No step was performed." },
    { case: "a batch step", raw: [{ action: "batch", steps: [{ action: "read_screen" }] }], error: "Step 1: a batch cannot be a batch step; put its steps in this list. No step was performed." },
    { case: "an action that is not a step", raw: [{ action: "status" }], error: 'Step 1 needs an action from open_app, tap_text, tap, swipe, type_text, press, read_screen, wait, e.g. {"action":"tap_text","text":"Search"}. No step was performed.' },
    { case: "a wait that is not a number", raw: [{ action: "wait", seconds: "x" }], error: 'Step 1 (wait) needs seconds as a number from 0 to 60, e.g. {"action":"wait","seconds":3}. No step was performed.' },
    { case: "coordinates off the screen", raw: [{ action: "tap", x: -1, y: 2 }], error: 'Step 1 (tap) needs x and y from 0 to 10000, e.g. {"action":"tap","x":540,"y":1200}. No step was performed.' },
    { case: "a fractional match index", raw: [{ action: "tap_text", text: "Search", index: "1.5" }], error: 'Step 1 (tap_text) needs index as a whole number from 0, e.g. {"action":"tap_text","text":"Search","index":1}. No step was performed.' },
    { case: "an exact that is not true or false", raw: [{ action: "tap_text", text: "Search", exact: "yes" }], error: 'Step 1 (tap_text) needs exact as true or false, e.g. {"action":"tap_text","text":"Search","exact":true}. No step was performed.' },
    { case: "blank text to tap", raw: [{ action: "tap_text", text: "  " }], error: 'Step 1 (tap_text) needs text that is not blank, e.g. {"action":"tap_text","text":"Search"}. No step was performed.' },
    { case: "a blank app name", raw: [{ action: "open_app", name: " " }], error: `Step 1 (open_app) needs name, an app's English name or package name, e.g. {"action":"open_app","name":"Settings"}. No step was performed.` },
    { case: "text too long to type", raw: [{ action: "type_text", text: "a".repeat(257) }], error: 'Step 1 (type_text) needs text of at most 256 characters, e.g. {"action":"type_text","text":"iPad mini"}. No step was performed.' },
    { case: "an unknown swipe direction", raw: [{ action: "swipe", direction: "north" }], error: 'Step 1 (swipe) needs direction as one of up, down, left, right, e.g. {"action":"swipe","direction":"up"}. No step was performed.' },
    { case: "an unknown key", raw: [{ action: "press", key: "f13" }], error: 'Step 1 (press) needs key as one of back, delete, down, enter, escape, home, left, recent, return, right, sleep, space, tab, up, wakeup, e.g. {"action":"press","key":"enter"}. No step was performed.' },
    { case: "a step that is not an object", raw: ["read_screen"], error: 'Step 1 needs to be an object such as {"action":"tap_text","text":"Search"}. No step was performed.' },
    { case: "11 steps", raw: Array(11).fill({ action: "read_screen" }), error: "A batch runs at most 10 steps, not 11; split them into several batches. No step was performed." },
    { case: "no steps", raw: undefined, error: 'steps needs a list of 1 to 10 steps, e.g. {"steps":[{"action":"tap_text","text":"Search"},{"action":"read_screen"}]}. No step was performed.' },
    { case: "an empty step list", raw: [], error: 'steps needs a list of 1 to 10 steps, e.g. {"steps":[{"action":"tap_text","text":"Search"},{"action":"read_screen"}]}. No step was performed.' },
    { case: "an empty list as text, after a valid step", raw: [{ action: "tap", x: 540, y: 1200 }, { action: "type_text", text: [] }], error: 'Step 2 (type_text) needs text as a single value, not a list or an object, e.g. {"action":"type_text","text":"iPad mini"}. No step was performed.' },
    { case: "a negative match index", raw: [{ action: "tap_text", text: "Search", index: -1 }], error: 'Step 1 (tap_text) needs index as a whole number from 0, e.g. {"action":"tap_text","text":"Search","index":1}. No step was performed.' },
    { case: "a y off the screen", raw: [{ action: "tap", x: 1, y: -1 }], error: 'Step 1 (tap) needs x and y from 0 to 10000, e.g. {"action":"tap","x":540,"y":1200}. No step was performed.' },
    { case: "an x past 10000", raw: [{ action: "tap", x: 10001, y: 2 }], error: 'Step 1 (tap) needs x and y from 0 to 10000, e.g. {"action":"tap","x":540,"y":1200}. No step was performed.' },
    { case: "a coordinate that is not a number", raw: [{ action: "tap", x: true, y: 1200 }], error: 'Step 1 (tap) needs x and y from 0 to 10000, e.g. {"action":"tap","x":540,"y":1200}. No step was performed.' },
    { case: "a blank coordinate string", raw: [{ action: "tap", x: " ", y: 1200 }], error: 'Step 1 (tap) needs x and y from 0 to 10000, e.g. {"action":"tap","x":540,"y":1200}. No step was performed.' },
    { case: "a negative wait", raw: [{ action: "wait", seconds: -1 }], error: 'Step 1 (wait) needs seconds as a number from 0 to 60, e.g. {"action":"wait","seconds":3}. No step was performed.' },
    { case: "a negative wait on another action", raw: [{ action: "tap", x: 1, y: 2, seconds: -1 }], error: 'Step 1 (tap) does not take seconds; put a separate {"action":"wait","seconds":3} step after it. No step was performed.' },
    { case: "a clear that is not true or false", raw: [{ action: "type_text", text: "x", clear: "yes" }], error: 'Step 1 (type_text) needs clear as true or false, e.g. {"action":"type_text","text":"iPad mini","clear":true}. No step was performed.' },
    { case: "true or false as text", raw: [{ action: "type_text", text: false }], error: 'Step 1 (type_text) needs text as a string, not true or false, e.g. {"action":"type_text","text":"iPad mini"}. No step was performed.' },
    { case: "a wait given as true", raw: [{ action: "wait", seconds: true }], error: 'Step 1 (wait) needs seconds as a number from 0 to 60, e.g. {"action":"wait","seconds":3}. No step was performed.' },
    { case: "a serial on a step", raw: [{ action: "tap", x: 1, y: 2, serial: "B" }], error: 'Step 1 names a serial, but a batch runs on one phone; set serial once beside steps, e.g. {"serial":"B","steps":[{"action":"read_screen"}]}. No step was performed.' },
    { case: "a serial on a step that is not text", raw: [{ action: "read_screen", serial: ["B"] }], error: 'Step 1 names a serial, but a batch runs on one phone; set serial once beside steps, e.g. {"serial":"<serial>","steps":[{"action":"read_screen"}]}. No step was performed.' },
    { case: "an action given as a list", raw: [{ action: ["read_screen"] }], error: 'Step 1 needs an action from open_app, tap_text, tap, swipe, type_text, press, read_screen, wait, e.g. {"action":"tap_text","text":"Search"}. No step was performed.' },
    { case: "a missing field before a list", raw: [{ action: "tap", x: [1] }], error: 'Step 1 (tap) needs y, e.g. {"action":"tap","x":540,"y":1200}. No step was performed.' },
    { case: "a zero wait on another action", raw: [{ action: "tap", x: 1, y: 2, seconds: 0 }], error: 'Step 1 (tap) does not take seconds; put a separate {"action":"wait","seconds":0} step after it. No step was performed.' },
    { case: "an endless wait on another action", raw: [{ action: "tap", x: 1, y: 2, seconds: "Infinity" }], error: 'Step 1 (tap) does not take seconds; put a separate {"action":"wait","seconds":3} step after it. No step was performed.' },
    { case: "a list as a wait on another action", raw: [{ action: "tap", x: 1, y: 2, seconds: [5] }], error: 'Step 1 (tap) does not take seconds; put a separate {"action":"wait","seconds":3} step after it. No step was performed.' },
    { case: "a swipe shorter than 50 pixels", raw: [{ action: "swipe", direction: "up", distance: 10 }], error: 'Step 1 (swipe) needs x and y from 0 to 10000, distance from 50 to 10000 and duration_ms from 50 to 2000, e.g. {"action":"swipe","direction":"up","x":300,"y":1400,"distance":400,"duration_ms":800}. No step was performed.' },
    { case: "a swipe step lasting 2001 ms", raw: [{ action: "swipe", direction: "up", duration_ms: 2001 }], error: 'Step 1 (swipe) needs x and y from 0 to 10000, distance from 50 to 10000 and duration_ms from 50 to 2000, e.g. {"action":"swipe","direction":"up","x":300,"y":1400,"distance":400,"duration_ms":800}. No step was performed.' },
    { case: "a tap held for 0 ms", raw: [{ action: "tap", x: 540, y: 900, duration_ms: 0 }], error: 'Step 1 (tap) needs duration_ms from 50 to 2000, e.g. {"action":"tap","x":540,"y":900,"duration_ms":1000}. No step was performed.' },
    { case: "a tap held for 49 ms", raw: [{ action: "tap", x: 540, y: 900, duration_ms: 49 }], error: 'Step 1 (tap) needs duration_ms from 50 to 2000, e.g. {"action":"tap","x":540,"y":900,"duration_ms":1000}. No step was performed.' },
    { case: "a tap held for 2001 ms", raw: [{ action: "tap", x: 540, y: 900, duration_ms: 2001 }], error: 'Step 1 (tap) needs duration_ms from 50 to 2000, e.g. {"action":"tap","x":540,"y":900,"duration_ms":1000}. No step was performed.' },
    { case: "a distance on an action that is not swipe", raw: [{ action: "press", key: "enter", distance: 400 }], error: 'Step 1 (press) does not take distance, which belongs to swipe; write it like {"action":"press","key":"enter"}. No step was performed.' },
    { case: "a duration on an action that is neither tap nor swipe", raw: [{ action: "press", key: "enter", duration_ms: 1000 }], error: 'Step 1 (press) does not take duration_ms, which belongs to tap or swipe; write it like {"action":"press","key":"enter"}. No step was performed.' },
  ])("refuses $case", ({ raw, error }) => {
    expect(() => parseSteps(raw)).toThrow(new Error(error));
  });

  const VALID_FIELDS: Record<string, Record<string, unknown>> = {
    open_app: { name: "Settings" },
    tap_text: { text: "Search", exact: true, index: 1 },
    tap: { x: 540, y: 1200 },
    swipe: { direction: "up" },
    type_text: { text: "iPad mini" },
    press: { key: "enter" },
    wait: { seconds: 3 },
  };
  it.each(Object.entries(VALID_FIELDS).flatMap(([action, fields]) => Object.keys(fields).flatMap((field) => [
    { action, field, kind: "a list", step: { action, ...fields, [field]: ["hello", "world"] } },
    { action, field, kind: "an object", step: { action, ...fields, [field]: { value: 1 } } },
  ])))("refuses $kind as $action's $field", ({ action, field, step }) => {
    expect(() => parseSteps([step])).toThrow(new RegExp(`^Step 1 \\(${action}\\) needs ${field} as a single value, not a list or an object, e\\.g\\. \\{"action":"${action}".*\\}\\. No step was performed\\.$`));
  });
});

describe("phone batch runs", () => {
  const OUTPUT: Record<string, string> = { tap: "Tapped 540,1200", tap_text: 'Tapped "Search"', press: "Pressed enter", read_screen: SCREEN };
  const TAP: PhoneStep = { action: "tap", x: 540, y: 1200 };
  const TAP_TEXT: PhoneStep = { action: "tap_text", text: "Search" };
  const PRESS: PhoneStep = { action: "press", key: "enter" };
  const READ: PhoneStep = { action: "read_screen" };
  const run = async (steps: PhoneStep[], failAt = 0, refuseBefore = 0, refusal = "This turn no longer has phone access. Start a new turn to use the phone.") => {
    const performed: string[] = [];
    let claims = 0;
    const result = await runSteps("FAKE123", steps, async () => {
      claims += 1;
      return claims + 1 === refuseBefore ? { ok: false, message: refusal } : { ok: true };
    }, async (serial, step) => {
      performed.push(`${serial} ${step.action}`);
      if (performed.length === failAt) throw new Error('No visible Android text matches "Buy"');
      return OUTPUT[step.action];
    });
    return { performed, claims, text: (result.content[0] as { text: string }).text, isError: result.isError };
  };

  it.each([
    { case: "acts without reading the screen when no step asks", steps: [TAP], performed: ["FAKE123 tap"], claims: 0, text: "1. tap: Tapped 540,1200" },
    { case: "shows the screen under a read_screen step", steps: [TAP, READ], performed: ["FAKE123 tap", "FAKE123 read_screen"], claims: 1, text: `1. tap: Tapped 540,1200\n2. read_screen:\n${SCREEN}` },
    { case: "stops at a failing step 2 without an error flag", steps: [TAP_TEXT, TAP_TEXT, READ], failAt: 2, performed: ["FAKE123 tap_text", "FAKE123 tap_text"], claims: 1, text: `1. tap_text: Tapped "Search"\nStep 2 failed: No visible Android text matches "Buy". Its effect is unknown; call read_screen or screenshot before trying it again. ${EARLIER_AND_LATER}` },
    { case: "flags an error when step 1 fails", steps: [TAP_TEXT, READ], failAt: 1, performed: ["FAKE123 tap_text"], claims: 0, text: `Step 1 failed: No visible Android text matches "Buy". Its effect is unknown; call read_screen or screenshot before trying it again. ${EARLIER_AND_LATER}`, isError: true },
    { case: "stops when the claim is refused before step 2", steps: [TAP, PRESS, READ], refuseBefore: 2, performed: ["FAKE123 tap"], claims: 1, text: `1. tap: Tapped 540,1200\nStopped before step 2: This turn no longer has phone access. Start a new turn to use the phone. ${EARLIER_AND_LATER}` },
    { case: "rechecks the claim before every later step", steps: [TAP, PRESS, READ], refuseBefore: 3, performed: ["FAKE123 tap", "FAKE123 press"], claims: 2, text: `1. tap: Tapped 540,1200\n2. press: Pressed enter\nStopped before step 3: This turn no longer has phone access. Start a new turn to use the phone. ${EARLIER_AND_LATER}` },
  ])("$case", async ({ steps, failAt, refuseBefore, performed, claims, text, isError }) => {
    expect(await run(steps, failAt, refuseBefore)).toEqual({ performed, claims, text, isError });
  });

  it.each([
    { refusal: "Another thread is using the phone. This call was not performed. Pause phone work until that thread finishes, then read the screen again before acting.", said: "Another thread is using the phone. Pause phone work until that thread finishes, then read the screen again before acting" },
    { refusal: "OpenMausBot could not be reached to reserve the phone. This call was not performed; try again.", said: "OpenMausBot could not be reached to reserve the phone" },
    { refusal: "A person has taken control of the phone, so this call was NOT performed. Do not act until they hand it back. To wait, call read_screen: each phone call waits up to 45 seconds and returns as soon as they hand the phone back. Meanwhile you may work on anything that does not need the phone.", said: "A person has taken control of the phone. Do not act until they hand it back. To wait, call read_screen: each phone call waits up to 45 seconds and returns as soon as they hand the phone back. Meanwhile you may work on anything that does not need the phone" },
    { refusal: "The person has handed the phone back. This call was NOT performed: the screen may have changed. Call read_screen, then continue the task.", said: "The person has handed the phone back. Call read_screen, then continue the task" },
    { refusal: "The phone is free now, but this call had to wait for it, so it was NOT performed. Call again: the next call goes through at once. If you meant to tap or type from an earlier read_screen, call read_screen again first: the screen may have changed while you waited.", said: "The phone is free now, but this call had to wait for it. Call again: the next call goes through at once. If you meant to tap or type from an earlier read_screen, call read_screen again first: the screen may have changed while you waited" },
  ])("does not call a half-done batch unperformed when the claim is refused: $said", async ({ refusal, said }) => {
    const { text } = await run([TAP, PRESS], 0, 2, refusal);
    expect(text).toBe(`1. tap: Tapped 540,1200\nStopped before step 2: ${said}. ${EARLIER_AND_LATER}`);
  });

  it("waits 2 s by default, and at most 60 s", async () => {
    vi.useFakeTimers();
    try {
      let done = false;
      const result = runSteps("FAKE123", [{ action: "wait" }, { action: "wait", seconds: 75 }], async () => ({ ok: true }), async () => "not a wait");
      void result.then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(61_999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);
      expect((await result).content).toEqual([{ type: "text", text: "1. wait: Waited 2 s\n2. wait: Waited 60 s (a wait is at most 60 s)" }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("phone MCP tool surface", () => {
  type Property = { enum?: string[]; description?: string };
  const tool = (name: string) => TOOLS.find((candidate) => candidate.name === name) as unknown as {
    description: string;
    inputSchema: { properties: Record<string, Property> & { steps: { maxItems: number; items: { properties: Record<string, Property> } } } };
  };

  it("keeps every schema flat", () => {
    expect(JSON.stringify({ tools: TOOLS })).not.toMatch(/"(oneOf|anyOf|allOf|const|format)":/);
  });

  it("offers the shared step tools and wait as steps, each field naming its action", () => {
    const steps = tool("batch").inputSchema.properties.steps;
    expect(steps.items.properties.action.enum).toEqual([...PHONE_STEP_TOOLS, "wait"]);
    expect(steps.maxItems).toBe(10);
    expect(tool("batch").inputSchema.properties.serial).toEqual({ type: "string" });
    for (const name of PHONE_STEP_TOOLS) {
      for (const field of Object.keys(tool(name).inputSchema.properties).filter((key) => key !== "serial")) {
        expect(steps.items.properties[field]?.description?.split(": ")[0].split(" and "), `${name}.${field}`).toContain(name);
      }
    }
    expect(steps.items.properties.seconds.description).toBe("wait: how long to wait, 0 to 60, default 2.");
    expect(steps.items.properties.index.description).toBe("tap_text: which match of the text, from 0.");
  });

  it("describes batch as designed", () => {
    expect(tool("batch").description).toBe('Run up to 10 phone steps in order in one call. A step is one of open_app, tap_text, tap, swipe, type_text, press, read_screen or wait, with that tool\'s fields: {action, ...fields}. Add read_screen as the last step to see the result; the batch returns the screen only at a read_screen step. A wait step (0 to 60 s) gives content time to load. It stops at the first failing step. End a batch where the next screen is uncertain, such as after a step that may open a dialog, and read it before acting further. Example: {"steps":[{"action":"tap_text","text":"Search"},{"action":"type_text","text":"iPad mini"},{"action":"press","key":"enter"},{"action":"wait","seconds":3},{"action":"read_screen"}]}');
  });

  it("points read_screen and the actions at batch", () => {
    expect(tool("read_screen").description).toBe("Read visible text, accessibility labels, resource ids, and pixel bounds from the connected Android screen. Use it before choosing what to act on. To act and see the result in one call, put the action and read_screen in one batch.");
    for (const name of ["open_app", "tap_text", "tap", "swipe", "type_text", "press"]) {
      expect(tool(name).description).toMatch(/\. To do several steps, or to act and then read the screen, in one call, use batch\.$/);
      expect(tool(name).description).not.toContain("then use read_screen to verify");
    }
  });

  it("offers swipe a start, a distance and a duration, and tap a duration to hold, as designed", () => {
    expect(tool("swipe").description).toBe("Swipe the Android screen in a direction. By default the finger moves half the screen through the centre in 260 ms. To scroll a list, a pane or a picker wheel by a chosen amount, give x and y (where the finger starts), distance (pixels it moves) and duration_ms (longer is slower). To do several steps, or to act and then read the screen, in one call, use batch.");
    expect(tool("swipe").inputSchema).toEqual({ type: "object", properties: { direction: { type: "string", enum: ["up", "down", "left", "right"] }, x: { type: "number" }, y: { type: "number" }, distance: { type: "number" }, duration_ms: { type: "integer" }, serial: { type: "string" } }, required: ["direction"] });
    expect(tool("tap").description).toBe("Tap Android screen pixel coordinates obtained from read_screen or screenshot. Add duration_ms to hold the tap; about 1000 is a long press. To do several steps, or to act and then read the screen, in one call, use batch.");
    expect(tool("tap").inputSchema).toEqual({ type: "object", properties: { x: { type: "number" }, y: { type: "number" }, duration_ms: { type: "integer" }, serial: { type: "string" } }, required: ["x", "y"] });
  });

  it("tells a step what distance and duration_ms mean, naming their actions", () => {
    const fields = tool("batch").inputSchema.properties.steps.items.properties;
    expect(fields.distance).toEqual({ type: "number", description: "swipe: pixels the finger moves, 50 to 10000, default half the screen." });
    expect(fields.duration_ms).toEqual({ type: "integer", description: "tap and swipe: milliseconds a tap is held or a swipe takes, 50 to 2000; without it a tap is not held and a swipe takes 260." });
  });

  it("tells the bot that other text needs ADBKeyBoard switched on, not chosen as the keyboard", () => {
    expect(tool("type_text").description).toContain("other text, such as Chinese, emoji or +, needs the ADBKeyBoard app switched on in the phone's keyboard list.");
  });

  it("keeps serial out of a step's fields", () => {
    expect(tool("batch").inputSchema.properties.steps.items.properties).not.toHaveProperty("serial");
  });

  it("keeps the batch hint off the tools that cannot be steps", () => {
    for (const name of ["status", "screenshot", "list_apps"]) {
      expect(tool(name).description).not.toContain("batch");
    }
  });
});

describe.skipIf(process.platform === "win32")("phone MCP calls through a stand-in adb", () => {
  type Response = { result: { content: Array<{ type: string; text: string }>; isError?: boolean } };
  type Call = (name: string, args: Record<string, unknown>, cancel?: "this call" | "another call") => Promise<Response>;
  let home = "";
  let adb = "";
  const proxies: ChildProcess[] = [];
  let call: Call;
  const adbLog = () => (existsSync(join(home, "adb.log")) ? readFileSync(join(home, "adb.log"), "utf8").trim().split("\n") : []);
  const DUMP = "-s FAKE123 shell uiautomator dump /dev/tty";

  const startProxy = (harness: Record<string, string> = {}): Call => {
    const env: NodeJS.ProcessEnv = { ...process.env, OMB_ADB_PATH: adb };
    delete env.OMB_HARNESS_URL;
    delete env.OMB_PHONE_TOKEN;
    delete env.PH_ANDROID_SERIAL;
    const proxy = spawn(process.execPath, [fileURLToPath(new URL("./phone-proxy.ts", import.meta.url))], { env: { ...env, ...harness }, stdio: ["pipe", "pipe", "ignore"] });
    proxies.push(proxy);
    const waiting = new Map<number, (response: Response) => void>();
    createInterface({ input: proxy.stdout! }).on("line", (line) => {
      const response = JSON.parse(line) as Response & { id: number };
      waiting.get(response.id)?.(response);
    });
    let id = 0;
    return (name, args, cancel) => new Promise((resolve) => {
      waiting.set(++id, resolve);
      proxy.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
      const cancelled = JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: cancel === "this call" ? id : id + 1000 } });
      if (cancel) setTimeout(() => proxy.stdin!.write(`${cancelled}\n`), 100);
    });
  };

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "omb-phone-proxy-"));
    adb = join(home, "adb");
    writeFileSync(adb, `#!/bin/sh
echo "$*" >> "$(dirname "$0")/adb.log"
case "$*" in
  "devices -l") printf 'List of devices attached\\nFAKE123 device usb:1-2 product:husky model:Pixel_8 transport_id:4\\n' ;;
  *"uiautomator dump /dev/tty") printf '%s' '<?xml version="1.0" encoding="UTF-8"?><hierarchy rotation="0"><node text="Search" resource-id="" class="android.widget.TextView" content-desc="" bounds="[0,100][200,180]" /></hierarchy>' ;;
  *"cmd package query-activities"*) echo "com.ubercab/.presidio.RootActivity" ;;
  *"wm size") echo "Physical size: 1080x2400" ;;
esac
`);
    chmodSync(adb, 0o755);
    call = startProxy();
  });
  afterAll(() => {
    for (const proxy of proxies) proxy.kill();
    rmSync(home, { recursive: true, force: true });
  });

  it.each([
    { name: "read_screen", args: {}, text: SCREEN, adb: [DUMP] },
    { name: "open_app", args: { name: "Uber" }, text: "Opened Uber (com.ubercab)", adb: ["-s FAKE123 shell cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER", "-s FAKE123 shell monkey -p com.ubercab -c android.intent.category.LAUNCHER 1"] },
    { name: "tap_text", args: { text: "search" }, text: 'Tapped "Search"', adb: [DUMP, "-s FAKE123 shell input tap 100 140"] },
    { name: "tap", args: { x: 540, y: 1200 }, text: "Tapped 540,1200", adb: ["-s FAKE123 shell input tap 540 1200"] },
    { name: "swipe", args: { direction: "up" }, text: "Swiped up", adb: ["-s FAKE123 shell wm size", "-s FAKE123 shell input swipe 540 1800 540 600 260"] },
    { name: "type_text", args: { text: "iPad mini" }, text: "Typed text into the focused Android field", adb: ["-s FAKE123 shell input text iPad%smini"] },
    { name: "press", args: { key: "enter" }, text: "Pressed enter", adb: ["-s FAKE123 shell input keyevent KEYCODE_ENTER"] },
  ])("$name returns its single-call text", async ({ name, args, text, adb }) => {
    rmSync(join(home, "adb.log"), { force: true });
    expect((await call(name, args)).result).toEqual({ content: [{ type: "text", text }] });
    expect(adbLog()).toEqual(["devices -l", ...adb]);
  });

  it("runs a batch's steps in one call and returns the screen only at its read_screen step", async () => {
    rmSync(join(home, "adb.log"), { force: true });
    const response = await call("batch", { steps: [{ action: "tap_text", text: "Search" }, { action: "wait", seconds: 0 }, { action: "read_screen" }] });
    expect(response.result).toEqual({ content: [{ type: "text", text: `1. tap_text: Tapped "Search"\n2. wait: Waited 0 s\n3. read_screen:\n${SCREEN}` }] });
    expect(adbLog()).toEqual(["devices -l", DUMP, "-s FAKE123 shell input tap 100 140", DUMP]);
  });

  it("passes a step's coerced index and exact on to tap_text", async () => {
    const twoMatches = join(home, "adb-two-matches");
    writeFileSync(twoMatches, `#!/bin/sh
echo "$*" >> "$(dirname "$0")/adb.log"
case "$*" in
  "devices -l") printf 'List of devices attached\\nFAKE123 device usb:1-2 product:husky model:Pixel_8 transport_id:4\\n' ;;
  *"uiautomator dump /dev/tty") printf '%s' '<?xml version="1.0" encoding="UTF-8"?><hierarchy rotation="0"><node text="Search" resource-id="" class="android.widget.TextView" content-desc="" bounds="[0,100][200,180]" /><node text="Search history" resource-id="" class="android.widget.TextView" content-desc="" bounds="[0,300][200,380]" /></hierarchy>' ;;
esac
`);
    chmodSync(twoMatches, 0o755);
    const onTwoMatches = startProxy({ OMB_ADB_PATH: twoMatches });
    rmSync(join(home, "adb.log"), { force: true });
    const response = await onTwoMatches("batch", { steps: [{ action: "tap_text", text: "search", index: "1" }, { action: "tap_text", text: "history", exact: "true" }] });
    expect(response.result).toEqual({ content: [{ type: "text", text: `1. tap_text: Tapped "Search history"\nStep 2 failed: No visible Android text matches "history". Its effect is unknown; call read_screen or screenshot before trying it again. ${EARLIER_AND_LATER}` }] });
    expect(adbLog()).toEqual(["devices -l", DUMP, "-s FAKE123 shell input tap 100 340", DUMP]);
  });

  it("refuses an invalid batch before touching the phone", async () => {
    rmSync(join(home, "adb.log"), { force: true });
    const response = await call("batch", { steps: [{ action: "read_screen" }, { action: "tap" }] });
    expect(response.result).toEqual({ content: [{ type: "text", text: 'Step 2 (tap) needs x and y, e.g. {"action":"tap","x":540,"y":1200}. No step was performed.' }], isError: true });
    expect(adbLog()).toEqual([]);
  });

  it("keeps a single tool to its own action whatever action its arguments name", async () => {
    rmSync(join(home, "adb.log"), { force: true });
    expect((await call("tap", { x: 540, y: 1200, action: "press", key: "home" })).result).toEqual({ content: [{ type: "text", text: "Tapped 540,1200" }] });
    expect(adbLog()).toEqual(["devices -l", "-s FAKE123 shell input tap 540 1200"]);
  });

  it("runs a batch on the device its serial names", async () => {
    rmSync(join(home, "adb.log"), { force: true });
    const response = await call("batch", { serial: "MISSING", steps: [{ action: "tap", x: 540, y: 1200 }] });
    expect(response.result).toEqual({ content: [{ type: "text", text: "No physical USB Android device is connected" }], isError: true });
    expect(adbLog()).toEqual(["devices -l"]);
  });

  it.each([
    { cancel: "this call" as const, rest: `Stopped before step 2: The client cancelled this call. ${EARLIER_AND_LATER}`, adb: [] },
    { cancel: "another call" as const, rest: "2. tap: Tapped 540,1200", adb: ["-s FAKE123 shell input tap 540 1200"] },
  ])("stops a batch at the next step only when the client cancels $cancel", async ({ cancel, rest, adb }) => {
    rmSync(join(home, "adb.log"), { force: true });
    const response = await call("batch", { steps: [{ action: "wait", seconds: 0.4 }, { action: "tap", x: 540, y: 1200 }] }, cancel);
    expect(response.result).toEqual({ content: [{ type: "text", text: `1. wait: Waited 0.4 s\n${rest}` }] });
    expect(adbLog()).toEqual(["devices -l", ...adb]);
  });

  it.each([
    { name: "batch", args: { steps: [{ action: "tap", x: 540, y: 1200 }] }, result: { content: [{ type: "text", text: "The client cancelled this call." }], isError: true }, adb: [] },
    { name: "tap", args: { x: 540, y: 1200 }, result: { content: [{ type: "text", text: "Tapped 540,1200" }] }, adb: ["devices -l", "-s FAKE123 shell input tap 540 1200"] },
  ])("a cancel notice during the phone claim stops a batch from starting, not a single tool: $name", async ({ name, args, result, adb }) => {
    const harness = createServer((request, response) => {
      request.resume();
      setTimeout(() => response.writeHead(200).end("{}"), 300);
    });
    await new Promise<void>((resolve) => harness.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = harness.address() as AddressInfo;
      const claimed = startProxy({ OMB_HARNESS_URL: `http://127.0.0.1:${port}`, OMB_PHONE_TOKEN: "tok" });
      rmSync(join(home, "adb.log"), { force: true });
      const response = await claimed(name, args, "this call");
      expect(response.result).toEqual(result);
      expect(adbLog()).toEqual(adb);
    } finally {
      harness.close();
    }
  });

  it("stops a batch at the next step once the harness refuses the claim", async () => {
    const answers = [200, 200, 409];
    const harness = createServer((request, response) => {
      request.resume();
      response.writeHead(answers.shift() ?? 409).end("{}");
    });
    await new Promise<void>((resolve) => harness.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = harness.address() as AddressInfo;
      const claimed = startProxy({ OMB_HARNESS_URL: `http://127.0.0.1:${port}`, OMB_PHONE_TOKEN: "tok" });
      rmSync(join(home, "adb.log"), { force: true });
      const response = await claimed("batch", { steps: [{ action: "tap", x: 540, y: 1200 }, { action: "press", key: "enter" }] });
      expect(response.result).toEqual({ content: [{ type: "text", text: "1. tap: Tapped 540,1200\nStopped before step 2: Another thread is using the phone. Pause phone work until that thread finishes, then read the screen again before acting. Steps before it were done; do not repeat them. Later steps were not performed." }] });
      expect(adbLog()).toEqual(["devices -l", "-s FAKE123 shell input tap 540 1200"]);
    } finally {
      harness.close();
    }
  });

  it("tells the harness that only a batch's first claim may wait for a person", async () => {
    const asked: string[] = [];
    const harness = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8").on("data", (chunk: string) => { body += chunk; }).on("end", () => {
        asked.push(body);
        response.writeHead(200).end("{}");
      });
    });
    await new Promise<void>((resolve) => harness.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = harness.address() as AddressInfo;
      const claimed = startProxy({ OMB_HARNESS_URL: `http://127.0.0.1:${port}`, OMB_PHONE_TOKEN: "tok" });
      await claimed("batch", { steps: [{ action: "tap", x: 540, y: 1200 }, { action: "wait", seconds: 0 }] });
      expect(asked).toEqual(["{}", '{"wait":false}', '{"wait":false}']);
    } finally {
      harness.close();
    }
  });
});

const PERSON_TEXT = "A person has taken control of the phone, so this call was NOT performed. Do not act until they hand it back. To wait, call read_screen: each phone call waits up to 45 seconds and returns as soon as they hand the phone back. Meanwhile you may work on anything that does not need the phone.";
const HANDED_BACK_TEXT = "The person has handed the phone back. This call was NOT performed: the screen may have changed. Call read_screen, then continue the task.";

describe("phone MCP claim while a person may hold the phone", () => {
  const harnessEnv = { OMB_HARNESS_URL: "http://127.0.0.1:8799", OMB_PHONE_TOKEN: "tok" };
  const answering = (answer: () => Response) => (async () => answer()) as unknown as typeof fetch;
  const refusal = (body: unknown) => answering(() => new Response(JSON.stringify(body), { status: 423 }));

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    [{ reason: "person" }, PERSON_TEXT],
    [{ reason: "handed-back" }, HANDED_BACK_TEXT],
    [{}, "OpenMausBot could not reserve the phone for this call. This call was not performed; try again, or start a new turn if it keeps failing."],
  ])("tells the bot what a 423 %j means", async (body, message) => {
    await expect(createPhoneClaim(harnessEnv, refusal(body))()).resolves.toEqual({ ok: false, message });
  });

  it("gives the harness 55 seconds to answer, past its 45-second wait", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await createPhoneClaim(harnessEnv, answering(() => new Response("{}")))();
    expect(timeout.mock.calls).toEqual([[55_000]]);
  });

  it.each([
    [5_000, { ok: true }],
    [5_001, { ok: false, message: "The phone is free now, but this call had to wait for it, so it was NOT performed. Call again: the next call goes through at once. If you meant to tap or type from an earlier read_screen, call read_screen again first: the screen may have changed while you waited." }],
  ])("acts on a claim granted after %i ms only when that is within 5 seconds", async (waitedMs, outcome) => {
    vi.useFakeTimers();
    const slow = answering(() => {
      vi.advanceTimersByTime(waitedMs);
      return new Response(JSON.stringify({ claimed: true }));
    });
    await expect(createPhoneClaim(harnessEnv, slow)()).resolves.toEqual(outcome);
  });
});

describe("phone MCP calls claim before each command sent to the phone", () => {
  const DEVICES = ["devices", "-l"];
  const onPhone = (...command: string[]) => ["-s", "USB123", ...command];
  const DUMP = onPhone("shell", "uiautomator", "dump", "/dev/tty");
  const APPS = onPhone("shell", "cmd", "package", "query-activities", "--brief", "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER");
  const SAVED_DUMP = "/data/local/tmp/openmaus-window.xml";
  const SAVE_READ_AND_REMOVE = onPhone("shell", `rm -f ${SAVED_DUMP}; uiautomator dump ${SAVED_DUMP} >/dev/null && cat ${SAVED_DUMP}; status=$?; rm -f ${SAVED_DUMP}; exit $status`);
  const namingTheSavedDumpWithoutRemovingIt = (commands: string[][]) =>
    commands.filter((command) => command.join(" ").includes(SAVED_DUMP) && !command.join(" ").includes(`rm -f ${SAVED_DUMP}`));
  const DEVICE_LIST = "List of devices attached\nUSB123 device product:husky model:Pixel_8 usb:1-2 transport_id:4\n";
  const SCREEN_XML = `<?xml version="1.0"?><hierarchy><node text="Where to?" resource-id="com.ubercab:id/input" class="android.widget.TextView" content-desc="Destination" bounds="[12,100][400,180]" /></hierarchy>`;
  const REPLIES: Array<[string, string | Buffer]> = [
    ["devices -l", DEVICE_LIST],
    ["uiautomator dump", `${SCREEN_XML}UI hierchary dumped to: /dev/tty\n`],
    ["screencap", Buffer.from("89504e470d0a1a0a", "hex")],
    ["query-activities", "1 activities found:\n  com.ubercab/.presidio.RootActivity\n"],
    ["wm size", "Physical size: 1080x1920\n"],
  ];
  const REFUSED = { ok: false as const, message: PERSON_TEXT };

  function phone(...refusals: Array<typeof REFUSED | undefined>) {
    const commands: string[][] = [];
    const options: unknown[] = [];
    const midCall: boolean[] = [];
    let claims = 0;
    const adb = async (args: string[], option?: unknown) => {
      commands.push(args);
      options.push(option);
      const line = args.join(" ");
      return Buffer.from(REPLIES.find(([part]) => line.includes(part))?.[1] ?? "");
    };
    const ensureClaim = async (inCall = false) => {
      midCall.push(inCall);
      return refusals[claims++] ?? { ok: true as const };
    };
    const call = (name: string, args: Record<string, unknown> = {}) => callPhoneTool(name, args, ensureClaim, adb);
    return { commands, options, call, claims: () => claims, midCall };
  }

  /** adb for a phone whose `uiautomator dump /dev/tty` prints no XML, so the screen is read from a saved file. `saved` is what that file holds
   * at first, `dump` what `uiautomator dump` writes to it and exits with, `left` what it holds afterwards; `duringRead` runs while the phone's
   * shell runs the command line that names the file. */
  function adbOfPhoneThatSavesItsDump({ duringRead = () => {}, saved, dump = { writes: SCREEN_XML, exit: 0 } }: { duringRead?: () => void; saved?: string; dump?: { writes?: string; exit: number } } = {}) {
    const commands: string[][] = [];
    let file = saved;
    const adb = async (args: string[]) => {
      commands.push(args);
      const line = args.join(" ");
      if (line.includes("devices -l")) return Buffer.from(DEVICE_LIST);
      if (!line.includes(SAVED_DUMP)) return Buffer.from("");
      duringRead();
      let printed = "";
      const run = (command: string) => {
        if (command === `rm -f ${SAVED_DUMP}`) {
          file = undefined;
          return 0;
        }
        if (command === `uiautomator dump ${SAVED_DUMP} >/dev/null`) {
          file = dump.writes ?? file;
          return dump.exit;
        }
        if (command !== `cat ${SAVED_DUMP}`) throw new Error(`The fake phone cannot run: ${command}`);
        printed += file ?? "";
        return file === undefined ? 1 : 0;
      };
      let lastExit = 0;
      let status = 0;
      for (const statement of (args.at(-1) ?? "").split("; ")) {
        if (statement === "status=$?") status = lastExit;
        else if (statement !== "exit $status") lastExit = statement.split(" && ").reduce((exit, command) => exit || run(command), 0);
        else if (status !== 0) throw new Error(`The phone's shell exited with ${status}.`);
      }
      return Buffer.from(printed);
    };
    return { commands, adb, left: () => file };
  }

  beforeEach(() => {
    vi.stubEnv("OMB_ADB_PATH", process.execPath);
    vi.stubEnv("PH_ANDROID_SERIAL", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ["status", {}, [], "\"serial\": \"USB123\""],
    ["read_screen", {}, [DUMP], "0: \"Where to? · Destination\" bounds=12,100,400,180 class=android.widget.TextView"],
    ["screenshot", {}, [onPhone("exec-out", "screencap", "-p")], "Android screenshot from USB123"],
    ["list_apps", {}, [APPS], "com.ubercab"],
    ["open_app", { name: "Uber" }, [APPS, onPhone("shell", "monkey", "-p", "com.ubercab", "-c", "android.intent.category.LAUNCHER", "1")], "Opened Uber (com.ubercab)"],
    ["tap_text", { text: "Where to?" }, [DUMP, onPhone("shell", "input", "tap", "206", "140")], "Tapped \"Where to?\""],
    ["tap", { x: 10, y: 20 }, [onPhone("shell", "input", "tap", "10", "20")], "Tapped 10,20"],
    ["tap", { x: 540, y: 900, duration_ms: 1000 }, [onPhone("shell", "input", "swipe", "540", "900", "540", "900", "1000")], "Pressed 540,900 for 1000 ms"],
    ["tap", { x: 540, y: 900, duration_ms: null }, [onPhone("shell", "input", "tap", "540", "900")], "Tapped 540,900"],
    ["tap", { x: 10.4, y: 20.6 }, [onPhone("shell", "input", "tap", "10", "21")], "Tapped 10,21"],
    ["tap", { x: 540, y: 900, duration_ms: "" }, [onPhone("shell", "input", "tap", "540", "900")], "Tapped 540,900"],
    ["tap", { x: 540, y: 900, duration_ms: 50 }, [onPhone("shell", "input", "swipe", "540", "900", "540", "900", "50")], "Pressed 540,900 for 50 ms"],
    ["tap", { x: 540, y: 900, duration_ms: "999.6" }, [onPhone("shell", "input", "swipe", "540", "900", "540", "900", "1000")], "Pressed 540,900 for 1000 ms"],
    ["swipe", { direction: "up" }, [onPhone("shell", "wm", "size"), onPhone("shell", "input", "swipe", "540", "1440", "540", "480", "260")], "Swiped up"],
    ["swipe", { direction: "down", x: 300, y: 1430, distance: 375, duration_ms: 1500 }, [onPhone("shell", "wm", "size"), onPhone("shell", "input", "swipe", "300", "1430", "300", "1805", "1500")], "Swiped from 300,1430 to 300,1805 in 1500 ms"],
    ["swipe", { direction: "left", distance: 300 }, [onPhone("shell", "wm", "size"), onPhone("shell", "input", "swipe", "810", "960", "510", "960", "260")], "Swiped from 810,960 to 510,960 in 260 ms"],
    ["swipe", { direction: "up", x: "300" }, [onPhone("shell", "wm", "size"), onPhone("shell", "input", "swipe", "300", "1440", "300", "480", "260")], "Swiped from 300,1440 to 300,480 in 260 ms"],
    ["swipe", { direction: "up", x: "", y: null, distance: null, duration_ms: null }, [onPhone("shell", "wm", "size"), onPhone("shell", "input", "swipe", "540", "1440", "540", "480", "260")], "Swiped up"],
    ["swipe", { direction: "up", distance: 49.6 }, [onPhone("shell", "wm", "size"), onPhone("shell", "input", "swipe", "540", "1440", "540", "1390", "260")], "Swiped from 540,1440 to 540,1390 in 260 ms"],
    ["swipe", { direction: "down" }, [onPhone("shell", "wm", "size"), onPhone("shell", "input", "swipe", "540", "480", "540", "1440", "260")], "Swiped down"],
    ["swipe", { direction: "left" }, [onPhone("shell", "wm", "size"), onPhone("shell", "input", "swipe", "810", "960", "270", "960", "260")], "Swiped left"],
    ["swipe", { direction: "right" }, [onPhone("shell", "wm", "size"), onPhone("shell", "input", "swipe", "270", "960", "810", "960", "260")], "Swiped right"],
    ["swipe", { direction: "up", duration_ms: 2000.4 }, [onPhone("shell", "wm", "size"), onPhone("shell", "input", "swipe", "540", "1440", "540", "480", "2000")], "Swiped from 540,1440 to 540,480 in 2000 ms"],
    ["swipe", { direction: "up", y: 1000 }, [onPhone("shell", "wm", "size"), onPhone("shell", "input", "swipe", "540", "1000", "540", "40", "260")], "Swiped from 540,1000 to 540,40 in 260 ms"],
    ["swipe", { direction: "down", x: 0, y: 0 }, [onPhone("shell", "wm", "size"), onPhone("shell", "input", "swipe", "0", "0", "0", "960", "260")], "Swiped from 0,0 to 0,960 in 260 ms"],
    ["swipe", { direction: "right", x: 10000, y: 10000, distance: 10000 }, [onPhone("shell", "wm", "size"), onPhone("shell", "input", "swipe", "10000", "10000", "20000", "10000", "260")], "Swiped from 10000,10000 to 20000,10000 in 260 ms"],
    ["type_text", { text: "hi" }, [onPhone("shell", "input", "text", "hi")], "Typed text into the focused Android field"],
    ["press", { key: "home" }, [onPhone("shell", "input", "keyevent", "KEYCODE_HOME")], "Pressed home"],
  ])("%s sends its commands when every claim is granted", async (name, args, deviceCommands, text) => {
    const { commands, call, claims } = phone();
    const result = await call(name, args);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining(text) });
    expect(commands).toEqual([DEVICES, ...deviceCommands]);
    expect(claims()).toBe(1 + deviceCommands.length);
  });

  const SWIPE_FIELDS_ERROR = 'swipe needs x and y from 0 to 10000, distance from 50 to 10000 and duration_ms from 50 to 2000, e.g. {"direction":"up","x":300,"y":1400,"distance":400,"duration_ms":800}';
  const TAP_HOLD_ERROR = 'tap needs duration_ms from 50 to 2000, e.g. {"x":540,"y":900,"duration_ms":1000}';
  it.each([
    ...[{ distance: 0 }, { distance: 49 }, { distance: -5 }, { distance: 10001 }, { distance: "abc" }, { duration_ms: 0 }, { duration_ms: 0.4 }, { duration_ms: 49 }, { duration_ms: 2001 }, { x: -1 }, { y: 10001 }, { x: 10001 }, { y: -1 }, { distance: 49.4 }, { x: true }]
      .map((field): [string, Record<string, unknown>, string] => ["swipe", { direction: "up", ...field }, SWIPE_FIELDS_ERROR]),
    ...[0, 49, 2001].map((duration_ms): [string, Record<string, unknown>, string] => ["tap", { x: 540, y: 900, duration_ms }, TAP_HOLD_ERROR]),
  ])("%s refuses %j and sends nothing to the phone", async (name, args, error) => {
    const { commands, call } = phone();
    expect(await call(name, args)).toEqual({ content: [{ type: "text", text: error }], isError: true });
    expect(commands).toEqual([DEVICES]);
  });

  it.each(["sideways", "constructor", "__proto__", "toString"])("swipe refuses the direction %j once it has read the screen size, and swipes nothing", async (direction) => {
    const { commands, call } = phone();
    expect(await call("swipe", { direction })).toEqual({ content: [{ type: "text", text: "Invalid swipe direction" }], isError: true });
    expect(commands).toEqual([DEVICES, onPhone("shell", "wm", "size")]);
  });

  it("only a call's first claim may wait for a person: each one before a command says it comes from the middle of the call", async () => {
    const { call, midCall } = phone();
    await call("tap_text", { text: "Where to?" });
    expect(midCall).toEqual([false, true, true]);
  });

  it.each(["status", "tap"])("%s runs no adb command when the call is refused at its start", async (name) => {
    const { commands, call } = phone(REFUSED);
    expect(await call(name, { x: 10, y: 20 })).toEqual({ content: [{ type: "text", text: PERSON_TEXT }], isError: true });
    expect(commands).toEqual([]);
  });

  it.each(["screenshot", "read_screen"])("%s sends nothing to the phone when a person takes it during the device list", async (name) => {
    const { commands, call } = phone(undefined, REFUSED);
    expect(await call(name)).toEqual({ content: [{ type: "text", text: PERSON_TEXT }], isError: true });
    expect(commands).toEqual([DEVICES]);
  });

  it("tap_text does not tap when a person takes the phone during its screen read", async () => {
    const { commands, call } = phone(undefined, undefined, REFUSED);
    expect(await call("tap_text", { text: "Where to?" })).toEqual({ content: [{ type: "text", text: PERSON_TEXT }], isError: true });
    expect(commands).toEqual([DEVICES, DUMP]);
  });

  const TAP = onPhone("shell", "input", "tap", "10", "20");
  const TAP_STEP = { action: "tap", x: 10, y: 20 };
  const TAP_TEXT_STEP = { action: "tap_text", text: "Where to?" };

  it("a batch claims before each command of a step and again before each later step, and only its first claim may wait for a person", async () => {
    const { commands, call, midCall } = phone();
    expect(await call("batch", { steps: [TAP_STEP, TAP_TEXT_STEP] })).toEqual({ content: [{ type: "text", text: '1. tap: Tapped 10,20\n2. tap_text: Tapped "Where to?"' }] });
    expect(commands).toEqual([DEVICES, TAP, DUMP, onPhone("shell", "input", "tap", "206", "140")]);
    expect(midCall).toEqual([false, true, true, true, true]);
  });

  it("a batch step swipes by the distance it gives", async () => {
    const { commands, call } = phone();
    expect(await call("batch", { steps: [{ action: "swipe", direction: "up", distance: "400" }, { action: "read_screen" }] })).toEqual({ content: [{ type: "text", text: '1. swipe: Swiped from 540,1440 to 540,1040 in 260 ms\n2. read_screen:\n0: "Where to? · Destination" bounds=12,100,400,180 class=android.widget.TextView' }] });
    expect(commands).toEqual([DEVICES, onPhone("shell", "wm", "size"), onPhone("shell", "input", "swipe", "540", "1440", "540", "1040", "260"), DUMP]);
  });

  it("swipe sends whole numbers for a screen whose width and height are odd", async () => {
    const commands: string[][] = [];
    const adb = async (args: string[]) => {
      commands.push(args);
      const line = args.join(" ");
      return Buffer.from(line.includes("devices -l") ? DEVICE_LIST : line.includes("wm size") ? "Physical size: 1081x1921\n" : "");
    };
    await callPhoneTool("swipe", { direction: "up" }, async () => ({ ok: true }), adb);
    expect(commands).toEqual([DEVICES, onPhone("shell", "wm", "size"), onPhone("shell", "input", "swipe", "541", "1441", "541", "480", "260")]);
  });

  it("a held tap answers with the point and the time it was pressed, and nothing more", async () => {
    const { call } = phone();
    expect(await call("tap", { x: 540, y: 900, duration_ms: 1000 })).toEqual({ content: [{ type: "text", text: "Pressed 540,900 for 1000 ms" }] });
  });

  it.each([
    { n: 1, steps: [TAP_TEXT_STEP], refusals: [undefined, undefined, REFUSED], done: "", isError: true, sent: [DEVICES, DUMP] },
    { n: 2, steps: [TAP_STEP, TAP_TEXT_STEP], refusals: [undefined, undefined, undefined, undefined, REFUSED], done: "1. tap: Tapped 10,20\n", sent: [DEVICES, TAP, DUMP] },
  ])("a batch reports a person taking the phone between two commands of step $n as that step failing, an error only at step 1", async ({ n, steps, refusals, done, isError, sent }) => {
    const { commands, call } = phone(...refusals);
    const said = "A person has taken control of the phone. Do not act until they hand it back. To wait, call read_screen: each phone call waits up to 45 seconds and returns as soon as they hand the phone back. Meanwhile you may work on anything that does not need the phone";
    expect(await call("batch", { steps })).toEqual({ content: [{ type: "text", text: `${done}Step ${n} failed: ${said}. Its effect is unknown; call read_screen or screenshot before trying it again. ${EARLIER_AND_LATER}` }], isError });
    expect(commands).toEqual(sent);
  });

  it("screenshot asks adb for the screen capture as binary output", async () => {
    const { commands, options, call } = phone();
    await call("screenshot");
    expect(commands[1]).toEqual(onPhone("exec-out", "screencap", "-p"));
    expect(options[1]).toEqual({ binary: true });
  });

  it("read_screen has the phone save a dump to a file, print it and remove it in one command, under one claim", async () => {
    const { commands, adb } = adbOfPhoneThatSavesItsDump();
    let claims = 0;
    const result = await callPhoneTool("read_screen", {}, async () => { claims += 1; return { ok: true }; }, adb);
    expect(result).toEqual({ content: [{ type: "text", text: "0: \"Where to? · Destination\" bounds=12,100,400,180 class=android.widget.TextView" }] });
    expect(commands).toEqual([DEVICES, DUMP, SAVE_READ_AND_REMOVE]);
    expect(namingTheSavedDumpWithoutRemovingIt(commands)).toEqual([]);
    expect(claims).toBe(3);
  });

  it("read_screen sends no command that leaves the saved dump on the phone when a person takes it during the read", async () => {
    let taken = false;
    const { commands, adb, left } = adbOfPhoneThatSavesItsDump({
      duringRead: () => {
        taken = true;
      },
    });
    await callPhoneTool("read_screen", {}, async () => (taken ? REFUSED : { ok: true }), adb);
    expect(commands.filter((command) => command.join(" ").includes(SAVED_DUMP))).toHaveLength(1);
    expect(namingTheSavedDumpWithoutRemovingIt(commands)).toEqual([]);
    expect(left()).toBeUndefined();
  });

  const NO_DUMP = { exit: 0 };
  const PART_OF_A_DUMP = { writes: SCREEN_XML.slice(0, SCREEN_XML.indexOf("</hierarchy>")), exit: 1 };
  it.each([
    ["read_screen", "writes no dump, though it exits 0", NO_DUMP],
    ["tap_text", "writes no dump, though it exits 0", NO_DUMP],
    ["read_screen", "exits 1 after writing part of a dump", PART_OF_A_DUMP],
    ["tap_text", "exits 1 after writing part of a dump", PART_OF_A_DUMP],
  ])("%s fails, taps nothing and leaves no file when the phone %s, with an older saved dump still there", async (name, _what, dump) => {
    const older = SCREEN_XML.replace("[12,100][400,180]", "[12,900][400,980]");
    const { commands, adb, left } = adbOfPhoneThatSavesItsDump({ saved: older, dump });
    const result = await callPhoneTool(name, { text: "Where to?" }, async () => ({ ok: true }), adb);
    expect(result.isError).toBe(true);
    expect(commands.filter((command) => command.includes("input"))).toEqual([]);
    expect(left()).toBeUndefined();
  });

  it("tap_text does not tap when a person takes the phone and hands it back while the saved dump is read", async () => {
    const resources = new TurnResources();
    const hold = createPhoneHold({ onChange: (held) => gate.holdChanged(held) });
    const gate = createPhoneGate({ enabled: () => true, hold, resources, claim: (owner, resource) => resources.claim(resource, owner) });
    const turn = { threadId: "a", generation: "1" };
    const harness = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = new Request(input, init);
      let answer = new Response(null, { status: 404 });
      await gate.internal({
        method: request.method, path: new URL(request.url).pathname, res: {} as never, turn, signal: request.signal,
        json: (_res, status, body) => { answer = new Response(JSON.stringify(body), { status }); },
        requireActive: () => {},
        readBody: () => request.json(),
      });
      return answer;
    }) as typeof fetch;
    const { commands, adb } = adbOfPhoneThatSavesItsDump({
      duringRead: () => {
        hold.take();
        hold.release();
      },
    });

    const result = await callPhoneTool("tap_text", { text: "Where to?" }, createPhoneClaim({ OMB_HARNESS_URL: "http://127.0.0.1:8799", OMB_PHONE_TOKEN: "tok" }, harness), adb);

    expect(result).toEqual({ content: [{ type: "text", text: HANDED_BACK_TEXT }], isError: true });
    expect(commands.filter((command) => command.includes("input"))).toEqual([]);
    hold.stop();
  });

  const KEYBOARD = onPhone("shell", "settings", "get", "secure", "default_input_method");
  const KEYBOARDS = onPhone("shell", "ime", "list", "-s");
  const SWITCH = onPhone("shell", "ime", "set", "com.android.adbkeyboard/.AdbIME");
  const INPUT_STATE = onPhone("shell", "dumpsys", "input_method");
  const RESTORE = onPhone("shell", "ime", "set", "com.baidu.input_huawei/.ImeService");
  const OTHER_TEXT = { text: "二手" };

  /** adb for a phone whose default keyboard is Baidu's and is up, with ADBKeyBoard switched on in its keyboard list and showing as soon as it is set.
   * `during` runs while adb runs each command. */
  function adbOfPhoneWithAnotherKeyboard(during: (command: string) => void) {
    const commands: string[][] = [];
    let switched = false;
    const adb = async (args: string[]) => {
      commands.push(args);
      const line = args.join(" ");
      during(line);
      switched ||= line === SWITCH.join(" ");
      if (line.includes("devices -l")) return Buffer.from(DEVICE_LIST);
      if (line.includes("default_input_method")) return Buffer.from("com.baidu.input_huawei/.ImeService\n");
      if (line.includes("ime list -s")) return Buffer.from("com.baidu.input_huawei/.ImeService\ncom.android.adbkeyboard/.AdbIME\n");
      if (!line.includes("dumpsys input_method")) return Buffer.from("");
      return Buffer.from(switched ? SWITCHED_AND_SHOWN : BEFORE_THE_SWITCH);
    };
    return { commands, adb };
  }

  const ONLY_THE_RESTORE = "only the command that puts the person's keyboard back";
  const STEP_REFUSED = `Step 1 failed: A person has taken control of the phone. Do not act until they hand it back. To wait, call read_screen: each phone call waits up to 45 seconds and returns as soon as they hand the phone back. Meanwhile you may work on anything that does not need the phone. Its effect is unknown; call read_screen or screenshot before trying it again. ${EARLIER_AND_LATER}`;
  it.each([
    ["type_text", "nothing more", "the device list", OTHER_TEXT, DEVICES, 1, [DEVICES], PERSON_TEXT, 2],
    ["type_text", "nothing more", "its read of the default keyboard", OTHER_TEXT, KEYBOARD, 1, [DEVICES, KEYBOARD], PERSON_TEXT, 3],
    ["type_text", "nothing more", "its read of the keyboard list", OTHER_TEXT, KEYBOARDS, 1, [DEVICES, KEYBOARD, KEYBOARDS], PERSON_TEXT, 4],
    ["type_text", ONLY_THE_RESTORE, "the read that finds a keyboard up", OTHER_TEXT, INPUT_STATE, 1, [DEVICES, KEYBOARD, KEYBOARDS, INPUT_STATE, RESTORE], PERSON_TEXT, 5],
    ["type_text", ONLY_THE_RESTORE, "the switch to ADBKeyBoard", OTHER_TEXT, SWITCH, 1, [DEVICES, KEYBOARD, KEYBOARDS, INPUT_STATE, SWITCH, RESTORE], PERSON_TEXT, 6],
    ["type_text", ONLY_THE_RESTORE, "the read that finds ADBKeyBoard shown", OTHER_TEXT, INPUT_STATE, 2, [DEVICES, KEYBOARD, KEYBOARDS, INPUT_STATE, SWITCH, INPUT_STATE, RESTORE], PERSON_TEXT, 7],
    ["batch", ONLY_THE_RESTORE, "the read that finds ADBKeyBoard shown", { steps: [{ action: "type_text", ...OTHER_TEXT }] }, INPUT_STATE, 2, [DEVICES, KEYBOARD, KEYBOARDS, INPUT_STATE, SWITCH, INPUT_STATE, RESTORE], STEP_REFUSED, 7],
  ])("%s sends %s once a person takes the phone during %s", async (name, _more, _moment, args, during, nth, sent, says, claims) => {
    let taken = false;
    let asked = 0;
    let seen = 0;
    const { commands, adb } = adbOfPhoneWithAnotherKeyboard((command) => {
      if (command === during.join(" ") && ++seen === nth) taken = true;
    });
    const result = await callPhoneTool(name, args, async () => {
      asked += 1;
      return taken ? REFUSED : { ok: true };
    }, adb);
    expect(result).toEqual({ content: [{ type: "text", text: says }], isError: true });
    expect(commands).toEqual(sent);
    expect(asked).toBe(claims);
  });

  it("type_text sends no broadcast once a person takes the phone during its read of the default keyboard, when that is ADBKeyBoard", async () => {
    let taken = false;
    const commands: string[][] = [];
    const adb = async (args: string[]) => {
      commands.push(args);
      const line = args.join(" ");
      if (line.includes("devices -l")) return Buffer.from(DEVICE_LIST);
      if (!line.includes("default_input_method")) return Buffer.from("");
      taken = true;
      return Buffer.from("com.android.adbkeyboard/.AdbIME\n");
    };
    const result = await callPhoneTool("type_text", OTHER_TEXT, async () => (taken ? REFUSED : { ok: true }), adb);
    expect(result).toEqual({ content: [{ type: "text", text: PERSON_TEXT }], isError: true });
    expect(commands).toEqual([DEVICES, KEYBOARD]);
  });

  it("type_text says the phone is still on ADBKeyBoard when adb fails from the switch to ADBKeyBoard on", async () => {
    let closed = false;
    const { commands, adb } = adbOfPhoneWithAnotherKeyboard((command) => {
      closed ||= command === SWITCH.join(" ");
      if (closed) throw new Error("error: closed");
    });
    const result = await callPhoneTool("type_text", OTHER_TEXT, async () => ({ ok: true }), adb);
    expect(result).toEqual({ content: [{ type: "text", text: "The phone is still on ADBKeyBoard, which shows no keys. Tell the person to choose their keyboard again in the phone's settings, and call read_screen to see whether the text arrived." }], isError: true });
    expect(commands).toEqual([DEVICES, KEYBOARD, KEYBOARDS, INPUT_STATE, SWITCH, RESTORE]);
  });

  it("type_text says the phone is still on ADBKeyBoard when the command that puts the person's keyboard back fails", async () => {
    const { commands, adb } = adbOfPhoneWithAnotherKeyboard((command) => {
      if (command === RESTORE.join(" ")) throw new Error("error: closed");
    });
    const result = await callPhoneTool("type_text", OTHER_TEXT, async () => ({ ok: true }), adb);
    expect(result).toEqual({ content: [{ type: "text", text: "The phone is still on ADBKeyBoard, which shows no keys. Tell the person to choose their keyboard again in the phone's settings, and call read_screen to see whether the text arrived." }], isError: true });
    expect(commands).toEqual([DEVICES, KEYBOARD, KEYBOARDS, INPUT_STATE, SWITCH, INPUT_STATE, onPhone("shell", "am", "broadcast", "-a", "ADB_INPUT_B64", "-p", "com.android.adbkeyboard", "--es", "msg", "5LqM5omL"), RESTORE]);
  });
});
