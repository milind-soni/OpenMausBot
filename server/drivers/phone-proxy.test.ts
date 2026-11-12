import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPhoneHold } from "../phone-screen/hold.ts";
import { createPhoneGate } from "../routes/phone-gate.ts";
import { TurnResources } from "../turn-resources.ts";
import { TOOLS, callPhoneTool, createPhoneClaim, findPackages, launchTarget, parseDevices, parseLaunchablePackages, parseUiNodes, typePhoneText } from "./phone-proxy.ts";

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
  const device = (keyboard: string, inputState = FIELD) => {
    const commands: string[][] = [];
    const shell = async (...command: string[]) => {
      commands.push(command);
      return command[0] === "settings" ? `${keyboard}\n` : command[0] === "dumpsys" ? inputState : "";
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

  it("asks for ADBKeyBoard and types nothing when another keyboard is chosen", async () => {
    const phone = device(VENDOR_KEYBOARD);
    await expect(typePhoneText(phone.shell, "二手 iPad")).rejects.toThrow("Only letters, digits, spaces and _.,@- can be typed until ADBKeyBoard (https://github.com/senzhk/ADBKeyBoard) is installed and chosen as the phone's keyboard");
    expect(phone.commands).toEqual([["settings", "get", "secure", "default_input_method"]]);
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

  it.each(["二手 iPad", "iPad"])("asks for ADBKeyBoard and changes nothing when another keyboard cannot clear (%s)", async (text) => {
    const phone = device(VENDOR_KEYBOARD);
    const refused = typePhoneText(phone.shell, text, true);
    await expect(refused).rejects.toThrow("A field can be cleared only when ADBKeyBoard (https://github.com/senzhk/ADBKeyBoard) is installed and chosen as the phone's keyboard");
    await expect(refused).rejects.toThrow("call type_text without clear and remove the old text with press delete");
    expect(phone.commands).toEqual([["settings", "get", "secure", "default_input_method"]]);
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
    ["swipe", { direction: "up" }, [onPhone("shell", "wm", "size"), onPhone("shell", "input", "swipe", "540", "1440", "540", "480", "260")], "Swiped up"],
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
});
