import { describe, expect, it } from "vitest";

import { TOOLS, createPhoneClaim, findPackages, launchTarget, parseDevices, parseLaunchablePackages, parseUiNodes, typePhoneText } from "./phone-proxy.ts";

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
  const device = (keyboard: string) => {
    const commands: string[][] = [];
    const shell = async (...command: string[]) => {
      commands.push(command);
      return command[0] === "settings" ? `${keyboard}\n` : "";
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
    await expect(typePhoneText(phone.shell, "二手 iPad")).rejects.toThrow("ADBKeyBoard (https://github.com/senzhk/ADBKeyBoard) is installed and chosen as the phone's keyboard");
    expect(phone.commands).toEqual([["settings", "get", "secure", "default_input_method"]]);
  });

  const CLEAR = ["am", "broadcast", "-a", "ADB_CLEAR_TEXT", "-p", "com.android.adbkeyboard"];

  it.each([["二手 iPad", "5LqM5omLIGlQYWQ="], ["iPad mini_6", "aVBhZCBtaW5pXzY="]])("clears the field through ADBKeyBoard, then sends the text the same way (%s)", async (text, base64) => {
    const phone = device(ADB_KEYBOARD);
    await expect(typePhoneText(phone.shell, text, true)).resolves.toBe("Asked ADBKeyBoard to clear the field and sent the text. Use read_screen to check that the field holds only this text.");
    expect(phone.commands).toEqual([
      ["settings", "get", "secure", "default_input_method"],
      CLEAR,
      ["am", "broadcast", "-a", "ADB_INPUT_B64", "-p", "com.android.adbkeyboard", "--es", "msg", base64],
    ]);
  });

  it.each(["二手 iPad", "iPad"])("asks for ADBKeyBoard and changes nothing when another keyboard cannot clear (%s)", async (text) => {
    const phone = device(VENDOR_KEYBOARD);
    await expect(typePhoneText(phone.shell, text, true)).rejects.toThrow("A field can be cleared only when ADBKeyBoard (https://github.com/senzhk/ADBKeyBoard) is installed and chosen as the phone's keyboard");
    expect(phone.commands).toEqual([["settings", "get", "secure", "default_input_method"]]);
  });

  it("sends no text after a clear that failed", async () => {
    const commands: string[][] = [];
    const shell = async (...command: string[]) => {
      commands.push(command);
      if (command[0] === "settings") return `${ADB_KEYBOARD}\n`;
      throw new Error("error: closed");
    };
    await expect(typePhoneText(shell, "二手", true)).rejects.toThrow("error: closed");
    expect(commands).toEqual([["settings", "get", "secure", "default_input_method"], CLEAR]);
  });

  it("offers clear as a plain boolean beside the text", () => {
    expect(TOOLS.find((tool) => tool.name === "type_text")?.inputSchema.properties).toMatchObject({ clear: { type: "boolean" } });
  });

  it.each(["", "a".repeat(257), "😀".repeat(257)])("refuses empty or over-long text without touching the phone", async (text) => {
    const phone = device(ADB_KEYBOARD);
    await expect(typePhoneText(phone.shell, text)).rejects.toThrow("Android text must be 1 to 256 characters");
    expect(phone.commands).toEqual([]);
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
